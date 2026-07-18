const assert = require('node:assert/strict')
const http = require('node:http')
const test = require('node:test')

const localDefaultAlertSound = process.env.DEFAULT_ALERT_SOUND
process.env.DEFAULT_ALERT_SOUND = ''
const { attachAppRequestHandler, createApp, createSocketServer } = require('../app')
if (localDefaultAlertSound !== undefined) process.env.DEFAULT_ALERT_SOUND = localDefaultAlertSound
else delete process.env.DEFAULT_ALERT_SOUND

const { createActionQueue } = require('../modules/action-queue')
const { createActionRunner } = require('../modules/actions')

function createFakeServices() {
  const enqueued = []
  const queueSnapshot = {
    activity: [],
    history: [],
    paused: false,
    pending: [],
    running: null
  }

  return {
    enqueued,
    services: {
      actions: {
        async run() {
          return []
        }
      },
      actionQueue: {
        enqueue(item) {
          enqueued.push(item)
          return queueSnapshot
        },
        getStatus() {
          return queueSnapshot
        }
      },
      chat: {
        getStatus() {
          return {}
        },
        async simulateEvent() {}
      },
      greetings: {
        getStatus() {
          return {}
        },
        setActivePool() {
          return {}
        }
      },
      io: {
        engine: { clientsCount: 0 },
        emit() {}
      },
      lowerThirdSync: {
        getStatus() {
          return {}
        },
        hide() {
          return {}
        },
        show() {
          return {}
        },
        toggle() {
          return {}
        }
      },
      macros: {
        find() {
          return null
        },
        list() {
          return []
        }
      },
      obs: {
        async getDiscovery() {
          return {}
        },
        getStatus() {
          return {}
        }
      },
      quietMode: {
        disable() {
          return {}
        },
        enable() {
          return {}
        },
        getStatus() {
          return {}
        },
        toggle() {
          return {}
        }
      },
      raffle: {
        close() {
          return {}
        },
        disable() {
          return {}
        },
        enable() {
          return {}
        },
        getStatus() {
          return {}
        },
        start() {
          return {}
        },
        toggle() {
          return {}
        }
      }
    }
  }
}

function createRealQueueServices() {
  const emitted = []
  const io = {
    engine: { clientsCount: 0 },
    emit(event, payload) {
      emitted.push({ event, payload })
    }
  }
  const quietMode = {
    disable() {
      return {}
    },
    enable() {
      return {}
    },
    getStatus() {
      return {}
    },
    isEnabled() {
      return false
    },
    toggle() {
      return {}
    }
  }
  const lowerThirdSync = {
    emitOverlayEvent(event, payload) {
      io.emit(event, payload)
    },
    getStatus() {
      return {}
    },
    hide() {
      return {}
    },
    show() {
      return {}
    },
    toggle() {
      return {}
    }
  }
  const actions = createActionRunner({
    io,
    logger: { error() {}, log() {}, warn() {} },
    obs: {},
    quietMode,
    overlayEmit: lowerThirdSync.emitOverlayEvent
  })
  const actionQueue = createActionQueue({
    actions,
    soundCompletionBufferMs: 0,
    soundCompletionFallbackMs: 0
  })

  return {
    emitted,
    services: {
      actions,
      actionQueue,
      chat: {
        getStatus() {
          return {}
        },
        async simulateEvent() {}
      },
      greetings: {
        getStatus() {
          return {}
        },
        setActivePool() {
          return {}
        }
      },
      io,
      lowerThirdSync,
      macros: {
        find() {
          return null
        },
        list() {
          return []
        }
      },
      obs: {
        async getDiscovery() {
          return {}
        },
        getStatus() {
          return {}
        }
      },
      quietMode,
      raffle: {
        close() {
          return {}
        },
        disable() {
          return {}
        },
        enable() {
          return {}
        },
        getStatus() {
          return {}
        },
        start() {
          return {}
        },
        toggle() {
          return {}
        }
      }
    }
  }
}

async function withTestServer(app, fn) {
  const server = http.createServer(app)

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  try {
    const { port } = server.address()
    return await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

async function withSocketTestServer(fn) {
  const server = http.createServer()
  const io = createSocketServer(server)
  const { services } = createFakeServices()
  const app = createApp({ ...services, io })
  attachAppRequestHandler(server, app)

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  try {
    const { port } = server.address()
    return await fn(`http://127.0.0.1:${port}`)
  } finally {
    io.close()
    await new Promise(resolve => server.close(resolve))
  }
}

async function postJson(baseUrl, endpoint, body) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST'
  })
  const payload = await response.json()
  return { payload, response }
}

async function waitForQueueHistory(actionQueue, predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const match = actionQueue.getStatus().history.find(predicate)
    if (match) return match
    await new Promise(resolve => setTimeout(resolve, 10))
  }

  assert.fail('Timed out waiting for queue history')
}

test('/api/v1/sound rejects missing files before enqueueing', async () => {
  const { enqueued, services } = createFakeServices()
  const app = createApp(services)

  await withTestServer(app, async baseUrl => {
    const { payload, response } = await postJson(baseUrl, '/api/v1/sound', { src: 'missing.wav' })

    assert.equal(response.status, 400)
    assert.match(payload.error, /file was not found/)
    assert.equal(enqueued.length, 0)
  })
})

test('/api/v1/sound enqueues existing sound files', async () => {
  const { enqueued, services } = createFakeServices()
  const app = createApp(services)

  await withTestServer(app, async baseUrl => {
    const { payload, response } = await postJson(baseUrl, '/api/v1/sound', { src: 'example.mp3' })

    assert.equal(response.status, 200)
    assert.equal(payload.ok, true)
    assert.equal(payload.queued, true)
    assert.equal(enqueued.length, 1)
    assert.equal(enqueued[0].actions[0].type, 'sound.play')
    assert.equal(enqueued[0].actions[0].src, 'example.mp3')
  })
})

test('/api/v1/test runs the tracked default alert sound', async () => {
  const { emitted, services } = createRealQueueServices()
  const app = createApp(services)

  await withTestServer(app, async baseUrl => {
    const { payload, response } = await postJson(baseUrl, '/api/v1/test', { completionDelayMs: 0 })

    assert.equal(response.status, 200)
    assert.equal(payload.ok, true)
    assert.equal(payload.queued, true)

    const historyItem = await waitForQueueHistory(
      services.actionQueue,
      item => item.name === 'Test Alert'
    )
    assert.equal(historyItem.status, 'completed')
    assert.deepEqual(
      emitted.find(item => item.event === 'sound-play'),
      { event: 'sound-play', payload: { src: 'example.mp3', volume: 1 } }
    )
  })
})

test('Socket.IO polling requests are not handled by Express routes', async () => {
  await withSocketTestServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&t=smoke`)
    const body = await response.text()

    assert.equal(response.status, 200)
    assert.match(body, /^0/)
  })
})
