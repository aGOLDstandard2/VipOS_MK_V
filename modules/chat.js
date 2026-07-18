const fs = require('fs')
const path = require('path')
const { normalizeRegex, testRegex } = require('./chat-regex')

const CHAT_INTENT = 'chat'
const BROADCASTER_INTENT = 'broadcaster'
const DEFAULT_COMMAND_PREFIX = '!'
const DEFAULT_TOKEN_FILE = path.join(__dirname, '..', 'config', 'twitch-token.json')
const DEFAULT_BROADCASTER_TOKEN_FILE = path.join(__dirname, '..', 'config', 'twitch-broadcaster-token.json')
const DEFAULT_COMMANDS_FILE = path.join(__dirname, '..', 'config', 'commands.json')
const DEFAULT_RECONNECT_INITIAL_MS = 5000
const DEFAULT_RECONNECT_MAX_MS = 60000
const CHAT_SCOPES = ['user:read:chat', 'user:write:chat']
const REDEMPTION_SCOPES = ['channel:read:redemptions', 'channel:manage:redemptions']
const FOLLOW_SCOPES = ['moderator:read:followers']
const SUBSCRIPTION_SCOPES = ['channel:read:subscriptions']

let twurpleModules = null

function createChatService({ actions, actionQueue = null, logger = console, raffle = null } = {}) {
  if (!actions) throw new Error('Chat service requires an action runner')

  const config = readConfig()
  const cooldowns = new Map()

  let api = null
  let authProvider = null
  let automaticRedemptionHandlers = []
  let chatEntryHandlers = []
  let commandMap = new Map()
  let commandWatcherStarted = false
  let commands = []
  let followHandlers = []
  let listener = null
  let raidHandlers = []
  let redemptionHandlers = []
  let redemptionUpdateHandlers = []
  let rewardRetryAttempt = 0
  let rewardRetryTimer = null
  let retryAttempt = 0
  let retryTimer = null
  let rewardEventHandlers = []
  let subscriptionHandlers = []
  let subscribedEventSubHandlerGroups = new Set()
  let rewardSubscriptionRegistrars = new Map()
  let rewardSubscriptionRetryQueue = new Map()
  let shouldRun = false
  let started = false
  let starting = false
  const seenChatEntrants = new Set()

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
    commandsRestartRequiredMessage: null,
    automaticRedemptionHandlerCount: 0,
    chatEntryCount: 0,
    chatEntryHandlerCount: 0,
    communityEventCount: 0,
    communityEventHandlerCount: 0,
    simulating: false,
    followHandlerCount: 0,
    lastCommandAt: null,
    lastChatEntry: null,
    lastChatEntryAt: null,
    lastChatEntryMatchedHandlers: 0,
    lastCommunityEvent: null,
    lastCommunityEventAt: null,
    lastCommunityEventMatchedHandlers: 0,
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
    raidHandlerCount: 0,
    redemptionCount: 0,
    redemptionHandlerCount: 0,
    redemptionUpdateHandlerCount: 0,
    rewardsEnabled: config.enableRedemptions,
    rewardsLastError: null,
    rewardsNextRetryAt: null,
    rewardEventCount: 0,
    rewardEventHandlerCount: 0,
    rewardsRetryAttempt: 0,
    subscriptionHandlerCount: 0,
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
      const auth = await createAuthProvider(twurple, config, logger, getEventSubAuthRequirements({
        config,
        followHandlers,
        subscriptionHandlers
      }))
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
      subscribedEventSubHandlerGroups = new Set([
        ...bindRewardSubscriptions(listener),
        ...bindCommunitySubscriptions(listener)
      ])
      state.commandsRestartRequiredMessage = null

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
      if (!isNonRetryableStartupError(error)) {
        scheduleRetry()
      }
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
    if (options.simulated || state.simulating) {
      const text = String(message || '').trim()
      if (!text) throw new Error('chat.say requires a message')
      logger.log(`Simulated Twitch chat message: ${text}`)
      return {
        id: `simulated-${Date.now()}`,
        isSent: true,
        simulated: true
      }
    }

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
    const subscribedGroups = new Set()

    if (!config.enableRedemptions) return subscribedGroups
    if (!state.broadcasterAuthUserId) {
      state.rewardsLastError = 'Broadcaster token is required for Twitch reward events'
      logger.warn(state.rewardsLastError)
      return subscribedGroups
    }

    trackRewardSubscription(() => eventSubListener.onChannelRedemptionAdd(state.broadcasterId, event => {
      handleRedemption('redemption.add', event).catch(error => {
        state.rewardsLastError = error.message
        logger.error(`Twitch redemption handler failed: ${error.message}`)
      })
    }))
    subscribedGroups.add('redemptions')

    if (redemptionUpdateHandlers.length) {
      trackRewardSubscription(() => eventSubListener.onChannelRedemptionUpdate(state.broadcasterId, event => {
        handleRedemption('redemption.update', event).catch(error => {
          state.rewardsLastError = error.message
          logger.error(`Twitch redemption update handler failed: ${error.message}`)
        })
      }))
      subscribedGroups.add('redemption updates')
    }

    if (automaticRedemptionHandlers.length) {
      trackRewardSubscription(() => eventSubListener.onChannelAutomaticRewardRedemptionAddV2(state.broadcasterId, event => {
        handleAutomaticRedemption(event).catch(error => {
          state.rewardsLastError = error.message
          logger.error(`Twitch automatic redemption handler failed: ${error.message}`)
        })
      }))
      subscribedGroups.add('automatic redemptions')
    }

    if (shouldBindRewardEvent('reward.add')) {
      trackRewardSubscription(() => eventSubListener.onChannelRewardAdd(state.broadcasterId, event => {
        handleRewardEvent('reward.add', event).catch(error => {
          state.rewardsLastError = error.message
          logger.error(`Twitch reward add handler failed: ${error.message}`)
        })
      }))
      subscribedGroups.add('reward add events')
    }

    if (shouldBindRewardEvent('reward.update')) {
      trackRewardSubscription(() => eventSubListener.onChannelRewardUpdate(state.broadcasterId, event => {
        handleRewardEvent('reward.update', event).catch(error => {
          state.rewardsLastError = error.message
          logger.error(`Twitch reward update handler failed: ${error.message}`)
        })
      }))
      subscribedGroups.add('reward update events')
    }

    if (shouldBindRewardEvent('reward.remove')) {
      trackRewardSubscription(() => eventSubListener.onChannelRewardRemove(state.broadcasterId, event => {
        handleRewardEvent('reward.remove', event).catch(error => {
          state.rewardsLastError = error.message
          logger.error(`Twitch reward remove handler failed: ${error.message}`)
        })
      }))
      subscribedGroups.add('reward remove events')
    }

    return subscribedGroups
  }

  function bindCommunitySubscriptions(eventSubListener) {
    const subscribedGroups = new Set()

    if (followHandlers.length) {
      if (!state.broadcasterAuthUserId) {
        state.lastError = 'Broadcaster token is required for Twitch follow events'
        logger.warn(state.lastError)
      } else {
        eventSubListener.onChannelFollow(state.broadcasterId, state.broadcasterAuthUserId, event => {
          handleFollow(event).catch(error => {
            state.lastError = error.message
            logger.error(`Twitch follow handler failed: ${error.message}`)
          })
        })
        subscribedGroups.add('follows')
      }
    }

    if (raidHandlers.length) {
      eventSubListener.onChannelRaidTo(state.broadcasterId, event => {
        handleRaid(event).catch(error => {
          state.lastError = error.message
          logger.error(`Twitch raid handler failed: ${error.message}`)
        })
      })
      subscribedGroups.add('raids')
    }

    if (subscriptionHandlers.length) {
      eventSubListener.onChannelSubscription(state.broadcasterId, event => {
        handleSubscription(event).catch(error => {
          state.lastError = error.message
          logger.error(`Twitch subscription handler failed: ${error.message}`)
        })
      })
      eventSubListener.onChannelSubscriptionGift(state.broadcasterId, event => {
        handleSubscriptionGift(event).catch(error => {
          state.lastError = error.message
          logger.error(`Twitch subscription gift handler failed: ${error.message}`)
        })
      })
      subscribedGroups.add('subscriptions')
    }

    return subscribedGroups
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

    const chatEntryKey = getPrivilegedChatEntryKey(context, chatEntryHandlers, seenChatEntrants)
    if (chatEntryKey) {
      seenChatEntrants.add(chatEntryKey)
      try {
        await handleChatEntry(context)
      } catch (error) {
        seenChatEntrants.delete(chatEntryKey)
        throw error
      }
    }

    if (raffle && await raffle.handleChatMessage(context)) return

    const commandMatch = findCommand(context.message)
    if (!commandMatch) return

    await runCommand(commandMatch, context)
  }

  async function handleChatEntry(messageContext) {
    const context = createChatEntryContext(messageContext)
    state.chatEntryCount += 1
    state.lastChatEntryAt = new Date().toISOString()
    state.lastChatEntry = summarizeChatEntryContext(context)
    state.lastChatEntryMatchedHandlers = await runConfiguredHandlers(chatEntryHandlers, context)
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

  async function handleFollow(event) {
    const context = createFollowContext(event)
    state.communityEventCount += 1
    state.lastCommunityEventAt = new Date().toISOString()
    state.lastCommunityEvent = summarizeCommunityEventContext(context)
    state.lastCommunityEventMatchedHandlers = await runConfiguredHandlers(followHandlers, context)
  }

  async function handleRaid(event) {
    const context = createRaidContext(event)
    state.communityEventCount += 1
    state.lastCommunityEventAt = new Date().toISOString()
    state.lastCommunityEvent = summarizeCommunityEventContext(context)
    state.lastCommunityEventMatchedHandlers = await runConfiguredHandlers(raidHandlers, context)
  }

  async function handleSubscription(event) {
    const context = createSubscriptionContext(event)
    state.communityEventCount += 1
    state.lastCommunityEventAt = new Date().toISOString()
    state.lastCommunityEvent = summarizeCommunityEventContext(context)
    state.lastCommunityEventMatchedHandlers = await runConfiguredHandlers(subscriptionHandlers, context)
  }

  async function handleSubscriptionGift(event) {
    const context = createSubscriptionGiftContext(event)
    state.communityEventCount += 1
    state.lastCommunityEventAt = new Date().toISOString()
    state.lastCommunityEvent = summarizeCommunityEventContext(context)
    state.lastCommunityEventMatchedHandlers = await runConfiguredHandlers(subscriptionHandlers, context)
  }

  async function simulateEvent(type, event) {
    state.simulating = true
    await loadCommands()

    const normalizedType = normalizeEventName(type)
    try {
      switch (normalizedType) {
        case 'follow.add':
          return await handleFollow(event)
        case 'raid.add':
          return await handleRaid(event)
        case 'subscription.add':
          return await handleSubscription(event)
        case 'subscription.gift':
          return await handleSubscriptionGift(event)
        default:
          throw new Error(`Unsupported simulated Twitch event: ${type}`)
      }
    } finally {
      state.simulating = false
    }
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
    await runTwitchActions(`Twitch Command ${commandName}`, command.actions, commandContext)
  }

  async function runConfiguredHandlers(handlers, context) {
    let matchedCount = 0

    for (const handler of handlers) {
      if (!matchesHandler(handler, context)) continue
      if (isCoolingDown(handler, context)) continue
      matchedCount += 1
      logger.log(`Twitch ${context.event} action for ${context.displayName || context.reward.title}`)
      await runTwitchActions(formatHandlerQueueName(handler, context), handler.actions, context)
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

    await runTwitchActions('Twitch Highlight Alert', actionList, context)
  }

  async function runTwitchActions(name, actionList, context) {
    if (!actionQueue) return actions.run(actionList, context)

    return actionQueue.enqueue({
      name,
      actions: actionList,
      context: state.simulating ? { ...context, simulated: true } : context,
      source: context.source || 'twitch'
    })
  }

  function formatHandlerQueueName(handler, context) {
    const parts = ['Twitch', context.event || 'event']
    if (handler.name) parts.push(handler.name)
    return parts.join(' ')
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
      chatEntryHandlers = []
      followHandlers = []
      raidHandlers = []
      subscriptionHandlers = []
      redemptionHandlers = []
      redemptionUpdateHandlers = []
      automaticRedemptionHandlers = []
      rewardEventHandlers = []
      state.commandCount = 0
      state.chatEntryHandlerCount = 0
      state.communityEventHandlerCount = 0
      state.followHandlerCount = 0
      state.raidHandlerCount = 0
      state.subscriptionHandlerCount = 0
      state.redemptionHandlerCount = 0
      state.redemptionUpdateHandlerCount = 0
      state.automaticRedemptionHandlerCount = 0
      state.rewardEventHandlerCount = 0
      state.commandsLastError = null
      updateCommandsRestartRequirement()
      logger.warn(`Twitch commands file not found: ${relativePath(config.commandsFile)}`)
      return
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(config.commandsFile, 'utf8'))
      const automationConfig = normalizeAutomationConfig(parsed)
      const nextCommands = automationConfig.commands.map(command => normalizeCommand(command, config.commandPrefix)).filter(Boolean)
      const nextCommandMap = new Map()
      const nextChatEntryHandlers = automationConfig.chatEntries.map(handler => normalizeActionHandler(handler, 'chat.entry')).filter(Boolean)
      const nextFollowHandlers = automationConfig.follows.map(handler => normalizeActionHandler(handler, 'follow.add')).filter(Boolean)
      const nextRaidHandlers = automationConfig.raids.map(handler => normalizeActionHandler(handler, 'raid.add')).filter(Boolean)
      const nextSubscriptionHandlers = automationConfig.subscriptions.map(handler => normalizeActionHandler(handler, ['subscription.add', 'subscription.gift'])).filter(Boolean)
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
      chatEntryHandlers = nextChatEntryHandlers
      followHandlers = nextFollowHandlers
      raidHandlers = nextRaidHandlers
      subscriptionHandlers = nextSubscriptionHandlers
      redemptionHandlers = nextRedemptionHandlers
      redemptionUpdateHandlers = nextRedemptionUpdateHandlers
      automaticRedemptionHandlers = nextAutomaticRedemptionHandlers
      rewardEventHandlers = nextRewardEventHandlers
      state.commandCount = commandMap.size
      state.chatEntryHandlerCount = chatEntryHandlers.length
      state.followHandlerCount = followHandlers.length
      state.raidHandlerCount = raidHandlers.length
      state.subscriptionHandlerCount = subscriptionHandlers.length
      state.communityEventHandlerCount = chatEntryHandlers.length + followHandlers.length + raidHandlers.length + subscriptionHandlers.length
      state.redemptionHandlerCount = redemptionHandlers.length
      state.redemptionUpdateHandlerCount = redemptionUpdateHandlers.length
      state.automaticRedemptionHandlerCount = automaticRedemptionHandlers.length
      state.rewardEventHandlerCount = rewardEventHandlers.length
      state.commandsLoadedAt = new Date().toISOString()
      state.commandsLastError = null
      const rewardHandlerCount = state.redemptionHandlerCount + state.redemptionUpdateHandlerCount + state.automaticRedemptionHandlerCount + state.rewardEventHandlerCount
      logger.log(`Loaded ${state.commandCount} Twitch chat command${state.commandCount === 1 ? '' : 's'}, ${rewardHandlerCount} reward handler${rewardHandlerCount === 1 ? '' : 's'}, and ${state.communityEventHandlerCount} community event handler${state.communityEventHandlerCount === 1 ? '' : 's'}`)
      updateCommandsRestartRequirement()
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

  function updateCommandsRestartRequirement() {
    if (!started || !listener) {
      state.commandsRestartRequiredMessage = null
      return
    }

    const missingGroups = getMissingEventSubHandlerGroups()
    const message = missingGroups.length
      ? `Restart required for newly configured Twitch EventSub handlers: ${missingGroups.join(', ')}. Config hot reload updated the handlers, but Twitch EventSub subscriptions are created only at startup.`
      : null

    if (message && message !== state.commandsRestartRequiredMessage) {
      logger.warn(message)
    }

    state.commandsRestartRequiredMessage = message
  }

  function getMissingEventSubHandlerGroups() {
    return getUnsubscribedEventSubHandlerGroups(
      getCurrentConfiguredEventSubHandlerGroups(),
      subscribedEventSubHandlerGroups
    )
  }

  function getCurrentConfiguredEventSubHandlerGroups() {
    return getConfiguredEventSubHandlerGroups({
      automaticRedemptionHandlerCount: automaticRedemptionHandlers.length,
      followHandlerCount: followHandlers.length,
      raidHandlerCount: raidHandlers.length,
      redemptionHandlerCount: redemptionHandlers.length,
      redemptionUpdateHandlerCount: redemptionUpdateHandlers.length,
      rewardAddEventHandlerCount: shouldBindRewardEvent('reward.add') ? 1 : 0,
      rewardRemoveEventHandlerCount: shouldBindRewardEvent('reward.remove') ? 1 : 0,
      rewardUpdateEventHandlerCount: shouldBindRewardEvent('reward.update') ? 1 : 0,
      subscriptionHandlerCount: subscriptionHandlers.length
    })
  }

  return {
    getStatus,
    say,
    simulateEvent,
    start,
    stop
  }
}

async function createAuthProvider(twurple, config, logger, options = {}) {
  if (!config.clientId) throw new ChatConfigError('TWITCH_CLIENT_ID is required when CHAT_ENABLED=true')
  const needsBroadcasterToken = Boolean(options.needsBroadcasterToken)
  const needsFollowScopes = Boolean(options.needsFollowScopes)
  const needsSubscriptionScopes = Boolean(options.needsSubscriptionScopes)

  const botToken = readTokenConfig(config.tokenFile)
  const botAccessToken = cleanAccessToken(botToken.accessToken || config.botAccessToken)
  const botRefreshToken = botToken.refreshToken || config.botRefreshToken
  const botExpiresIn = botToken.expiresIn || config.botExpiresIn
  const botObtainmentTimestamp = botToken.obtainmentTimestamp || config.botObtainmentTimestamp
  const botScope = botToken.scope || config.botScopes

  if (needsBroadcasterToken) {
    if (!config.clientSecret) {
      throw new ChatConfigError('TWITCH_CLIENT_SECRET is required when broadcaster EventSub auth is needed')
    }

    if (!botRefreshToken) {
      throw new ChatConfigError('TWITCH_BOT_REFRESH_TOKEN is required when broadcaster EventSub auth is needed')
    }

    const broadcasterToken = readTokenConfig(config.broadcasterTokenFile)
    const broadcasterAccessToken = cleanAccessToken(broadcasterToken.accessToken || config.broadcasterAccessToken)
    const broadcasterRefreshToken = broadcasterToken.refreshToken || config.broadcasterRefreshToken
    const broadcasterExpiresIn = broadcasterToken.expiresIn || config.broadcasterExpiresIn
    const broadcasterObtainmentTimestamp = broadcasterToken.obtainmentTimestamp || config.broadcasterObtainmentTimestamp
    const broadcasterScope = broadcasterToken.scope || config.broadcasterScopes

    if (!broadcasterRefreshToken) {
      throw new ChatConfigError('TWITCH_BROADCASTER_REFRESH_TOKEN is required when broadcaster EventSub auth is needed')
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
    }), [BROADCASTER_INTENT])
    tokenFilesByUserId.set(broadcasterUserId, config.broadcasterTokenFile)

    warnMissingScopes(authProvider.getCurrentScopesForUser(botUserId), CHAT_SCOPES, logger)
    const broadcasterScopes = authProvider.getCurrentScopesForUser(broadcasterUserId)
    if (config.enableRedemptions) {
      warnMissingAnyScope(broadcasterScopes, REDEMPTION_SCOPES, logger, 'Twitch broadcaster')
    }
    if (needsFollowScopes) {
      warnMissingScopes(broadcasterScopes, FOLLOW_SCOPES, logger, 'Twitch broadcaster token')
    }
    if (needsSubscriptionScopes) {
      warnMissingScopes(broadcasterScopes, SUBSCRIPTION_SCOPES, logger, 'Twitch broadcaster token')
    }

    return { authProvider, botUserId, broadcasterUserId, mode: 'refreshing' }
  }

  if (botRefreshToken) {
    if (!config.clientSecret) {
      throw new ChatConfigError('TWITCH_CLIENT_SECRET is required when using TWITCH_BOT_REFRESH_TOKEN')
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

    warnMissingScopes(authProvider.getCurrentScopesForUser(botUserId), CHAT_SCOPES, logger)

    return { authProvider, botUserId, mode: 'refreshing' }
  }

  if (!botAccessToken) {
    throw new ChatConfigError('TWITCH_BOT_ACCESS_TOKEN and TWITCH_BOT_REFRESH_TOKEN are required when CHAT_ENABLED=true')
  }

  const authProvider = new twurple.StaticAuthProvider(config.clientId, botAccessToken)
  const tokenInfo = await twurple.getTokenInfo(botAccessToken)
  const botUserId = config.botUserId || tokenInfo.userId
  if (!botUserId) throw new Error('Unable to determine Twitch bot user ID from token')

  warnMissingScopes(tokenInfo.scopes, CHAT_SCOPES, logger)
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

function createChatEntryContext(context) {
  const entryRoles = getPrivilegedEntryRoles(context.roles)
  const role = entryRoles[0] || ''

  return {
    ...context,
    chat: {
      ...context.chat,
      entryRoles,
      role
    },
    entry: {
      firstSeenAt: new Date().toISOString(),
      roles: entryRoles,
      role
    },
    event: 'chat.entry',
    message: `${context.displayName} entered chat`,
    source: 'chat-entry'
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

function createFollowContext(event) {
  const followedAt = dateToIso(event.followDate)

  return {
    broadcaster: event.broadcasterName,
    broadcasterDisplayName: event.broadcasterDisplayName,
    broadcasterId: event.broadcasterId,
    displayName: event.userDisplayName,
    event: 'follow.add',
    follow: {
      followedAt,
      userDisplayName: event.userDisplayName,
      userId: event.userId,
      username: event.userName
    },
    message: `${event.userDisplayName} followed`,
    source: 'follow',
    user: event.userName,
    userId: event.userId,
    username: event.userName
  }
}

function createRaidContext(event) {
  return {
    broadcaster: event.raidedBroadcasterName,
    broadcasterDisplayName: event.raidedBroadcasterDisplayName,
    broadcasterId: event.raidedBroadcasterId,
    displayName: event.raidingBroadcasterDisplayName,
    event: 'raid.add',
    message: `${event.raidingBroadcasterDisplayName} raided with ${event.viewers} viewers`,
    raid: {
      fromBroadcasterDisplayName: event.raidingBroadcasterDisplayName,
      fromBroadcasterId: event.raidingBroadcasterId,
      fromBroadcasterName: event.raidingBroadcasterName,
      toBroadcasterDisplayName: event.raidedBroadcasterDisplayName,
      toBroadcasterId: event.raidedBroadcasterId,
      toBroadcasterName: event.raidedBroadcasterName,
      viewers: event.viewers
    },
    source: 'raid',
    user: event.raidingBroadcasterName,
    userId: event.raidingBroadcasterId,
    username: event.raidingBroadcasterName,
    viewers: event.viewers
  }
}

function createSubscriptionContext(event) {
  return {
    broadcaster: event.broadcasterName,
    broadcasterDisplayName: event.broadcasterDisplayName,
    broadcasterId: event.broadcasterId,
    displayName: event.userDisplayName,
    event: 'subscription.add',
    isGift: Boolean(event.isGift),
    message: `${event.userDisplayName} subscribed`,
    source: 'subscription',
    subscription: {
      isGift: Boolean(event.isGift),
      tier: event.tier,
      userDisplayName: event.userDisplayName,
      userId: event.userId,
      username: event.userName
    },
    tier: event.tier,
    user: event.userName,
    userId: event.userId,
    username: event.userName
  }
}

function createSubscriptionGiftContext(event) {
  const displayName = event.isAnonymous ? 'Anonymous' : event.gifterDisplayName
  const username = event.isAnonymous ? 'anonymous' : event.gifterName
  const userId = event.isAnonymous ? null : event.gifterId

  return {
    broadcaster: event.broadcasterName,
    broadcasterDisplayName: event.broadcasterDisplayName,
    broadcasterId: event.broadcasterId,
    displayName,
    event: 'subscription.gift',
    isAnonymous: Boolean(event.isAnonymous),
    isGift: true,
    message: `${displayName} gifted ${event.amount} subscription${Number(event.amount) === 1 ? '' : 's'}`,
    source: 'subscription',
    subscription: {
      amount: event.amount,
      cumulativeAmount: event.cumulativeAmount,
      gifterDisplayName: event.gifterDisplayName,
      gifterId: event.gifterId,
      gifterName: event.gifterName,
      isAnonymous: Boolean(event.isAnonymous),
      isGift: true,
      tier: event.tier
    },
    tier: event.tier,
    user: username,
    userId,
    username
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

function summarizeCommunityEventContext(context) {
  return {
    displayName: context.displayName,
    event: context.event,
    follow: context.follow || null,
    raid: context.raid || null,
    subscription: context.subscription || null,
    user: context.user,
    userId: context.userId
  }
}

function summarizeChatEntryContext(context) {
  return {
    displayName: context.displayName,
    event: context.event,
    roles: context.entry.roles,
    user: context.user,
    userId: context.userId
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

function getPrivilegedChatEntryKey(context, handlers, seenEntrants) {
  if (!handlers.length) return null
  const entryRoles = getPrivilegedEntryRoles(context.roles)
  if (!entryRoles.length) return null

  const userKey = context.userId || normalizeLogin(context.username || context.user)
  if (!userKey || seenEntrants.has(userKey)) return null

  return userKey
}

function getPrivilegedEntryRoles(roles) {
  const actual = new Set((roles || []).map(normalizeRole))
  return ['moderator', 'vip'].filter(role => actual.has(role))
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
  const actualRoles = new Set((context.roles || []).map(normalizeRole))
  const viewerCount = Number(context.viewers || (context.raid && context.raid.viewers) || 0)

  if (handler.rewardIds.length && !handler.rewardIds.includes(rewardId)) return false
  if (handler.rewardTitles.length && !handler.rewardTitles.includes(rewardTitle)) return false
  if (handler.rewardTypes.length && !handler.rewardTypes.includes(rewardType)) return false
  if (handler.statuses.length && !handler.statuses.includes(status)) return false
  if (handler.userIds.length && !handler.userIds.includes(userId)) return false
  if (handler.usernames.length && !handler.usernames.includes(username) && !handler.usernames.includes(displayName)) return false
  if (handler.roles.length && !handler.roles.some(role => actualRoles.has(role))) return false
  if (handler.inputContains.length && !handler.inputContains.some(value => input.includes(value))) return false
  if (handler.inputPatterns.length && !handler.inputPatterns.some(pattern => testRegex(pattern, context.input || context.message || ''))) return false
  if (handler.minViewers !== null && viewerCount < handler.minViewers) return false
  if (handler.maxViewers !== null && viewerCount > handler.maxViewers) return false

  return true
}

function warnMissingScopes(actualScopes, requiredScopes, logger, label = 'Twitch bot token') {
  const actual = new Set(actualScopes || [])
  const missing = requiredScopes.filter(scope => !actual.has(scope))
  if (missing.length) {
    logger.warn(`${label} is missing recommended scope${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`)
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
      chatEntries: [],
      commands: parsed,
    follows: [],
    raids: [],
    redemptions: [],
    redemptionUpdates: [],
    rewardEvents: [],
    subscriptions: []
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('commands.json must contain an array or an object')
  }

  return {
    automaticRedemptions: asArray(parsed.automaticRedemptions || parsed.automaticRewards),
    chatEntries: asArray(parsed.chatEntries || parsed.chatEntrants || parsed.entries || parsed.entryAlerts),
    commands: asArray(parsed.commands),
    follows: asArray(parsed.follows || parsed.followers || parsed.followEvents),
    raids: asArray(parsed.raids || parsed.raidEvents),
    redemptions: asArray(parsed.redemptions || parsed.rewardRedemptions),
    redemptionUpdates: asArray(parsed.redemptionUpdates),
    rewardEvents: asArray(parsed.rewardEvents),
    subscriptions: asArray(parsed.subscriptions || parsed.subs || parsed.subscriptionEvents)
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
  const minViewers = numberOrNull(match.minViewers || match.minimumViewers || handler.minViewers || handler.minimumViewers)
  const maxViewers = numberOrNull(match.maxViewers || match.maximumViewers || handler.maxViewers || handler.maximumViewers)
  const roles = normalizeRoles(match.role || match.roles || handler.role || handler.roles)
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
    roles.join(','),
    inputContains.join(','),
    inputPatterns.map(pattern => pattern.source).join(','),
    minViewers === null ? '' : `min${minViewers}`,
    maxViewers === null ? '' : `max${maxViewers}`
  ].filter(Boolean)

  return {
    actions: handler.actions,
    cooldownScope: handler.cooldownScope === 'user' ? 'user' : 'global',
    cooldownSeconds: Number(handler.cooldownSeconds || 0),
    events,
    key: keyParts.join(':'),
    inputContains,
    inputPatterns,
    maxViewers,
    minViewers,
    name,
    rewardIds,
    rewardTitles,
    rewardTypes,
    roles,
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
  return asArray(roles).map(normalizeRole).filter(Boolean)
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
    chatEntry: 'chat.entry',
    chatentry: 'chat.entry',
    enter: 'chat.entry',
    entry: 'chat.entry',
    follow: 'follow.add',
    followed: 'follow.add',
    follower: 'follow.add',
    gift: 'subscription.gift',
    giftsub: 'subscription.gift',
    'gift-sub': 'subscription.gift',
    gifted: 'subscription.gift',
    giftedsub: 'subscription.gift',
    'gifted-sub': 'subscription.gift',
    raid: 'raid.add',
    raided: 'raid.add',
    redemption: 'redemption.add',
    redeemed: 'redemption.add',
    remove: 'reward.remove',
    sub: 'subscription.add',
    subs: 'subscription.add',
    subscribe: 'subscription.add',
    subscribed: 'subscription.add',
    subscriber: 'subscription.add',
    subscribers: 'subscription.add',
    subscription: 'subscription.add',
    subscriptiongift: 'subscription.gift',
    'subscription-gift': 'subscription.gift',
    subscriptions: 'subscription.add',
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
    subs: 'subscriber',
    vips: 'vip'
  }

  return aliases[normalized] || normalized
}

function asArray(value) {
  if (value === undefined || value === null || value === '') return []
  return Array.isArray(value) ? value : [value]
}

function getConfiguredEventSubHandlerGroups({
  automaticRedemptionHandlerCount = 0,
  followHandlerCount = 0,
  raidHandlerCount = 0,
  redemptionHandlerCount = 0,
  redemptionUpdateHandlerCount = 0,
  rewardAddEventHandlerCount = 0,
  rewardRemoveEventHandlerCount = 0,
  rewardUpdateEventHandlerCount = 0,
  subscriptionHandlerCount = 0
} = {}) {
  return new Set([
    followHandlerCount ? 'follows' : '',
    raidHandlerCount ? 'raids' : '',
    subscriptionHandlerCount ? 'subscriptions' : '',
    redemptionHandlerCount ? 'redemptions' : '',
    redemptionUpdateHandlerCount ? 'redemption updates' : '',
    automaticRedemptionHandlerCount ? 'automatic redemptions' : '',
    rewardAddEventHandlerCount ? 'reward add events' : '',
    rewardUpdateEventHandlerCount ? 'reward update events' : '',
    rewardRemoveEventHandlerCount ? 'reward remove events' : ''
  ].filter(Boolean))
}

function getUnsubscribedEventSubHandlerGroups(configuredGroups, subscribedGroups) {
  return [...configuredGroups].filter(group => !subscribedGroups.has(group))
}

function getEventSubAuthRequirements({
  config = {},
  followHandlers = [],
  subscriptionHandlers = []
} = {}) {
  return {
    needsBroadcasterToken: Boolean(config.enableRedemptions) || followHandlers.length > 0 || subscriptionHandlers.length > 0,
    needsFollowScopes: followHandlers.length > 0,
    needsSubscriptionScopes: subscriptionHandlers.length > 0
  }
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
    defaultAlertSound: process.env.DEFAULT_ALERT_SOUND || 'example.mp3',
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

class ChatConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ChatConfigError'
  }
}

class TokenConfigError extends ChatConfigError {
  constructor(message) {
    super(message)
    this.name = 'TokenConfigError'
  }
}

function isNonRetryableStartupError(error) {
  return error instanceof ChatConfigError
}

function readTokenConfig(tokenFile) {
  if (!tokenFile || !fs.existsSync(tokenFile)) return {}

  const raw = fs.readFileSync(tokenFile, 'utf8')
  let data
  try {
    data = JSON.parse(raw)
  } catch (error) {
    throw new TokenConfigError(`Failed to load Twitch token file ${relativePath(tokenFile)}: ${error.message}`)
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new TokenConfigError(`Failed to load Twitch token file ${relativePath(tokenFile)}: token file must contain a JSON object`)
  }

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

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
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
  FOLLOW_SCOPES,
  ChatConfigError,
  createChatService,
  getEventSubAuthRequirements,
  getConfiguredEventSubHandlerGroups,
  getUnsubscribedEventSubHandlerGroups,
  isNonRetryableStartupError,
  readTokenConfig,
  TokenConfigError,
  REDEMPTION_SCOPES,
  SUBSCRIPTION_SCOPES,
  CHAT_SCOPES
}
