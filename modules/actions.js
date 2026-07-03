const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function userInputError(message) {
  const error = new Error(message)
  error.statusCode = 400
  return error
}

function validateSoundSrc(src) {
  if (typeof src !== 'string') return null

  const normalized = src.trim()
  if (!normalized) return null
  if (normalized.includes('..') || normalized.includes('/') || normalized.includes('\\')) return null
  if (!/^[a-zA-Z0-9][a-zA-Z0-9 _.-]*\.(mp3|ogg|wav)$/i.test(normalized)) return null

  return normalized
}

function createActionRunner({ io, obs, logger = console }) {
  let chatService = null

  function setChatService(service) {
    chatService = service
  }

  async function run(actions, context = {}) {
    const actionList = Array.isArray(actions) ? actions : [actions]
    const results = []

    for (const action of actionList) {
      results.push(await runOne(action, context))
    }

    return results
  }

  async function runOne(action, context) {
    if (!action || typeof action !== 'object') {
      throw new Error('Action must be an object')
    }

    const type = action.type || action.action
    if (!type) throw new Error('Action type is required')

    switch (type) {
      case 'delay': {
        const ms = Number(action.ms || action.duration || 0)
        if (ms > 0) await wait(ms)
        return { type, ms }
      }

      case 'log': {
        const message = hydrate(action.message || '', context)
        logger.log(message)
        return { type, message }
      }

      case 'overlay.emit': {
        const event = hydrate(action.event, context)
        if (!event) throw new Error('overlay.emit requires an event')
        const payload = hydrate(action.payload || {}, context)
        io.emit(event, payload)
        return { type, event, payload }
      }

      case 'overlay.alert': {
        const message = hydrate(action.message, context)
        if (!message) throw new Error('overlay.alert requires a message')
        if (action.background !== false) io.emit('bg-alert')
        io.emit('text-alert', { message })
        return { type, message }
      }

      case 'sound.play': {
        const src = validateSoundSrc(hydrate(action.src || action.path, context))
        if (!src) {
          throw userInputError('sound.play requires a local sound filename ending in .mp3, .ogg, or .wav')
        }
        const volume = clamp(Number(action.volume ?? 1), 0, 1)
        io.emit('sound-play', { src, volume })
        return { type, src, volume }
      }

      case 'chat.say': {
        if (!chatService) throw new Error('Twitch chat is not configured')
        const message = hydrate(action.message || action.text, context)
        if (!message) throw new Error('chat.say requires a message')

        const explicitReplyId = hydrate(action.replyParentMessageId || action.replyTo, context)
        const replyParentMessageId = explicitReplyId || (parseToggle(action.reply) === true ? context.messageId : undefined)
        const sent = await chatService.say(message, { replyParentMessageId })
        return { type, message, ...sent }
      }

      case 'obs.scene': {
        const scene = hydrate(action.scene, context)
        if (!scene) throw new Error('obs.scene requires a scene')
        await obs.switchScene(scene)
        return { type, scene }
      }

      case 'obs.source': {
        const scene = hydrate(action.scene, context)
        const source = hydrate(action.source || action.input, context)
        if (!source) throw new Error('obs.source requires a source')
        const visible = parseToggle(action.visible ?? action.status ?? true)
        if (visible === 'toggle') {
          const nextVisible = await obs.toggleSourceVisibility(scene, source)
          return { type, scene, source, visible: nextVisible }
        }

        await obs.setSourceVisibility(scene, source, visible)
        return { type, scene, source, visible }
      }

      case 'obs.mute': {
        const input = hydrate(action.input || action.source, context)
        if (!input) throw new Error('obs.mute requires an input')
        const muted = parseToggle(action.muted ?? action.status ?? 'toggle')
        if (muted === 'toggle') {
          const nextMuted = await obs.toggleInputMute(input)
          return { type, input, muted: nextMuted }
        }

        await obs.setInputMute(input, muted)
        return { type, input, muted }
      }

      case 'obs.media': {
        const input = hydrate(action.input || action.source, context)
        const mediaAction = hydrate(action.mediaAction || action.media || action.command, context)
        if (!input) throw new Error('obs.media requires an input')
        if (!mediaAction) throw new Error('obs.media requires a mediaAction')
        await obs.mediaAction(input, mediaAction)
        return { type, input, mediaAction }
      }

      default:
        throw new Error(`Unknown action type: ${type}`)
    }
  }

  return {
    run,
    setChatService
  }
}

function hydrate(value, context) {
  if (typeof value === 'string') {
    return value.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (_, key) => {
      const found = getPath(context, key)
      return found === undefined || found === null ? '' : String(found)
    })
  }

  if (Array.isArray(value)) return value.map(item => hydrate(item, context))

  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hydrate(item, context)]))
  }

  return value
}

function getPath(source, path) {
  return path.split('.').reduce((current, key) => {
    if (current === undefined || current === null) return undefined
    return current[key]
  }, source)
}

function parseToggle(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0

  const normalized = String(value).trim().toLowerCase()
  if (['toggle', 'flip'].includes(normalized)) return 'toggle'
  if (['on', 'true', 'yes', '1', 'show', 'visible', 'unmuted'].includes(normalized)) return true
  if (['off', 'false', 'no', '0', 'hide', 'hidden', 'muted'].includes(normalized)) return false

  return Boolean(value)
}

function clamp(value, min, max) {
  if (Number.isNaN(value)) return max
  return Math.min(Math.max(value, min), max)
}

module.exports = {
  createActionRunner,
  validateSoundSrc
}
