const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  createChatService,
  getConfiguredEventSubHandlerGroups,
  getUnsubscribedEventSubHandlerGroups,
  isNonRetryableStartupError,
  readTokenConfig,
  TokenConfigError
} = require('../modules/chat')

function withTempDirectory(fn) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vipos-chat-'))
  const cleanup = () => fs.rmSync(directory, { recursive: true, force: true })

  try {
    const result = fn(directory)
    if (result && typeof result.then === 'function') {
      return result.finally(cleanup)
    }
    cleanup()
    return result
  } catch (error) {
    cleanup()
    throw error
  }
}

function withEnv(overrides, fn) {
  const previousValues = new Map()
  for (const key of Object.keys(overrides)) {
    previousValues.set(key, process.env[key])
    if (overrides[key] === undefined) delete process.env[key]
    else process.env[key] = overrides[key]
  }

  const restore = () => {
    for (const [key, value] of previousValues.entries()) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  try {
    const result = fn()
    if (result && typeof result.then === 'function') {
      return result.finally(restore)
    }
    restore()
    return result
  } catch (error) {
    restore()
    throw error
  }
}

test('configured EventSub handler groups match restart-warning group names', () => {
  const groups = getConfiguredEventSubHandlerGroups({
    automaticRedemptionHandlerCount: 1,
    followHandlerCount: 1,
    raidHandlerCount: 1,
    redemptionHandlerCount: 1,
    redemptionUpdateHandlerCount: 1,
    rewardAddEventHandlerCount: 1,
    rewardRemoveEventHandlerCount: 1,
    rewardUpdateEventHandlerCount: 1,
    subscriptionHandlerCount: 1
  })

  assert.deepEqual([...groups], [
    'follows',
    'raids',
    'subscriptions',
    'redemptions',
    'redemption updates',
    'automatic redemptions',
    'reward add events',
    'reward update events',
    'reward remove events'
  ])
})

test('EventSub restart comparison reports only newly configured groups', () => {
  const configuredGroups = getConfiguredEventSubHandlerGroups({
    followHandlerCount: 1,
    raidHandlerCount: 1,
    rewardUpdateEventHandlerCount: 1
  })
  const subscribedGroups = new Set(['follows'])

  assert.deepEqual(
    getUnsubscribedEventSubHandlerGroups(configuredGroups, subscribedGroups),
    ['raids', 'reward update events']
  )
})

test('malformed Twitch token files are non-retryable startup errors', () => {
  withTempDirectory(directory => {
    const tokenFile = path.join(directory, 'twitch-token.json')
    fs.writeFileSync(tokenFile, '{not json')

    assert.throws(
      () => readTokenConfig(tokenFile),
      error => (
        error instanceof TokenConfigError &&
        isNonRetryableStartupError(error) &&
        /Failed to load Twitch token file/.test(error.message)
      )
    )
  })
})

test('non-object Twitch token files are non-retryable startup errors', () => {
  withTempDirectory(directory => {
    const tokenFile = path.join(directory, 'twitch-token.json')
    fs.writeFileSync(tokenFile, '[]')

    assert.throws(
      () => readTokenConfig(tokenFile),
      error => (
        error instanceof TokenConfigError &&
        isNonRetryableStartupError(error) &&
        /token file must contain a JSON object/.test(error.message)
      )
    )
  })
})

test('Twitch token file read failures remain retryable startup errors', () => {
  withTempDirectory(directory => {
    const tokenFile = path.join(directory, 'twitch-token.json')
    const originalReadFileSync = fs.readFileSync
    fs.writeFileSync(tokenFile, '{}')

    fs.readFileSync = function readFileSyncWithFailure(filePath, ...args) {
      if (path.resolve(filePath) === path.resolve(tokenFile)) {
        const error = new Error('temporary read failure')
        error.code = 'EAGAIN'
        throw error
      }
      return originalReadFileSync.call(this, filePath, ...args)
    }

    try {
      assert.throws(
        () => readTokenConfig(tokenFile),
        error => (
          error.code === 'EAGAIN' &&
          !isNonRetryableStartupError(error)
        )
      )
    } finally {
      fs.readFileSync = originalReadFileSync
    }
  })
})

test('ordinary startup errors remain retryable', () => {
  assert.equal(isNonRetryableStartupError(new Error('transient failure')), false)
  assert.equal(isNonRetryableStartupError({ nonRetryable: true }), false)
})

test('chat startup does not schedule retry for malformed Twitch token files', async () => {
  await withTempDirectory(async directory => {
    const tokenFile = path.join(directory, 'twitch-token.json')
    const commandsFile = path.join(directory, 'commands.json')
    fs.writeFileSync(tokenFile, '{not json')
    fs.writeFileSync(commandsFile, '{"commands":[]}')

    await withEnv({
      CHAT_COMMANDS_FILE: commandsFile,
      CHAT_ENABLED: 'true',
      CHAT_RECONNECT_INITIAL_MS: '1',
      TWITCH_BOT_ACCESS_TOKEN: undefined,
      TWITCH_BOT_REFRESH_TOKEN: undefined,
      TWITCH_CLIENT_ID: 'test-client-id',
      TWITCH_TOKEN_FILE: tokenFile
    }, async () => {
      const errors = []
      const chat = createChatService({
        actions: {},
        logger: {
          error(message) {
            errors.push(message)
          },
          log() {},
          warn() {}
        }
      })

      await chat.start()
      const status = chat.getStatus()

      assert.equal(status.nextRetryAt, null)
      assert.match(status.lastError, /Failed to load Twitch token file/)
      assert.equal(errors.length, 1)
    })
  })
})
