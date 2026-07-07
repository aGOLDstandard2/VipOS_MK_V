const fs = require('fs')
const path = require('path')
const { getAudioDurationMs } = require('./audio-duration')
const { createGreetingService } = require('./greetings')

const DEFAULT_SOUND_DIRECTORY = path.join(__dirname, '..', 'public', 'assets', 'sounds')
const DEFAULT_SOUND_TEXT_FILE = path.join(__dirname, '..', 'config', 'sfx-text.json')
const SOUND_FILE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9 _.-]*\.(mp3|ogg|wav)$/i
const SOUND_PATH_PATTERN = /^(?:[a-zA-Z0-9][a-zA-Z0-9 _.-]*\/)*[a-zA-Z0-9][a-zA-Z0-9 _.-]*\.(mp3|ogg|wav)$/i

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
  if (!SOUND_PATH_PATTERN.test(normalized)) return null

  return normalized
}

function createActionRunner({
  io,
  obs,
  logger = console,
  greetings = createGreetingService({ logger }),
  soundDirectory = DEFAULT_SOUND_DIRECTORY,
  soundTextFile = DEFAULT_SOUND_TEXT_FILE
}) {
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
          throw userInputError('sound.play requires a local sound path ending in .mp3, .ogg, or .wav')
        }
        const volume = clamp(Number(action.volume ?? 1), 0, 1)
        const durationMs = getSoundDurationMs(src, soundDirectory, logger)
        io.emit('sound-play', { src, volume })
        return { type, src, volume, durationMs }
      }

      case 'sound.pickRandom': {
        const contextKey = hydrate(action.contextKey || action.key || 'sfx', context)
        if (!isSafeContextPath(contextKey)) {
          throw userInputError('sound.pickRandom requires a safe contextKey')
        }

        const textMap = {
          ...loadSoundTextMap(soundTextFile, logger),
          ...normalizeSoundTextMap(action.textMap || action.messages || action.labels)
        }
        const pickedSound = pickRandomSound({ soundDirectory, textMap })
        setPath(context, contextKey, pickedSound)

        return { type, contextKey, ...pickedSound }
      }

      case 'context.pickRandom': {
        const contextKey = hydrate(action.contextKey || action.key, context)
        if (!isSafeContextPath(contextKey)) {
          throw userInputError('context.pickRandom requires a safe contextKey')
        }

        const configuredItems = action.items || action.values || action.list
        const picked = configuredItems
          ? pickInlineItem(hydrate(asArray(configuredItems), context))
          : greetings.pick({
            file: hydrate(action.file || action.path, context),
            pool: hydrate(action.pool || action.theme || action.category, context)
          })
        const value = picked.value
        setPath(context, contextKey, value)

        return { type, contextKey, ...picked }
      }

      case 'chat.say': {
        if (!chatService) throw new Error('Twitch chat is not configured')
        const message = hydrate(action.message || action.text, context)
        if (!message) throw new Error('chat.say requires a message')

        const explicitReplyId = hydrate(action.replyParentMessageId || action.replyTo, context)
        const replyParentMessageId = explicitReplyId || (parseToggle(action.reply) === true ? context.messageId : undefined)
        const sent = await chatService.say(message, { replyParentMessageId, simulated: context.simulated })
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

function setPath(target, pathValue, value) {
  const keys = pathValue.split('.')
  const lastKey = keys.pop()
  const parent = keys.reduce((current, key) => {
    if (!current[key] || typeof current[key] !== 'object') current[key] = {}
    return current[key]
  }, target)
  parent[lastKey] = value
}

function isSafeContextPath(pathValue) {
  const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype'])
  const keys = String(pathValue || '').split('.')
  return keys.every(key => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(key) && !unsafeKeys.has(key))
}

function loadSoundTextMap(file, logger = console) {
  if (!file || !fs.existsSync(file)) return {}

  try {
    return normalizeSoundTextMap(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch (error) {
    if (logger && typeof logger.warn === 'function') {
      logger.warn(`Failed to load sound text map ${file}: ${error.message}`)
    }
    return {}
  }
}

function normalizeSoundTextMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  return Object.fromEntries(Object.entries(value)
    .filter(([filename, text]) => SOUND_FILE_PATTERN.test(filename) && text !== undefined && text !== null)
    .map(([filename, text]) => [filename, String(text)]))
}

function pickRandomSound({ soundDirectory, textMap = {} }) {
  let entries

  try {
    entries = fs.readdirSync(soundDirectory, { withFileTypes: true })
  } catch (error) {
    throw userInputError('sound.pickRandom could not read the local sound directory')
  }

  const filenames = entries
    .filter(entry => entry.isFile() && SOUND_FILE_PATTERN.test(entry.name))
    .map(entry => entry.name)

  if (!filenames.length) {
    throw userInputError('sound.pickRandom found no local sound files ending in .mp3, .ogg, or .wav')
  }

  const src = filenames[Math.floor(Math.random() * filenames.length)]
  const name = path.basename(src, path.extname(src))

  return {
    filename: src,
    name,
    src,
    text: getSoundText(src, textMap)
  }
}

function getSoundText(src, textMap) {
  const mappedText = textMap[src]
  if (mappedText !== undefined && mappedText !== null && String(mappedText).trim()) return String(mappedText)
  return path.basename(src, path.extname(src)).replace(/[_ .-]+/g, ' ').trim()
}

function getSoundDurationMs(src, soundDirectory, logger = console) {
  const filePath = resolveSoundPath(src, soundDirectory)
  if (!filePath) return null

  try {
    return getAudioDurationMs(filePath)
  } catch (error) {
    if (logger && typeof logger.warn === 'function') {
      logger.warn(`Failed to read sound duration for ${src}: ${error.message}`)
    }
    return null
  }
}

function resolveSoundPath(src, soundDirectory) {
  const resolved = path.resolve(soundDirectory, src)
  const relative = path.relative(soundDirectory, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  return resolved
}

function asArray(value) {
  if (value === undefined || value === null || value === '') return []
  return Array.isArray(value) ? value : [value]
}

function pickInlineItem(value) {
  const items = asArray(value).map(item => String(item || '').trim()).filter(Boolean)
  if (!items.length) throw userInputError('context.pickRandom requires at least one item')
  return {
    pool: 'inline',
    value: items[Math.floor(Math.random() * items.length)]
  }
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
