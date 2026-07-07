// Load environment variables
require('dotenv').config()

// Express App + Socket.IO inits
const express = require('express')
const app = express();
const http = require('http')
const server = http.createServer(app)
const { Server } = require("socket.io")
const cors = require('cors')
const favicon = require('serve-favicon')
const path = require('path')

const { createActionRunner, listSoundFiles, validateSoundSrc } = require('./modules/actions')
const { createActionQueue } = require('./modules/action-queue')
const { createChatService } = require('./modules/chat')
const { createGreetingService } = require('./modules/greetings')
const { createMacroService } = require('./modules/macros')
const { createObsService } = require('./modules/obs')

const PORT = Number(process.env.PORT) || 5000
const APP_NAME = process.env.APP_NAME || 'VipOS MK V'
const APP_DESCRIPTION = process.env.APP_DESCRIPTION || 'Chat Bot + Overlay Platform'
const DEFAULT_ALERT_SOUND = process.env.DEFAULT_ALERT_SOUND || 'kitt_scanner.mp3'
const DEFAULT_SOUND_COMPLETION_DELAY_MS = numberOrDefault(process.env.QUEUE_SOUND_COMPLETION_DELAY_MS, 4000)
const SOUND_COMPLETION_BUFFER_MS = numberOrDefault(process.env.QUEUE_SOUND_COMPLETION_BUFFER_MS, 250)
const ALLOWED_ORIGINS = new Set([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`
])

const io = new Server(server, {
  allowRequest(req, callback) {
    if (isAllowedOrigin(req.headers.origin)) return callback(null, true)
    return callback('Origin is not allowed', false)
  },
  cors: {
    methods: ['GET', 'POST'],
    origin(origin, callback) {
      if (isAllowedOrigin(origin)) return callback(null, true)
      return callback(null, false)
    }
  }
})

const obs = createObsService()
const greetings = createGreetingService()
const actions = createActionRunner({ io, obs, greetings })
const actionQueue = createActionQueue({
  actions,
  soundCompletionBufferMs: SOUND_COMPLETION_BUFFER_MS,
  soundCompletionFallbackMs: DEFAULT_SOUND_COMPLETION_DELAY_MS
})
const macros = createMacroService()
const chat = createChatService({ actions, actionQueue })
actions.setChatService(chat)


/**
 * Application Middleware initialization
 * - static directory and rendering engine
 * - CORS for API endpoints
 * - JSON body parsing for API endpoints
 * - favicon
 * - local JSON mutation requirement for API endpoints
 * - app.locals for app name and description
 *
 */
app.use(express.static(path.join(__dirname, 'public')))
app.set("view engine", "ejs")
app.use(cors({
  methods: ['GET', 'POST', 'OPTIONS'],
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) return callback(null, true)
    return callback(null, false)
  }
}))
app.use('/api/v1', requireLocalJsonMutation)
app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: true }))
app.use(favicon(path.join(__dirname, '/public/assets/img/favicon.ico')))
app.locals.appName = APP_NAME
app.locals.appDescription = APP_DESCRIPTION


/**
 * Async Handler for Express Routes
 * Get body message from request (body.message, body.msg, or query.message)
 *
 */
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
const getBodyMessage = req => req.body.message || req.body.msg || req.query.message || ''

function enqueueApiActions(res, name, actionList, options = {}) {
  const delayValue = options.completionDelayMs ?? options.delayMs
  const completionDelayMs = delayValue === undefined ? undefined : normalizeCompletionDelay(delayValue)
  const queue = actionQueue.enqueue({
    name,
    actions: actionList,
    completionDelayMs,
    fallbackCompletionDelayMs: options.fallbackCompletionDelayMs,
    context: { source: 'api', ...(options.context || {}) },
    source: 'api'
  })
  res.json({ ok: true, queued: true, completionDelayMs, fallbackCompletionDelayMs: options.fallbackCompletionDelayMs, queue })
}

function getRequestCompletionDelay(req) {
  const value = req.body.completionDelayMs ?? req.body.delayMs ?? req.body.queueDelayMs
  return value === undefined ? undefined : normalizeCompletionDelay(value)
}

function normalizeCompletionDelay(value) {
  const delay = Number(value || 0)
  if (!Number.isFinite(delay) || delay <= 0) return 0
  return Math.min(Math.round(delay), 10 * 60 * 1000)
}

function numberOrDefault(value, defaultValue) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : defaultValue
}


/**
 * Check if the origin is allowed based on the ALLOWED_ORIGINS
 *
 */
function isAllowedOrigin(origin) {
  return !origin || ALLOWED_ORIGINS.has(origin)
}


/**
 * Require local JSON mutation for API endpoints
 *
 */
function requireLocalJsonMutation(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()

  const origin = req.get('origin')
  if (!isAllowedOrigin(origin)) {
    return res.status(403).json({ error: 'Origin is not allowed' })
  }

  const referer = req.get('referer')
  if (!origin && referer) {
    try {
      if (!ALLOWED_ORIGINS.has(new URL(referer).origin)) {
        return res.status(403).json({ error: 'Origin is not allowed' })
      }
    } catch (error) {
      return res.status(403).json({ error: 'Origin is not allowed' })
    }
  }

  if (!req.is('application/json')) {
    return res.status(415).json({ error: 'API mutations require application/json' })
  }

  next()
}


/**
 * Home Page
 *
 */
app.get('/', (req, res) => {
  res.render('index.ejs', {
    customClass: 'index-page'
  })
})


/**
 * Control Panel
 *
 */
app.get('/control', (req, res) => {
  res.render('control.ejs', {
    customClass: 'control-page',
    loadSocket: true,
    extraStyles: ['/assets/css/control.css']
  })
})


/**
 * Overlays
 *
 */
app.get('/overlay/alerts', (req, res) => {
  res.render('overlays/alerts.ejs', { loadSocket: true })
})

app.get('/overlay/stream-border', (req, res) => {
  res.render('overlays/stream-border.ejs', { loadSocket: true })
})

app.get('/overlay/tv-guide', (req, res) => {
  res.render('overlays/tv-guide.ejs')
})

app.get('/overlay/venom-coin', (req, res) => {
  res.render('overlays/venom-coin.ejs')
})

app.get('/overlay/viper-cam', (req, res) => {
  res.render('overlays/viper-cam.ejs')
})


/**
 * API Endpoints
 *
 */
app.get('/api/v1/status', (req, res) => {
  res.json({
    app: {
      name: APP_NAME,
      description: APP_DESCRIPTION,
      port: PORT
    },
    obs: obs.getStatus(),
    chat: chat.getStatus(),
    greetings: greetings.getStatus(),
    queue: actionQueue.getStatus(),
    sockets: {
      clients: io.engine.clientsCount
    }
  })
})

app.get('/api/v1/macros', (req, res) => {
  res.json({ ok: true, macros: macros.list() })
})

app.get('/api/v1/queue', (req, res) => {
  res.json({ ok: true, queue: actionQueue.getStatus() })
})

app.get('/api/v1/sounds', (req, res) => {
  res.json({ ok: true, sounds: listSoundFiles() })
})

app.post('/api/v1/twitch/simulate/:type', asyncHandler(async (req, res) => {
  const event = req.body.event && typeof req.body.event === 'object' ? req.body.event : req.body
  await chat.simulateEvent(req.params.type, event)
  res.json({ ok: true, event: req.params.type, queue: actionQueue.getStatus() })
}))

app.get('/api/v1/greetings', (req, res) => {
  res.json({ ok: true, greetings: greetings.getStatus() })
})

app.get('/api/v1/obs/discovery', asyncHandler(async (req, res) => {
  res.json({ ok: true, obs: await obs.getDiscovery() })
}))

app.post('/api/v1/greetings/pool', asyncHandler(async (req, res) => {
  const pool = req.body.pool || req.body.theme || req.body.activePool
  if (!pool) return res.status(400).json({ error: 'pool is required' })
  res.json({ ok: true, greetings: greetings.setActivePool(pool) })
}))

app.post('/api/v1/bg-alert', asyncHandler(async (req, res) => {
  enqueueApiActions(res, 'Border Alert', [
    { type: 'overlay.emit', event: 'bg-alert' },
    { type: 'sound.play', src: DEFAULT_ALERT_SOUND, volume: 1 }
  ], {
    completionDelayMs: getRequestCompletionDelay(req),
    fallbackCompletionDelayMs: DEFAULT_SOUND_COMPLETION_DELAY_MS
  })
}))

app.post('/api/v1/bg-random', asyncHandler(async (req, res) => {
  enqueueApiActions(res, 'Random Border', [
    { type: 'overlay.emit', event: 'bg-random' },
    { type: 'sound.play', src: DEFAULT_ALERT_SOUND, volume: 1 }
  ], {
    completionDelayMs: getRequestCompletionDelay(req),
    fallbackCompletionDelayMs: DEFAULT_SOUND_COMPLETION_DELAY_MS
  })
}))

app.post('/api/v1/bg-reset', asyncHandler(async (req, res) => {
  enqueueApiActions(res, 'Reset Border', [
    { type: 'overlay.emit', event: 'bg-reset' },
    { type: 'sound.play', src: DEFAULT_ALERT_SOUND, volume: 1 }
  ], {
    completionDelayMs: getRequestCompletionDelay(req),
    fallbackCompletionDelayMs: DEFAULT_SOUND_COMPLETION_DELAY_MS
  })
}))

app.post('/api/v1/text', asyncHandler(async (req, res) => {
  const message = getBodyMessage(req)
  if (!message) return res.status(400).json({ error: 'message or msg is required' })
  enqueueApiActions(res, 'Text Alert', [
    { type: 'overlay.alert', message },
    { type: 'sound.play', src: DEFAULT_ALERT_SOUND, volume: 1 }
  ], {
    completionDelayMs: getRequestCompletionDelay(req),
    fallbackCompletionDelayMs: DEFAULT_SOUND_COMPLETION_DELAY_MS
  })
}))

app.post('/api/v1/alert', asyncHandler(async (req, res) => {
  const message = getBodyMessage(req)
  if (!message) return res.status(400).json({ error: 'message or msg is required' })
  enqueueApiActions(res, 'Overlay Alert', [
    { type: 'overlay.alert', message },
    { type: 'sound.play', src: DEFAULT_ALERT_SOUND, volume: 1 }
  ], {
    completionDelayMs: getRequestCompletionDelay(req),
    fallbackCompletionDelayMs: DEFAULT_SOUND_COMPLETION_DELAY_MS
  })
}))

app.post('/api/v1/sound', asyncHandler(async (req, res) => {
  const { src, volume } = req.body
  const soundSrc = validateSoundSrc(src)
  if (!soundSrc) {
    return res.status(400).json({
      error: 'src must be a local sound path ending in .mp3, .ogg, or .wav'
    })
  }

  enqueueApiActions(res, 'Sound Alert', [
    { type: 'sound.play', src: soundSrc, volume },
    { type: 'overlay.emit', event: 'bg-alert' }
  ], {
    completionDelayMs: getRequestCompletionDelay(req),
    fallbackCompletionDelayMs: DEFAULT_SOUND_COMPLETION_DELAY_MS
  })
}))

app.post('/api/v1/sound-random', asyncHandler(async (req, res) => {
  enqueueApiActions(res, 'Random SFX Alert', [
    { type: 'sound.pickRandom', contextKey: 'sfx' },
    { type: 'overlay.alert', message: '{sfx.text}' },
    { type: 'sound.play', src: '{sfx.src}', volume: 0.8 }
  ], {
    completionDelayMs: getRequestCompletionDelay(req),
    fallbackCompletionDelayMs: DEFAULT_SOUND_COMPLETION_DELAY_MS
  })
}))

app.post('/api/v1/chat/say', asyncHandler(async (req, res) => {
  const message = getBodyMessage(req)
  if (!message) return res.status(400).json({ error: 'message or msg is required' })

  enqueueApiActions(res, 'Chat Message', { type: 'chat.say', message })
}))

app.post('/api/v1/queue/pause', (req, res) => {
  res.json({ ok: true, queue: actionQueue.pause() })
})

app.post('/api/v1/queue/resume', (req, res) => {
  res.json({ ok: true, queue: actionQueue.resume() })
})

app.post('/api/v1/queue/skip', (req, res) => {
  res.json({ ok: true, queue: actionQueue.skipNext() })
})

app.post('/api/v1/queue/clear', (req, res) => {
  res.json({ ok: true, queue: actionQueue.clear() })
})

app.post('/api/v1/obs/scene', asyncHandler(async (req, res) => {
  const { scene } = req.body
  enqueueApiActions(res, 'OBS Scene', { type: 'obs.scene', scene })
}))

app.post('/api/v1/obs/source', asyncHandler(async (req, res) => {
  const { scene, source, visible, status } = req.body
  enqueueApiActions(res, 'OBS Source', { type: 'obs.source', scene, source, visible: visible ?? status })
}))

app.post('/api/v1/obs/mute', asyncHandler(async (req, res) => {
  const { input, source, muted, status } = req.body
  enqueueApiActions(res, 'OBS Mute', { type: 'obs.mute', input: input || source, muted: muted ?? status })
}))

app.post('/api/v1/actions/run', asyncHandler(async (req, res) => {
  const submittedActions = req.body.actions || req.body.action || req.body
  const results = await actions.run(submittedActions, { source: 'api' })
  res.json({ ok: true, results })
}))

app.post('/api/v1/actions/enqueue', asyncHandler(async (req, res) => {
  const submittedActions = req.body.actions || req.body.action || req.body
  enqueueApiActions(res, req.body.name || 'Control action', submittedActions, {
    completionDelayMs: getRequestCompletionDelay(req)
  })
}))

app.post('/api/v1/macros/:id/run', asyncHandler(async (req, res) => {
  const macro = macros.find(req.params.id)
  if (!macro) return res.status(404).json({ error: 'Macro not found' })
  const macroDelay = macro.completionDelayMs ?? macro.delayMs

  const queue = actionQueue.enqueue({
    name: macro.name,
    actions: macro.actions,
    completionDelayMs: macroDelay === undefined ? undefined : normalizeCompletionDelay(macroDelay),
    fallbackCompletionDelayMs: DEFAULT_SOUND_COMPLETION_DELAY_MS,
    context: { macro: macro.id, source: 'macro' },
    source: 'macro'
  })
  res.json({ ok: true, macro, queue })
}))

app.post('/api/v1/test', asyncHandler(async (req, res) => {
  enqueueApiActions(res, 'Test Alert', [
    { type: 'overlay.alert', message: 'VipOS MK V test alert' },
    { type: 'sound.play', src: DEFAULT_ALERT_SOUND, volume: 1 }
  ], {
    completionDelayMs: getRequestCompletionDelay(req),
    fallbackCompletionDelayMs: DEFAULT_SOUND_COMPLETION_DELAY_MS
  })
}))


/**
 * 404 / All
 *
 */
app.all('*', (req, res) => {
  res.status(404).render('404.ejs')
})

app.use((err, req, res, next) => {
  console.error(err)
  if (res.headersSent) return next(err)
  res.status(err.statusCode || 500).json({
    error: err.message || 'Unexpected server error'
  })
})


/**
 * Listen on port
 *
 */
server.listen(PORT, '127.0.0.1', async () => {
  console.log(`server is listening on port ${PORT}....`)
  obs.connect()
  chat.start()
})
