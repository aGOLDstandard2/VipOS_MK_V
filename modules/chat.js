const fs = require('fs')
const path = require('path')

const CHAT_INTENT = 'chat'
const REDEMPTION_INTENT = 'redemptions'
const DEFAULT_COMMAND_PREFIX = '!'
const DEFAULT_TOKEN_FILE = path.join(__dirname, '..', 'config', 'twitch-token.json')
const DEFAULT_BROADCASTER_TOKEN_FILE = path.join(__dirname, '..', 'config', 'twitch-broadcaster-token.json')
const DEFAULT_COMMANDS_FILE = path.join(__dirname, '..', 'config', 'commands.json')
const DEFAULT_RECONNECT_INITIAL_MS = 5000
const DEFAULT_RECONNECT_MAX_MS = 60000
const REQUIRED_SCOPES = ['user:read:chat', 'user:write:chat']
const REDEMPTION_SCOPES = ['channel:read:redemptions', 'channel:manage:redemptions']

let twurpleModules = null

function createChatService({ actions, logger = console } = {}) {
  if (!actions) throw new Error('Chat service requires an action runner')

  const config = readConfig()
  const cooldowns = new Map()

  let api = null
  let authProvider = null
  let automaticRedemptionHandlers = []
  let commandMap = new Map()
  let commandWatcherStarted = false
  let commands = []
  let listener = null
  let redemptionHandlers = []
  let redemptionUpdateHandlers = []
  let rewardRetryAttempt = 0
  let rewardRetryTimer = null
  let retryAttempt = 0
  let retryTimer = null
  let rewardEventHandlers = []
  let rewardSubscriptionRegistrars = new Map()
  let rewardSubscriptionRetryQueue = new Map()
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
    broadcasterAuthUserId: null,
    broadcasterId: config.broadcasterId || null,
    broadcasterName: normalizeLogin(config.broadcasterLogin) || null,
    broadcasterTokenFile: relativePath(config.broadcasterTokenFile),
    commandCount: 0,
    commandsLoadedAt: null,
    commandsLastError: null,
    commandsPath: relativePath(config.commandsFile),
    automaticRedemptionHandlerCount: 0,
    lastCommandAt: null,
    lastError: null,
    lastMessageAt: null,
    lastRedemption: null,
    lastRedemptionAt: null,
    lastRedemptionMatchedHandlers: 0,
    lastRewardEvent: null,
    lastRewardEventAt: null,
    lastRewardEventMatchedHandlers: 0,
    messageCount: 0,
    nextRetryAt: null,
    redemptionCount: 0,
    redemptionHandlerCount: 0,
    redemptionUpdateHandlerCount: 0,
    rewardsEnabled: config.enableRedemptions,
    rewardsLastError: null,
    rewardsNextRetryAt: null,
    rewardEventCount: 0,
    rewardEventHandlerCount: 0,
    rewardsRetryAttempt: 0,
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
      state.broadcasterAuthUserId = auth.broadcasterUserId || null

      api = new twurple.ApiClient({ authProvider })

      const broadcaster = await resolveBroadcaster(api, config)
      state.broadcasterId = broadcaster.id
      state.broadcasterName = broadcaster.name
      if (state.broadcasterAuthUserId && state.broadcasterAuthUserId !== state.broadcasterId) {
        throw new Error('TWITCH_BROADCASTER_REFRESH_TOKEN must belong to TWITCH_CHANNEL')
      }

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
      bindRewardSubscriptions(listener)

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
    resetRewardRetry()
    rewardSubscriptionRegistrars = new Map()
    rewardSubscriptionRetryQueue = new Map()
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
      } else if (userId === state.broadcasterAuthUserId) {
        if (error) state.rewardsLastError = error.message
        logger.warn(`Twitch reward EventSub socket disconnected${error ? `: ${error.message}` : ''}`)
      }
    })

    eventSubListener.onSubscriptionCreateFailure((subscription, error) => {
      if (isRewardSubscription(subscription)) {
        state.rewardsLastError = error.message
        logger.error(`Twitch reward subscription failed (${subscription.id}): ${error.message}`)
        scheduleRewardSubscriptionRetry(subscription)
        return
      }

      state.lastError = error.message
      logger.error(`Twitch EventSub subscription failed (${subscription.id}): ${error.message}`)
      cleanupListener()
      scheduleRetry()
    })

    eventSubListener.onSubscriptionCreateSuccess(subscription => {
      if (isRewardSubscription(subscription)) {
        rewardSubscriptionRetryQueue.delete(subscription.id)
        state.rewardsLastError = null
        if (!rewardSubscriptionRetryQueue.size && !rewardRetryTimer) {
          rewardRetryAttempt = 0
          state.rewardsRetryAttempt = 0
          state.rewardsNextRetryAt = null
        }
      }
    })

    eventSubListener.onRevoke(subscription => {
      if (isRewardSubscription(subscription)) {
        state.rewardsLastError = `Subscription revoked: ${subscription.id}`
        logger.warn(`Twitch reward subscription revoked: ${subscription.id}`)
        scheduleRewardSubscriptionRetry(subscription)
        return
      }

      state.lastError = `Subscription revoked: ${subscription.id}`
      logger.warn(`Twitch EventSub subscription revoked: ${subscription.id}`)
      cleanupListener()
      scheduleRetry()
    })
  }

  function bindRewardSubscriptions(eventSubListener) {
    if (!config.enableRedemptions) return
    if (!state.broadcasterAuthUserId) {
      state.rewardsLastError = 'Broadcaster token is required for Twitch reward events'
      logger.warn(state.rewardsLastError)
      return
    }

    trackRewardSubscription(() => eventSubListener.onChannelRedemptionAdd(state.broadcasterId, event => {
      handleRedemption('redemption.add', event).catch(error => {
        state.rewardsLastError = error.message
        logger.error(`Twitch redemption handler failed: ${error.message}`)
      })
    }))

    if (redemptionUpdateHandlers.length) {
      trackRewardSubscription(() => eventSubListener.onChannelRedemptionUpdate(state.broadcasterId, event => {
        handleRedemption('redemption.update', event).catch(error => {
          state.rewardsLastError = error.message
          logger.error(`Twitch redemption update handler failed: ${error.message}`)
        })
      }))
    }

    if (automaticRedemptionHandlers.length) {
      trackRewardSubscription(() => eventSubListener.onChannelAutomaticRewardRedemptionAddV2(state.broadcasterId, event => {
        handleAutomaticRedemption(event).catch(error => {
          state.rewardsLastError = error.message
          logger.error(`Twitch automatic redemption handler failed: ${error.message}`)
        })
      }))
    }

    if (shouldBindRewardEvent('reward.add')) {
      trackRewardSubscription(() => eventSubListener.onChannelRewardAdd(state.broadcasterId, event => {
        handleRewardEvent('reward.add', event).catch(error => {
          state.rewardsLastError = error.message
          logger.error(`Twitch reward add handler failed: ${error.message}`)
        })
      }))
    }

    if (shouldBindRewardEvent('reward.update')) {
      trackRewardSubscription(() => eventSubListener.onChannelRewardUpdate(state.broadcasterId, event => {
        handleRewardEvent('reward.update', event).catch(error => {
          state.rewardsLastError = error.message
          logger.error(`Twitch reward update handler failed: ${error.message}`)
        })
      }))
    }

    if (shouldBindRewardEvent('reward.remove')) {
      trackRewardSubscription(() => eventSubListener.onChannelRewardRemove(state.broadcasterId, event => {
        handleRewardEvent('reward.remove', event).catch(error => {
          state.rewardsLastError = error.message
          logger.error(`Twitch reward remove handler failed: ${error.message}`)
        })
      }))
    }
  }

  function shouldBindRewardEvent(eventName) {
    return rewardEventHandlers.some(handler => !handler.events.length || handler.events.includes(eventName))
  }

  function trackRewardSubscription(register) {
    const subscription = register()
    rewardSubscriptionRegistrars.set(subscription.id, register)
    return subscription
  }

  function scheduleRewardSubscriptionRetry(subscription) {
    if (!state.enabled || !shouldRun || !listener || !listener.isActive) return

    const register = rewardSubscriptionRegistrars.get(subscription.id)
    if (!register) return

    rewardSubscriptionRetryQueue.set(subscription.id, register)
    if (rewardRetryTimer) return

    rewardRetryAttempt += 1
    const delay = Math.min(
      config.reconnectInitialMs * Math.pow(2, rewardRetryAttempt - 1),
      config.reconnectMaxMs
    )

    state.rewardsRetryAttempt = rewardRetryAttempt
    state.rewardsNextRetryAt = new Date(Date.now() + delay).toISOString()
    logger.warn(`Retrying Twitch reward subscription in ${Math.round(delay / 1000)}s`)

    rewardRetryTimer = setTimeout(() => {
      rewardRetryTimer = null
      retryRewardSubscriptions()
    }, delay)
  }

  function retryRewardSubscriptions() {
    if (!shouldRun || !listener || !listener.isActive) return

    const subscriptions = [...rewardSubscriptionRetryQueue.values()]
    rewardSubscriptionRetryQueue.clear()
    state.rewardsNextRetryAt = null

    for (const register of subscriptions) {
      try {
        trackRewardSubscription(register)
      } catch (error) {
        state.rewardsLastError = error.message
        logger.error(`Twitch reward subscription retry failed: ${error.message}`)
      }
    }
  }

  function resetRewardRetry() {
    if (rewardRetryTimer) clearTimeout(rewardRetryTimer)
    rewardRetryTimer = null
    rewardRetryAttempt = 0
    state.rewardsRetryAttempt = 0
    state.rewardsNextRetryAt = null
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

  async function handleRedemption(eventName, event) {
    const context = createRedemptionContext(eventName, event)
    const handlers = eventName === 'redemption.update' ? redemptionUpdateHandlers : redemptionHandlers
    state.redemptionCount += 1
    state.lastRedemptionAt = new Date().toISOString()
    state.lastRedemption = summarizeRedemptionContext(context)
    state.lastRedemptionMatchedHandlers = await runConfiguredHandlers(handlers, context)
  }

  async function handleAutomaticRedemption(event) {
    const context = createAutomaticRedemptionContext(event)
    state.redemptionCount += 1
    state.lastRedemptionAt = new Date().toISOString()
    state.lastRedemption = summarizeRedemptionContext(context)
    state.lastRedemptionMatchedHandlers = await runConfiguredHandlers(automaticRedemptionHandlers, context)
  }

  async function handleRewardEvent(eventName, event) {
    const context = createRewardEventContext(eventName, event)
    state.rewardEventCount += 1
    state.lastRewardEventAt = new Date().toISOString()
    state.lastRewardEvent = summarizeRewardEventContext(context)
    state.lastRewardEventMatchedHandlers = await runConfiguredHandlers(rewardEventHandlers, context)
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

  async function runConfiguredHandlers(handlers, context) {
    let matchedCount = 0

    for (const handler of handlers) {
      if (!matchesHandler(handler, context)) continue
      if (isCoolingDown(handler, context)) continue
      matchedCount += 1
      logger.log(`Twitch ${context.event} action for ${context.displayName || context.reward.title}`)
      await actions.run(handler.actions, context)
    }

    return matchedCount
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

    const scope = command.cooldownScope === 'user'
      ? (context.userId || (context.chat && context.chat.chatter && context.chat.chatter.id) || 'unknown')
      : 'global'
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
      redemptionHandlers = []
      redemptionUpdateHandlers = []
      automaticRedemptionHandlers = []
      rewardEventHandlers = []
      state.commandCount = 0
      state.redemptionHandlerCount = 0
      state.redemptionUpdateHandlerCount = 0
      state.automaticRedemptionHandlerCount = 0
      state.rewardEventHandlerCount = 0
      state.commandsLastError = null
      logger.warn(`Twitch commands file not found: ${relativePath(config.commandsFile)}`)
      return
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(config.commandsFile, 'utf8'))
      const automationConfig = normalizeAutomationConfig(parsed)
      const nextCommands = automationConfig.commands.map(command => normalizeCommand(command, config.commandPrefix)).filter(Boolean)
      const nextCommandMap = new Map()
      const nextRedemptionHandlers = automationConfig.redemptions.map(handler => normalizeActionHandler(handler, 'redemption.add')).filter(Boolean)
      const nextRedemptionUpdateHandlers = automationConfig.redemptionUpdates.map(handler => normalizeActionHandler(handler, 'redemption.update')).filter(Boolean)
      const nextAutomaticRedemptionHandlers = automationConfig.automaticRedemptions.map(handler => normalizeActionHandler(handler, 'automatic-redemption.add')).filter(Boolean)
      const nextRewardEventHandlers = automationConfig.rewardEvents.map(handler => normalizeActionHandler(handler)).filter(Boolean)

      for (const command of nextCommands) {
        for (const name of command.names) {
          if (nextCommandMap.has(name)) logger.warn(`Duplicate Twitch command ignored: ${name}`)
          else nextCommandMap.set(name, command)
        }
      }

      commands = nextCommands
      commandMap = nextCommandMap
      redemptionHandlers = nextRedemptionHandlers
      redemptionUpdateHandlers = nextRedemptionUpdateHandlers
      automaticRedemptionHandlers = nextAutomaticRedemptionHandlers
      rewardEventHandlers = nextRewardEventHandlers
      state.commandCount = commandMap.size
      state.redemptionHandlerCount = redemptionHandlers.length
      state.redemptionUpdateHandlerCount = redemptionUpdateHandlers.length
      state.automaticRedemptionHandlerCount = automaticRedemptionHandlers.length
      state.rewardEventHandlerCount = rewardEventHandlers.length
      state.commandsLoadedAt = new Date().toISOString()
      state.commandsLastError = null
      logger.log(`Loaded ${state.commandCount} Twitch chat command${state.commandCount === 1 ? '' : 's'} and ${state.redemptionHandlerCount + state.redemptionUpdateHandlerCount + state.automaticRedemptionHandlerCount + state.rewardEventHandlerCount} reward handler${state.redemptionHandlerCount + state.redemptionUpdateHandlerCount + state.automaticRedemptionHandlerCount + state.rewardEventHandlerCount === 1 ? '' : 's'}`)
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

  const botToken = readTokenConfig(config.tokenFile)
  const botAccessToken = cleanAccessToken(botToken.accessToken || config.botAccessToken)
  const botRefreshToken = botToken.refreshToken || config.botRefreshToken
  const botExpiresIn = botToken.expiresIn || config.botExpiresIn
  const botObtainmentTimestamp = botToken.obtainmentTimestamp || config.botObtainmentTimestamp
  const botScope = botToken.scope || config.botScopes

  if (config.enableRedemptions) {
    if (!config.clientSecret) {
      throw new Error('TWITCH_CLIENT_SECRET is required when CHAT_ENABLE_REDEMPTIONS=true')
    }

    if (!botRefreshToken) {
      throw new Error('TWITCH_BOT_REFRESH_TOKEN is required when CHAT_ENABLE_REDEMPTIONS=true')
    }

    const broadcasterToken = readTokenConfig(config.broadcasterTokenFile)
    const broadcasterAccessToken = cleanAccessToken(broadcasterToken.accessToken || config.broadcasterAccessToken)
    const broadcasterRefreshToken = broadcasterToken.refreshToken || config.broadcasterRefreshToken
    const broadcasterExpiresIn = broadcasterToken.expiresIn || config.broadcasterExpiresIn
    const broadcasterObtainmentTimestamp = broadcasterToken.obtainmentTimestamp || config.broadcasterObtainmentTimestamp
    const broadcasterScope = broadcasterToken.scope || config.broadcasterScopes

    if (!broadcasterRefreshToken) {
      throw new Error('TWITCH_BROADCASTER_REFRESH_TOKEN is required when CHAT_ENABLE_REDEMPTIONS=true')
    }

    const authProvider = new twurple.RefreshingAuthProvider({
      clientId: config.clientId,
      clientSecret: config.clientSecret
    })

    const tokenFilesByUserId = new Map()
    let refreshTokenFile = config.tokenFile

    authProvider.onRefresh((userId, refreshedToken) => {
      persistToken(tokenFilesByUserId.get(userId) || refreshTokenFile, userId, refreshedToken, logger)
    })

    authProvider.onRefreshFailure((userId, error) => {
      logger.error(`Twitch token refresh failed for ${userId}: ${error.message}`)
    })

    refreshTokenFile = config.tokenFile
    const botUserId = await authProvider.addUserForToken(buildRefreshingToken({
      accessToken: botAccessToken,
      expiresIn: botExpiresIn,
      obtainmentTimestamp: botObtainmentTimestamp,
      refreshToken: botRefreshToken,
      scope: botScope
    }), [CHAT_INTENT])
    tokenFilesByUserId.set(botUserId, config.tokenFile)

    refreshTokenFile = config.broadcasterTokenFile
    const broadcasterUserId = await authProvider.addUserForToken(buildRefreshingToken({
      accessToken: broadcasterAccessToken,
      expiresIn: broadcasterExpiresIn,
      obtainmentTimestamp: broadcasterObtainmentTimestamp,
      refreshToken: broadcasterRefreshToken,
      scope: broadcasterScope
    }), [REDEMPTION_INTENT])
    tokenFilesByUserId.set(broadcasterUserId, config.broadcasterTokenFile)

    warnMissingScopes(authProvider.getCurrentScopesForUser(botUserId), REQUIRED_SCOPES, logger)
    warnMissingAnyScope(authProvider.getCurrentScopesForUser(broadcasterUserId), REDEMPTION_SCOPES, logger, 'Twitch broadcaster')

    return { authProvider, botUserId, broadcasterUserId, mode: 'refreshing' }
  }

  if (botRefreshToken) {
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

    const botUserId = await authProvider.addUserForToken(buildRefreshingToken({
      accessToken: botAccessToken,
      expiresIn: botExpiresIn,
      obtainmentTimestamp: botObtainmentTimestamp,
      refreshToken: botRefreshToken,
      scope: botScope
    }), [CHAT_INTENT])

    warnMissingScopes(authProvider.getCurrentScopesForUser(botUserId), REQUIRED_SCOPES, logger)

    return { authProvider, botUserId, mode: 'refreshing' }
  }

  if (!botAccessToken) {
    throw new Error('TWITCH_BOT_ACCESS_TOKEN and TWITCH_BOT_REFRESH_TOKEN are required when CHAT_ENABLED=true')
  }

  const authProvider = new twurple.StaticAuthProvider(config.clientId, botAccessToken)
  const tokenInfo = await twurple.getTokenInfo(botAccessToken)
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

function createRedemptionContext(eventName, event) {
  const input = event.input || ''
  const redeemedAt = dateToIso(event.redemptionDate)

  return {
    broadcaster: event.broadcasterName,
    broadcasterDisplayName: event.broadcasterDisplayName,
    broadcasterId: event.broadcasterId,
    displayName: event.userDisplayName,
    event: eventName,
    input,
    message: input,
    redemption: {
      id: event.id,
      input,
      redeemedAt,
      rewardId: event.rewardId,
      status: event.status
    },
    reward: {
      cost: event.rewardCost,
      id: event.rewardId,
      prompt: event.rewardPrompt,
      title: event.rewardTitle
    },
    source: 'redemption',
    user: event.userName,
    userId: event.userId,
    username: event.userName
  }
}

function createAutomaticRedemptionContext(event) {
  const reward = event.reward
  const message = event.messageText || ''
  const redeemedAt = dateToIso(event.redemptionDate)

  return {
    automaticReward: {
      channelPoints: reward.channelPoints,
      emote: reward.emote,
      type: reward.type
    },
    broadcaster: event.broadcasterName,
    broadcasterDisplayName: event.broadcasterDisplayName,
    broadcasterId: event.broadcasterId,
    displayName: event.userDisplayName,
    event: 'automatic-redemption.add',
    input: message,
    message,
    redemption: {
      id: event.id,
      input: message,
      redeemedAt,
      rewardType: reward.type,
      status: 'fulfilled'
    },
    reward: {
      cost: reward.channelPoints,
      id: reward.type,
      prompt: '',
      title: reward.type,
      type: reward.type
    },
    source: 'automatic-redemption',
    user: event.userName,
    userId: event.userId,
    username: event.userName
  }
}

function createRewardEventContext(eventName, event) {
  return {
    broadcaster: event.broadcasterName,
    broadcasterDisplayName: event.broadcasterDisplayName,
    broadcasterId: event.broadcasterId,
    displayName: event.broadcasterDisplayName,
    event: eventName,
    message: event.title,
    reward: {
      autoApproved: event.autoApproved,
      backgroundColor: event.backgroundColor,
      cost: event.cost,
      globalCooldown: event.globalCooldown,
      id: event.id,
      isEnabled: event.isEnabled,
      isInStock: event.isInStock,
      isPaused: event.isPaused,
      maxRedemptionsPerStream: event.maxRedemptionsPerStream,
      maxRedemptionsPerUserPerStream: event.maxRedemptionsPerUserPerStream,
      prompt: event.prompt,
      redemptionsThisStream: event.redemptionsThisStream,
      title: event.title,
      userInputRequired: event.userInputRequired
    },
    source: 'reward',
    user: event.broadcasterName,
    userId: event.broadcasterId,
    username: event.broadcasterName
  }
}

function summarizeRedemptionContext(context) {
  return {
    automaticReward: context.automaticReward || null,
    displayName: context.displayName,
    event: context.event,
    input: context.input || '',
    redeemedAt: context.redemption && context.redemption.redeemedAt,
    redemptionId: context.redemption && context.redemption.id,
    reward: context.reward,
    status: context.redemption && context.redemption.status,
    user: context.user,
    userId: context.userId
  }
}

function summarizeRewardEventContext(context) {
  return {
    event: context.event,
    reward: context.reward
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

function isRewardSubscription(subscription) {
  return String(subscription.id || '').startsWith('channel.channel_points_')
}

function matchesHandler(handler, context) {
  if (handler.events.length && !handler.events.includes(context.event)) return false

  const rewardId = normalizeMatchValue(context.reward && context.reward.id)
  const rewardTitle = normalizeMatchValue(context.reward && context.reward.title)
  const rewardType = normalizeMatchValue(
    (context.automaticReward && context.automaticReward.type) ||
    (context.reward && context.reward.type)
  )
  const status = normalizeMatchValue(context.redemption && context.redemption.status)
  const userId = normalizeMatchValue(context.userId)
  const username = normalizeMatchValue(context.username || context.user)
  const displayName = normalizeMatchValue(context.displayName)
  const input = normalizeMatchValue(context.input || context.message)

  if (handler.rewardIds.length && !handler.rewardIds.includes(rewardId)) return false
  if (handler.rewardTitles.length && !handler.rewardTitles.includes(rewardTitle)) return false
  if (handler.rewardTypes.length && !handler.rewardTypes.includes(rewardType)) return false
  if (handler.statuses.length && !handler.statuses.includes(status)) return false
  if (handler.userIds.length && !handler.userIds.includes(userId)) return false
  if (handler.usernames.length && !handler.usernames.includes(username) && !handler.usernames.includes(displayName)) return false
  if (handler.inputContains.length && !handler.inputContains.some(value => input.includes(value))) return false
  if (handler.inputPatterns.length && !handler.inputPatterns.some(pattern => testRegex(pattern, context.input || context.message || ''))) return false

  return true
}

function testRegex(pattern, value) {
  pattern.lastIndex = 0
  return pattern.test(value)
}

function warnMissingScopes(actualScopes, requiredScopes, logger) {
  const actual = new Set(actualScopes || [])
  const missing = requiredScopes.filter(scope => !actual.has(scope))
  if (missing.length) {
    logger.warn(`Twitch bot token is missing recommended scope${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`)
  }
}

function warnMissingAnyScope(actualScopes, acceptedScopes, logger, label) {
  const actual = new Set(actualScopes || [])
  if (!acceptedScopes.some(scope => actual.has(scope))) {
    logger.warn(`${label} token is missing one of these scopes: ${acceptedScopes.join(', ')}`)
  }
}

function normalizeAutomationConfig(parsed) {
  if (Array.isArray(parsed)) {
    return {
      automaticRedemptions: [],
      commands: parsed,
      redemptions: [],
      redemptionUpdates: [],
      rewardEvents: []
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('commands.json must contain an array or an object')
  }

  return {
    automaticRedemptions: asArray(parsed.automaticRedemptions || parsed.automaticRewards),
    commands: asArray(parsed.commands),
    redemptions: asArray(parsed.redemptions || parsed.rewardRedemptions),
    redemptionUpdates: asArray(parsed.redemptionUpdates),
    rewardEvents: asArray(parsed.rewardEvents)
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

function normalizeActionHandler(handler, defaultEvent) {
  if (!handler || typeof handler !== 'object' || handler.enabled === false) return null
  if (!handler.actions) return null

  const match = handler.match && typeof handler.match === 'object' ? handler.match : {}
  const events = normalizeEventList(match.event || match.events || handler.event || handler.events || defaultEvent)
  const rewardIds = normalizeMatchList(match.rewardId || match.rewardIds || handler.rewardId || handler.rewardIds || handler.id)
  const rewardTitles = normalizeMatchList(match.rewardTitle || match.rewardTitles || match.title || match.titles || handler.rewardTitle || handler.rewardTitles || handler.title)
  const rewardTypes = normalizeMatchList(match.rewardType || match.rewardTypes || match.type || match.types || handler.rewardType || handler.rewardTypes || handler.type)
  const statuses = normalizeMatchList(match.status || match.statuses || handler.status || handler.statuses)
  const userIds = normalizeMatchList(match.userId || match.userIds || handler.userId || handler.userIds)
  const usernames = normalizeMatchList(match.username || match.usernames || match.userName || match.userNames || match.displayName || match.displayNames || handler.username || handler.usernames || handler.userName || handler.userNames || handler.displayName || handler.displayNames)
  const inputContains = normalizeMatchList(match.inputContains || match.messageContains || handler.inputContains || handler.messageContains)
  const inputPatterns = normalizeRegexList(match.inputMatches || match.messageMatches || match.inputPattern || handler.inputMatches || handler.messageMatches || handler.inputPattern)
  const name = normalizeMatchValue(match.name || handler.name)
  const keyParts = [
    events.join(',') || defaultEvent || 'reward',
    name,
    rewardIds.join(','),
    rewardTitles.join(','),
    rewardTypes.join(','),
    statuses.join(','),
    userIds.join(','),
    usernames.join(','),
    inputContains.join(','),
    inputPatterns.map(pattern => pattern.source).join(',')
  ].filter(Boolean)

  return {
    actions: handler.actions,
    cooldownScope: handler.cooldownScope === 'user' ? 'user' : 'global',
    cooldownSeconds: Number(handler.cooldownSeconds || 0),
    events,
    key: keyParts.join(':'),
    inputContains,
    inputPatterns,
    name,
    rewardIds,
    rewardTitles,
    rewardTypes,
    statuses,
    userIds,
    usernames
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

function normalizeMatchList(value) {
  return asArray(value).map(normalizeMatchValue).filter(Boolean)
}

function normalizeMatchValue(value) {
  return String(value || '').trim().toLowerCase()
}

function normalizeRegexList(value) {
  return asArray(value).map(normalizeRegex).filter(Boolean)
}

function normalizeRegex(value) {
  if (value instanceof RegExp) return value

  const text = String(value || '').trim()
  if (!text) return null

  try {
    const match = text.match(/^\/(.+)\/([dgimsuvy]*)$/)
    if (match) return new RegExp(match[1], match[2])
    return new RegExp(text, 'i')
  } catch (error) {
    throw new Error(`Invalid redemption input pattern "${text}": ${error.message}`)
  }
}

function normalizeEventList(value) {
  return asArray(value).map(normalizeEventName).filter(Boolean)
}

function normalizeEventName(value) {
  const normalized = normalizeMatchValue(value).replace(/_/g, '.')
  const aliases = {
    add: 'reward.add',
    automatic: 'automatic-redemption.add',
    automaticRedemption: 'automatic-redemption.add',
    automaticredemption: 'automatic-redemption.add',
    redemption: 'redemption.add',
    redeemed: 'redemption.add',
    remove: 'reward.remove',
    update: 'reward.update'
  }

  return aliases[normalized] || normalized
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

function asArray(value) {
  if (value === undefined || value === null || value === '') return []
  return Array.isArray(value) ? value : [value]
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
    broadcasterAccessToken: process.env.TWITCH_BROADCASTER_ACCESS_TOKEN,
    broadcasterExpiresIn: numberOrUndefined(process.env.TWITCH_BROADCASTER_EXPIRES_IN),
    broadcasterId,
    broadcasterLogin: normalizeLogin(broadcasterLogin),
    broadcasterObtainmentTimestamp: numberOrUndefined(process.env.TWITCH_BROADCASTER_OBTAINMENT_TIMESTAMP),
    broadcasterRefreshToken: process.env.TWITCH_BROADCASTER_REFRESH_TOKEN,
    broadcasterScopes: parseScopes(process.env.TWITCH_BROADCASTER_SCOPES),
    broadcasterTokenFile: resolveAppPath(process.env.TWITCH_BROADCASTER_TOKEN_FILE, DEFAULT_BROADCASTER_TOKEN_FILE),
    clientId: process.env.TWITCH_CLIENT_ID,
    clientSecret: process.env.TWITCH_CLIENT_SECRET,
    commandPrefix: process.env.CHAT_COMMAND_PREFIX || DEFAULT_COMMAND_PREFIX,
    commandsFile: resolveAppPath(process.env.CHAT_COMMANDS_FILE, DEFAULT_COMMANDS_FILE),
    defaultAlertSound: process.env.DEFAULT_ALERT_SOUND || 'kitt_scanner.mp3',
    enableHighlightAlerts: parseBool(process.env.CHAT_ENABLE_HIGHLIGHT_ALERTS, false),
    enableRedemptions: parseBool(process.env.CHAT_ENABLE_REDEMPTIONS, Boolean(process.env.TWITCH_BROADCASTER_REFRESH_TOKEN)),
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

function buildRefreshingToken({ accessToken, expiresIn, obtainmentTimestamp, refreshToken, scope }) {
  return {
    accessToken: expiresIn !== undefined && obtainmentTimestamp !== undefined ? accessToken : undefined,
    expiresIn,
    obtainmentTimestamp,
    refreshToken,
    scope
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

function dateToIso(value) {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
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
  REDEMPTION_SCOPES,
  REQUIRED_SCOPES
}
