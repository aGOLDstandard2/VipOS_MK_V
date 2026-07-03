const fs = require('fs/promises')
const path = require('path')
const tmi = require('tmi.js')

const DEFAULT_COMMANDS = [
  {
    command: '!vipos',
    roles: ['broadcaster', 'mod'],
    cooldownSeconds: 5,
    actions: [
      { type: 'overlay.alert', message: 'VipOS MK V is online.' }
    ]
  },
  {
    command: '!alert',
    roles: ['broadcaster', 'mod', 'vip'],
    cooldownSeconds: 5,
    actions: [
      { type: 'overlay.alert', message: '{after}' }
    ]
  },
  {
    command: '!border',
    roles: ['broadcaster', 'mod'],
    cooldownSeconds: 5,
    actions: [
      { type: 'overlay.emit', event: 'bg-random' }
    ]
  }
]

function createChatService({ io, actions, logger = console }) {
  let client = null
  let commandMap = new Map()
  const lastUsed = new Map()

  const state = {
    enabled: process.env.CHAT_ENABLED !== 'false' && Boolean(process.env.TWITCH_CHANNEL),
    connected: false,
    canSend: Boolean(process.env.TWITCH_BOT_USERNAME && process.env.TWITCH_BOT_TOKEN),
    channel: normalizeChannel(process.env.TWITCH_CHANNEL || ''),
    commandCount: 0,
    lastError: null
  }

  async function connect() {
    commandMap = buildCommandMap(await loadCommands())
    state.commandCount = commandMap.size

    if (!state.enabled) {
      logger.warn('Chat is disabled because TWITCH_CHANNEL is not configured')
      return
    }

    const options = {
      connection: {
        reconnect: true,
        secure: true
      },
      channels: [state.channel]
    }

    if (state.canSend) {
      options.identity = {
        username: process.env.TWITCH_BOT_USERNAME,
        password: process.env.TWITCH_BOT_TOKEN
      }
    }

    client = new tmi.Client(options)
    client.on('connected', onConnected)
    client.on('disconnected', onDisconnected)
    client.on('message', onMessage)

    try {
      await client.connect()
    } catch (error) {
      state.lastError = error.message
      logger.error(`Error connecting to Twitch chat: ${error.message}`)
    }
  }

  async function say(message, channel = state.channel) {
    if (!client || !state.connected) throw new Error('Chat is not connected')
    if (!state.canSend) throw new Error('Chat is connected anonymously and cannot send messages')
    await client.say(normalizeChannel(channel), message)
  }

  function getStatus() {
    return {
      enabled: state.enabled,
      connected: state.connected,
      canSend: state.canSend,
      channel: state.channel,
      commandCount: state.commandCount,
      lastError: state.lastError
    }
  }

  function onConnected() {
    state.connected = true
    state.lastError = null
    logger.log(`Twitch chat connected to ${state.channel}`)
  }

  function onDisconnected(reason) {
    state.connected = false
    state.lastError = reason || null
    logger.warn(`Twitch chat disconnected${reason ? `: ${reason}` : ''}`)
  }

  async function onMessage(channel, tags, message, self) {
    if (self || !message) return

    const username = tags.username || ''
    const displayName = tags['display-name'] || username
    const roles = getRoles(tags, channel)
    const command = getCommandName(message)
    const after = getCommandAfter(message)

    const event = {
      source: 'chat',
      channel: normalizeChannel(channel),
      user: displayName,
      username,
      message,
      command,
      after,
      roles,
      tags
    }

    io.emit('chat-message', publicChatEvent(event))

    try {
      if (shouldAlertHighlight(tags, roles)) {
        await actions.run({ type: 'overlay.alert', message: '{message}' }, event)
      }

      const commandConfig = commandMap.get(command)
      if (!commandConfig) return
      if (!hasPermission(commandConfig.roles, roles)) return
      if (!passesCooldown(commandConfig, username, lastUsed)) return

      await actions.run(commandConfig.actions, event)
    } catch (error) {
      state.lastError = error.message
      logger.error(`Chat action failed: ${error.message}`)
    }
  }

  return {
    connect,
    getStatus,
    say
  }
}

async function loadCommands() {
  const filePath = path.join(__dirname, '..', 'config', 'commands.json')

  try {
    const file = await fs.readFile(filePath, 'utf8')
    const parsed = JSON.parse(file)
    return Array.isArray(parsed) ? parsed : parsed.commands
  } catch (error) {
    return DEFAULT_COMMANDS
  }
}

function buildCommandMap(commands = []) {
  const map = new Map()

  for (const command of commands) {
    if (!command || command.enabled === false) continue
    if (!command.command || !Array.isArray(command.actions)) continue
    map.set(command.command.toLowerCase(), command)
  }

  return map
}

function getRoles(tags, channel) {
  const badges = tags.badges || {}
  const username = tags.username || ''
  const channelName = normalizeChannel(channel).toLowerCase()

  return {
    broadcaster: Boolean(badges.broadcaster) || username.toLowerCase() === channelName,
    mod: Boolean(tags.mod) || Boolean(badges.moderator),
    vip: Boolean(badges.vip),
    subscriber: Boolean(badges.subscriber),
    founder: Boolean(badges.founder)
  }
}

function hasPermission(requiredRoles = [], roles) {
  if (!requiredRoles.length || requiredRoles.includes('everyone')) return true
  return requiredRoles.some(role => Boolean(roles[role]))
}

function passesCooldown(commandConfig, username, lastUsed) {
  const cooldownMs = Number(commandConfig.cooldownSeconds || 0) * 1000
  if (!cooldownMs) return true

  const scope = commandConfig.cooldownScope === 'user' ? username : 'global'
  const key = `${commandConfig.command}:${scope}`
  const now = Date.now()
  const previous = lastUsed.get(key) || 0

  if (now - previous < cooldownMs) return false
  lastUsed.set(key, now)
  return true
}

function shouldAlertHighlight(tags, roles) {
  if (process.env.CHAT_ENABLE_HIGHLIGHT_ALERTS === 'false') return false
  const highlightRewardId = process.env.TWITCH_HIGHLIGHT_REWARD_ID
  const isNativeHighlight = tags['msg-id'] === 'highlighted-message'
  const isConfiguredReward = highlightRewardId && tags['custom-reward-id'] === highlightRewardId
  const trustedUser = roles.broadcaster || roles.mod || roles.vip
  return trustedUser && (isNativeHighlight || isConfiguredReward)
}

function normalizeChannel(channel) {
  return String(channel || '').replace(/^#/, '').toLowerCase()
}

function getCommandName(message) {
  return String(message).trim().split(/\s+/)[0].toLowerCase()
}

function getCommandAfter(message) {
  const trimmed = String(message).trim()
  const firstSpace = trimmed.indexOf(' ')
  return firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim()
}

function publicChatEvent(event) {
  return {
    channel: event.channel,
    user: event.user,
    username: event.username,
    message: event.message,
    roles: event.roles
  }
}

module.exports = {
  createChatService
}
