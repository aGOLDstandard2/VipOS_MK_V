// Pure Twitch event context mapping and dashboard summaries.
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

function getPrivilegedEntryRoles(roles) {
  const actual = new Set((roles || []).map(normalizeRole))
  return ['moderator', 'vip'].filter(role => actual.has(role))
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

function dateToIso(value) {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

module.exports = {
  createAutomaticRedemptionContext,
  createChatEntryContext,
  createFollowContext,
  createMessageContext,
  createRaidContext,
  createRedemptionContext,
  createRewardEventContext,
  createSubscriptionContext,
  createSubscriptionGiftContext,
  getPrivilegedEntryRoles,
  normalizeRole,
  summarizeChatEntryContext,
  summarizeCommunityEventContext,
  summarizeRedemptionContext,
  summarizeRewardEventContext
}
