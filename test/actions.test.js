const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { createActionRunner, listSoundFiles } = require('../modules/actions')

function createNoopActionRunner() {
  return createActionRunner({
    io: { emit() {} },
    logger: { error() {}, log() {}, warn() {} },
    obs: {}
  })
}

function createTinyWav(filePath) {
  const buffer = Buffer.alloc(44)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(8000, 24)
  buffer.writeUInt32LE(8000, 28)
  buffer.writeUInt16LE(1, 32)
  buffer.writeUInt16LE(8, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(0, 40)
  fs.writeFileSync(filePath, buffer)
}

function withTempSoundDirectory(fn) {
  const soundDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vipos-sounds-'))
  const cleanup = () => fs.rmSync(soundDirectory, { recursive: true, force: true })

  try {
    const result = fn(soundDirectory)
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

test('delay actions reject non-finite values', async () => {
  const actions = createNoopActionRunner()

  await assert.rejects(
    () => actions.run({ type: 'delay', ms: 'Infinity' }),
    error => error.statusCode === 400 && /finite millisecond/.test(error.message)
  )
})

test('delay actions cap positive waits at ten minutes', async () => {
  let waitedMs = null
  const actions = createActionRunner({
    io: { emit() {} },
    logger: { error() {}, log() {}, warn() {} },
    obs: {},
    waitForDelay(ms) {
      waitedMs = ms
      return Promise.resolve()
    }
  })

  const result = await actions.run({ type: 'delay', ms: 999999999 })

  assert.equal(waitedMs, 600000)
  assert.equal(result[0].ms, 600000)
})

test('sound listing reuses cached results and returns cloned entries', () => {
  withTempSoundDirectory(soundDirectory => {
    createTinyWav(path.join(soundDirectory, 'alert.wav'))

    const first = listSoundFiles({ soundDirectory })
    assert.equal(first.length, 1)
    assert.equal(first[0].src, 'alert.wav')

    fs.unlinkSync(path.join(soundDirectory, 'alert.wav'))
    first[0].src = 'mutated.wav'

    const second = listSoundFiles({ soundDirectory })
    assert.equal(second.length, 1)
    assert.equal(second[0].src, 'alert.wav')
  })
})

test('sound playback reuses cached duration for unchanged files', async () => {
  await withTempSoundDirectory(async soundDirectory => {
    const soundPath = path.join(soundDirectory, 'alert.wav')
    const originalReadFileSync = fs.readFileSync
    let durationReadCount = 0

    createTinyWav(soundPath)

    fs.readFileSync = function readFileSyncWithCount(filePath, ...args) {
      if (path.resolve(filePath) === path.resolve(soundPath)) {
        durationReadCount += 1
      }
      return originalReadFileSync.call(this, filePath, ...args)
    }

    try {
      const actions = createActionRunner({
        io: { emit() {} },
        logger: { error() {}, log() {}, warn() {} },
        obs: {},
        soundDirectory
      })

      await actions.run({ type: 'sound.play', src: 'alert.wav' })
      await actions.run({ type: 'sound.play', src: 'alert.wav' })
    } finally {
      fs.readFileSync = originalReadFileSync
    }

    assert.equal(durationReadCount, 1)
  })
})

test('sound playback warns once for unchanged files above the warning threshold', async () => {
  await withTempSoundDirectory(async soundDirectory => {
    const warnings = []
    createTinyWav(path.join(soundDirectory, 'alert.wav'))

    const actions = createActionRunner({
      io: { emit() {} },
      largeSoundWarningBytes: 1,
      logger: {
        error() {},
        log() {},
        warn(message) {
          warnings.push(message)
        }
      },
      obs: {},
      soundDirectory
    })

    await actions.run({ type: 'sound.play', src: 'alert.wav' })
    await actions.run({ type: 'sound.play', src: 'alert.wav' })

    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /Sound file alert\.wav is 44 B/)
  })
})
