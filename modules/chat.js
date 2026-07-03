const fs = require('fs')
const path = require('path')

const CHAT_INTENT = 'chat'
const DEFAULT_COMMAND_PREFIX = '!'
const DEFAULT_TOKEN_FILE = path.join(__dirname, '..', 'config', 'twitch-token.json')
const DEFAULT_COMMANDS_FILE = path.join(__dirname, '..', 'config', 'commands.json')
const DEFAULT_RECONNECT_INITIAL_MS = 5000
const DEFAULT_RECONNECT_MAX_MS = 60000
const REQUIRED_SCOPES = ['user:read:chat', 'user:write:chat']

let twurpleModules = null

function createChatService({ actions, logger = console } = {}) {
  if (!actions) throw new Error('Chat service requires an action runner')

  const config = readConfig()
  const cooldowns = new Map()

  let api = null
  let authProvider = null
  let commandMap = new Map()
  let commandWatcherStarted = false
  let commands = []
  let listener = null
  let retryAttempt = 0
  let retryTimer = null
  let shouldRun = false
  let started = false
  let starting = false

  const state = {
    enabled: config.enabled,
    started: false,
    connected: false,
    authMode: null,
    botUserId: config.botUserId || null,
    botUserName: normalizeLogin(config.botUsername) || null,
    broadcasterId: config.broadcasterId || null,
    broadcasterName: normalizeLogin(config.broadcasterLogin) || null,
    commandCount: 0,
    commandsLoadedAt: null,
    commandsLastError: null,
    commandsPath: relativePath(config.commandsFile),
    lastCommandAt: null,
    lastError: null,
    lastMessageAt: null,
    messageCount: 0,
    nextRetryAt: null,
    retryAttempt: 0,
    tokenFile: relativePath(config.tokenFile)
  }

  async function start() {
    shouldRun = true

    if (!state.enabled) {
      logger.warn('Twitch chat is disabled')
      return
    }

    if (started || starting) return
    starting = true

    try {
      await loadCommands()

      const twurple = await loadTwurple()
      const auth = await createAuthProvider(twurple, config, logger)
      authProvider = auth.authProvider
      state.authMode = auth.mode
      state.botUserId = auth.botUserId

      api = new twurple.ApiClient({ authProvider })

      const broadcaster = await resolveBroadcaster(api, config)
      state.broadcasterId = broadcaster.id
      state.broadcasterName = broadcaster.name

      if (!state.botUserName) {
        const botUser = await api.users.getUserById(state.botUserId)
        state.botUserName = botUser ? botUser.name : state.botUserId
      }

      if (!shouldRun) return

      listener = new twurple.EventSubWsListener({ apiClient: api })
      bindListenerEvents(listener)
      listener.onChannelChatMessage(state.broadcasterId, state.botUserId, event => {
        handleMessage(event).catch(error => {
          state.lastError = error.message
          logger.error(`Twitch chat message handler failed: ${error.message}`)
        })
      })

      listener.start()
      if (!shouldRun) {
        cleanupListener()
        return
      }

      watchCommands()
      started = true
      state.started = true
      state.lastError = null
      resetRetry()
      logger.log(`Twitch chat listener starting for #${state.broadcasterName} as ${state.botUserName}`)
    } catch (error) {
      state.lastError = error.message
      logger.error(`Twitch chat failed to start: ${error.message}`)
      cleanupListener()
      scheduleRetry()
    } finally {
      starting = false
    }
  }

  function stop() {
    shouldRun = false
    resetRetry()
    cleanupListener()
    unwatchCommands()
  }

  function cleanupListener() {
    if (listener) listener.stop()
    listener = null
    started = false
    state.started = false
    state.connected = false
  }

  function scheduleRetry() {
    if (!state.enabled) return
    if (!shouldRun) return
    if (retryTimer) return

    retryAttempt += 1
    const delay = Math.min(
      config.reconnectInitialMs * Math.pow(2, retryAttempt - 1),
      config.reconnectMaxMs
    )

    state.retryAttempt = retryAttempt
    state.nextRetryAt = new Date(Date.now() + delay).toISOString()
    logger.warn(`Retrying Twitch chat startup in ${Math.round(delay / 1000)}s`)

    retryTimer = setTimeout(() => {
      retryTimer = null
      start()
    }, delay)
  }

  function resetRetry() {
    retryAttempt = 0
    state.retryAttempt = 0
    state.nextRetryAt = null
    clearRetry()
  }

  function clearRetry() {
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
  }

  async function say(message, options = {}) {
    if (!api || !state.botUserId || !state.broadcasterId) {
      throw new Error('Twitch chat is not ready')
    }

    const text = String(message || '').trim()
    if (!text) throw new Error('chat.say requires a message')

    const params = {}
    const replyParentMessageId = options.replyParentMessageId || options.replyTo
    if (replyParentMessageId) params.replyParentMessageId = replyParentMessageId

    const sent = await api.asUser(state.botUserId, async ctx => (
      ctx.chat.sendChatMessage(state.broadcasterId, text, params)
    ))

    return {
      id: sent.id,
      isSent: sent.isSent,
      dropReasonCode: sent.dropReasonCode,
      dropReasonMessage: sent.dropReasonMessage
    }
  }

  function bindListenerEvents(eventSubListener) {
    eventSubListener.onUserSocketConnect(userId => {
      if (userId === state.botUserId) {
        state.connected = true
        logger.log('Twitch EventSub socket connected')
      }
    })

    eventSubListener.onUserSocketDisconnect((userId, error) => {
      if (userId === state.botUserId) {
        state.connected = false
        if (error) state.lastError = error.message
        logger.warn(`Twitch EventSub socket disconnected${error ? `: ${error.message}` : ''}`)
      }
    })

    eventSubListener.onSubscriptionCreateFailure((subscription, error) => {
      state.lastError = error.message
      logger.error(`Twitch EventSub subscription failed (${subscription.id}): ${error.message}`)
      cleanupListener()
      scheduleRetry()
    })

    eventSubListener.onRevoke(subscription => {
      state.lastError = `Subscription revoked: ${subscription.id}`
      logger.warn(`Twitch EventSub subscription revoked: ${subscription.id}`)
      cleanupListener()
      scheduleRetry()
    })
  }

  async function handleMessage(event) {
    const context = createMessageContext(event, state)
    state.messageCount += 1
    state.lastMessageAt = new Date().toISOString()

    if (config.ignoreSelf && context.chat.chatter.id === state.botUserId) return

    if (isHighlightMessage(context, config)) {
      await runHighlightAlert(context)
    }

    const commandMatch = findCommand(context.message)
    if (!commandMatch) return

    await runCommand(commandMatch, context)
  }

  async function runCommand(commandMatch, context) {
    const { command, commandName, after, args } = commandMatch
    const commandContext = {
      ...context,
      after,
      args,
      command: commandName,
      commandName,
      chat: {
        ...context.chat,
        after,
        args,
        command: commandName
      }
    }

    if (!isAllowedRole(command.roles, commandContext.roles)) return
    if (isCoolingDown(command, commandContext)) return

    state.lastCommandAt = new Date().toISOString()
    logger.log(`Twitch command ${commandName} from ${commandContext.displayName}`)
    await actions.run(command.actions, commandContext)
  }

  async function runHighlightAlert(context) {
    const actionList = [
      {
        type: 'overlay.alert',
        message: `{displayName}: {message}`
      }
    ]

    if (config.defaultAlertSound) {
      actionList.push({
        type: 'sound.play',
        src: config.defaultAlertSound,
        volume: 1
      })
    }

    await actions.run(actionList, context)
  }

  function findCommand(message) {
    const trimmed = String(message || '').trim()
    if (!trimmed) return null

    const match = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/)
    if (!match) return null

    const commandName = match[1].toLowerCase()
    const command = commandMap.get(commandName)
    if (!command) return null

    const after = (match[2] || '').trim()
    return {
      after,
      args: after ? after.split(/\s+/) : [],
      command,
      commandName
    }
  }

  function isCoolingDown(command, context) {
    const seconds = Number(command.cooldownSeconds || 0)
    if (seconds <= 0) return false

    const scope = command.cooldownScope === 'user' ? context.chat.chatter.id : 'global'
    const key = `${command.key}:${scope}`
    const now = Date.now()
    const availableAt = cooldowns.get(key) || 0
    if (availableAt > now) return true

    cooldowns.set(key, now + seconds * 1000)
    return false
  }

  async function loadCommands() {
    if (!fs.existsSync(config.commandsFile)) {
      commands = []
      commandMap = new Map()
      state.commandCount = 0
      state.commandsLastError = null
      logger.warn(`Twitch commands file not found: ${relativePath(config.commandsFile)}`)
      return
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(config.commandsFile, 'utf8'))
      if (!Array.isArray(parsed)) {
        throw new Error('commands.json must contain an array')
      }

      const nextCommands = parsed.map(command => normalizeCommand(command, config.commandPrefix)).filter(Boolean)
      const nextCommandMap = new Map()

      for (const command of nextCommands) {
        for (const name of command.names) {
          if (nextCommandMap.has(name)) logger.warn(`Duplicate Twitch command ignored: ${name}`)
          else nextCommandMap.set(name, command)
        }
      }

      commands = nextCommands
      commandMap = nextCommandMap
      state.commandCount = commandMap.size
      state.commandsLoadedAt = new Date().toISOString()
      state.commandsLastError = null
      logger.log(`Loaded ${state.commandCount} Twitch chat command${state.commandCount === 1 ? '' : 's'}`)
    } catch (error) {
      state.commandsLastError = error.message
      logger.error(`Failed to load Twitch commands from ${relativePath(config.commandsFile)}: ${error.message}`)
    }
  }

  function watchCommands() {
    if (commandWatcherStarted) return

    commandWatcherStarted = true
    fs.watchFile(config.commandsFile, { interval: 1000 }, () => {
      loadCommands().catch(error => {
        state.lastError = error.message
        logger.error(`Failed to reload Twitch commands: ${error.message}`)
      })
    })
  }

  function unwatchCommands() {
    if (!commandWatcherStarted) return
    fs.unwatchFile(config.commandsFile)
    commandWatcherStarted = false
  }

  function getStatus() {
    return {
      ...state,
      listenerActive: Boolean(listener && listener.isActive)
    }
  }

  return {
    getStatus,
    say,
    start,
    stop
  }
}

async function createAuthProvider(twurple, config, logger) {
  if (!config.clientId) throw new Error('TWITCH_CLIENT_ID is required when CHAT_ENABLED=true')

  const token = readTokenConfig(config.tokenFile)
  const accessToken = cleanAccessToken(token.accessToken || config.botAccessToken)
  const refreshToken = token.refreshToken || config.botRefreshToken
  const expiresIn = token.expiresIn || config.botExpiresIn
  const obtainmentTimestamp = token.obtainmentTimestamp || config.botObtainmentTimestamp
  const scope = token.scope || config.botScopes

  if (refreshToken) {
    if (!config.clientSecret) {
      throw new Error('TWITCH_CLIENT_SECRET is required when using TWITCH_BOT_REFRESH_TOKEN')
    }

    const authProvider = new twurple.RefreshingAuthProvider({
      clientId: config.clientId,
      clientSecret: config.clientSecret
    })

    authProvider.onRefresh((userId, refreshedToken) => {
      persistToken(config.tokenFile, userId, refreshedToken, logger)
    })

    authProvider.onRefreshFailure((userId, error) => {
      logger.error(`Twitch token refresh failed for ${userId}: ${error.message}`)
    })

    const botUserId = await authProvider.addUserForToken({
      accessToken: expiresIn !== undefined && obtainmentTimestamp !== undefined ? accessToken : undefined,
      refreshToken,
      expiresIn,
      obtainmentTimestamp,
      scope
    }, [CHAT_INTENT])

    warnMissingScopes(authProvider.getCurrentScopesForUser(botUserId), REQUIRED_SCOPES, logger)

    return { authProvider, botUserId, mode: 'refreshing' }
  }

  if (!accessToken) {
    throw new Error('TWITCH_BOT_ACCESS_TOKEN and TWITCH_BOT_REFRESH_TOKEN are required when CHAT_ENABLED=true')
  }

  const authProvider = new twurple.StaticAuthProvider(config.clientId, accessToken)
  const tokenInfo = await twurple.getTokenInfo(accessToken)
  const botUserId = config.botUserId || tokenInfo.userId
  if (!botUserId) throw new Error('Unable to determine Twitch bot user ID from token')

  warnMissingScopes(tokenInfo.scopes, REQUIRED_SCOPES, logger)
  logger.warn('Twitch chat is using a static access token; add TWITCH_BOT_REFRESH_TOKEN for durable refreshes')
  return { authProvider, botUserId, mode: 'static' }
}

async function resolveBroadcaster(api, config) {
  if (config.broadcasterId) {
    const user = await api.users.getUserById(config.broadcasterId)
    if (!user) throw new Error(`Twitch broadcaster ID was not found: ${config.broadcasterId}`)
    return user
  }

  if (!config.broadcasterLogin) {
    throw new Error('TWITCH_CHANNEL or TWITCH_CHANNEL_ID is required when CHAT_ENABLED=true')
  }

  const user = await api.users.getUserByName(config.broadcasterLogin)
  if (!user) throw new Error(`Twitch channel was not found: ${config.broadcasterLogin}`)
  return user
}

function createMessageContext(event, state) {
  const badges = event.badges || {}
  const roles = getRoles({
    badges,
    broadcasterId: state.broadcasterId,
    chatterId: event.chatterId
  })

  return {
    after: '',
    args: [],
    badges,
    broadcaster: event.broadcasterName,
    broadcasterDisplayName: event.broadcasterDisplayName,
    broadcasterId: event.broadcasterId,
    chat: {
      badges,
      broadcaster: {
        displayName: event.broadcasterDisplayName,
        id: event.broadcasterId,
        name: event.broadcasterName
      },
      chatter: {
        color: event.color,
        displayName: event.chatterDisplayName,
        id: event.chatterId,
        name: event.chatterName
      },
      isCheer: event.isCheer,
      isRedemption: event.isRedemption,
      messageId: event.messageId,
      messageType: event.messageType,
      rewardId: event.rewardId,
      roles,
      text: event.messageText
    },
    command: '',
    commandName: '',
    displayName: event.chatterDisplayName,
    message: event.messageText,
    messageId: event.messageId,
    roles,
    source: 'chat',
    user: event.chatterName,
    userId: event.chatterId,
    username: event.chatterName
  }
}

function getRoles({ badges, broadcasterId, chatterId }) {
  const roles = new Set(['everyone'])

  if (chatterId === broadcasterId || badges.broadcaster) roles.add('broadcaster')
  if (badges.moderator) roles.add('moderator')
  if (badges.vip) roles.add('vip')
  if (badges.subscriber) roles.add('subscriber')
  if (badges.founder) {
    roles.add('founder')
    roles.add('subscriber')
  }

  return [...roles]
}

function isAllowedRole(allowedRoles, actualRoles) {
  if (!allowedRoles.length) return true

  const actual = new Set(actualRoles.map(normalizeRole))
  return allowedRoles.some(role => role === 'everyone' || actual.has(role))
}

function isHighlightMessage(context, config) {
  if (!config.enableHighlightAlerts) return false
  if (context.chat.messageType === 'channel_points_highlighted') return true
  return Boolean(config.highlightRewardId && context.chat.rewardId === config.highlightRewardId)
}

function warnMissingScopes(actualScopes, requiredScopes, logger) {
  const actual = new Set(actualScopes || [])
  const missing = requiredScopes.filter(scope => !actual.has(scope))
  if (missing.length) {
    logger.warn(`Twitch bot token is missing recommended scope${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`)
  }
}

function normalizeCommand(command, commandPrefix) {
  if (!command || typeof command !== 'object' || command.enabled === false) return null

  const names = [
    command.command,
    ...(Array.isArray(command.commands) ? command.commands : []),
    ...(Array.isArray(command.aliases) ? command.aliases : [])
  ].filter(Boolean).map(name => normalizeCommandName(name, commandPrefix)).filter(Boolean)

  if (!names.length || !command.actions) return null

  return {
    actions: command.actions,
    cooldownScope: command.cooldownScope === 'user' ? 'user' : 'global',
    cooldownSeconds: Number(command.cooldownSeconds || 0),
    key: names[0],
    names,
    roles: normalizeRoles(command.roles)
  }
}

function normalizeCommandName(name, commandPrefix) {
  const normalized = String(name || '').trim().toLowerCase()
  if (!normalized) return null
  if (normalized.startsWith(commandPrefix)) return normalized
  return `${commandPrefix}${normalized}`
}

function normalizeRoles(roles) {
  if (!Array.isArray(roles)) return []
  return roles.map(normalizeRole).filter(Boolean)
}

function normalizeRole(role) {
  const normalized = String(role || '').trim().toLowerCase()
  const aliases = {
    '*': 'everyone',
    all: 'everyone',
    mod: 'moderator',
    mods: 'moderator',
    sub: 'subscriber',
    subs: 'subscriber'
  }

  return aliases[normalized] || normalized
}

function readConfig() {
  const broadcasterLogin = process.env.TWITCH_CHANNEL || process.env.TWITCH_BROADCASTER_LOGIN
  const broadcasterId = process.env.TWITCH_CHANNEL_ID || process.env.TWITCH_BROADCASTER_ID

  return {
    botAccessToken: process.env.TWITCH_BOT_ACCESS_TOKEN || process.env.TWITCH_BOT_TOKEN,
    botExpiresIn: numberOrUndefined(process.env.TWITCH_BOT_EXPIRES_IN),
    botObtainmentTimestamp: numberOrUndefined(process.env.TWITCH_BOT_OBTAINMENT_TIMESTAMP),
    botRefreshToken: process.env.TWITCH_BOT_REFRESH_TOKEN,
    botScopes: parseScopes(process.env.TWITCH_BOT_SCOPES),
    botUserId: process.env.TWITCH_BOT_USER_ID,
    botUsername: process.env.TWITCH_BOT_USERNAME,
    broadcasterId,
    broadcasterLogin: normalizeLogin(broadcasterLogin),
    clientId: process.env.TWITCH_CLIENT_ID,
    clientSecret: process.env.TWITCH_CLIENT_SECRET,
    commandPrefix: process.env.CHAT_COMMAND_PREFIX || DEFAULT_COMMAND_PREFIX,
    commandsFile: resolveAppPath(process.env.CHAT_COMMANDS_FILE, DEFAULT_COMMANDS_FILE),
    defaultAlertSound: process.env.DEFAULT_ALERT_SOUND || 'kitt_scanner.mp3',
    enableHighlightAlerts: parseBool(process.env.CHAT_ENABLE_HIGHLIGHT_ALERTS, false),
    enabled: parseBool(process.env.CHAT_ENABLED, false),
    highlightRewardId: process.env.TWITCH_HIGHLIGHT_REWARD_ID || '',
    ignoreSelf: parseBool(process.env.CHAT_IGNORE_SELF, true),
    reconnectInitialMs: numberOrDefault(process.env.CHAT_RECONNECT_INITIAL_MS, DEFAULT_RECONNECT_INITIAL_MS),
    reconnectMaxMs: numberOrDefault(process.env.CHAT_RECONNECT_MAX_MS, DEFAULT_RECONNECT_MAX_MS),
    tokenFile: resolveAppPath(process.env.TWITCH_TOKEN_FILE, DEFAULT_TOKEN_FILE)
  }
}

function readTokenConfig(tokenFile) {
  if (!tokenFile || !fs.existsSync(tokenFile)) return {}

  const data = JSON.parse(fs.readFileSync(tokenFile, 'utf8'))
  return {
    accessToken: data.accessToken || data.access_token,
    expiresIn: numberOrUndefined(data.expiresIn || data.expires_in),
    obtainmentTimestamp: numberOrUndefined(data.obtainmentTimestamp || data.obtainment_timestamp),
    refreshToken: data.refreshToken || data.refresh_token,
    scope: parseScopes(data.scope || data.scopes)
  }
}

function persistToken(tokenFile, userId, token, logger) {
  if (!tokenFile) return

  try {
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true })
    const payload = {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresIn: token.expiresIn,
      obtainmentTimestamp: token.obtainmentTimestamp,
      scope: token.scope,
      updatedAt: new Date().toISOString(),
      userId
    }
    const tempFile = `${tokenFile}.tmp`
    fs.writeFileSync(tempFile, `${JSON.stringify(payload, null, 2)}\n`)
    fs.renameSync(tempFile, tokenFile)
  } catch (error) {
    logger.error(`Failed to persist Twitch token: ${error.message}`)
  }
}

function resolveAppPath(value, fallback) {
  if (!value) return fallback
  return path.isAbsolute(value) ? value : path.join(__dirname, '..', value)
}

function relativePath(filePath) {
  return path.relative(path.join(__dirname, '..'), filePath).replace(/\\/g, '/')
}

function normalizeLogin(value) {
  return String(value || '').trim().replace(/^#/, '').toLowerCase()
}

function cleanAccessToken(value) {
  return String(value || '').trim().replace(/^oauth:/i, '') || undefined
}

function parseBool(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase())
}

function parseScopes(value) {
  if (Array.isArray(value)) return value
  if (!value) return undefined
  return String(value).split(/[,\s]+/).map(scope => scope.trim()).filter(Boolean)
}

function numberOrUndefined(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function numberOrDefault(value, defaultValue) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : defaultValue
}

async function loadTwurple() {
  if (twurpleModules) return twurpleModules

  const [apiModule, authModule, eventSubModule] = await Promise.all([
    import('@twurple/api'),
    import('@twurple/auth'),
    import('@twurple/eventsub-ws')
  ])

  twurpleModules = {
    ApiClient: apiModule.ApiClient,
    EventSubWsListener: eventSubModule.EventSubWsListener,
    RefreshingAuthProvider: authModule.RefreshingAuthProvider,
    StaticAuthProvider: authModule.StaticAuthProvider,
    getTokenInfo: authModule.getTokenInfo
  }

  return twurpleModules
}

module.exports = {
  createChatService,
  REQUIRED_SCOPES
}
