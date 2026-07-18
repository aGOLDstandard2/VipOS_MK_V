const assert = require('node:assert/strict')
const test = require('node:test')

const {
  createChatEntryContext,
  createMessageContext,
  createSubscriptionGiftContext,
  summarizeRedemptionContext
} = require('../modules/chat/chat-context')

test('chat message contexts preserve event data and derive roles', () => {
  const context = createMessageContext({
    badges: { founder: {} },
    broadcasterId: 'channel-1',
    broadcasterName: 'channel',
    chatterDisplayName: 'Viewer',
    chatterId: 'channel-1',
    chatterName: 'viewer',
    messageId: 'message-1',
    messageText: '!hello',
    rewardId: 'reward-1'
  }, { broadcasterId: 'channel-1' })

  assert.deepEqual(context.roles, ['everyone', 'broadcaster', 'founder', 'subscriber'])
  assert.equal(context.chat.chatter.name, 'viewer')
  assert.equal(context.chat.rewardId, 'reward-1')
  assert.equal(context.source, 'chat')
})

test('chat entry and anonymous gift contexts normalize privileged identities', () => {
  const entry = createChatEntryContext({
    chat: {},
    displayName: 'Moderator',
    roles: ['mod', 'vip'],
    user: 'moderator',
    userId: 'user-1'
  })
  const gift = createSubscriptionGiftContext({
    amount: 2,
    broadcasterId: 'channel-1',
    isAnonymous: true,
    tier: '1000'
  })

  assert.deepEqual(entry.entry.roles, ['moderator', 'vip'])
  assert.equal(entry.source, 'chat-entry')
  assert.equal(gift.displayName, 'Anonymous')
  assert.equal(gift.user, 'anonymous')
  assert.equal(gift.userId, null)
  assert.equal(gift.message, 'Anonymous gifted 2 subscriptions')
})

test('redemption summaries only expose the dashboard fields', () => {
  assert.deepEqual(summarizeRedemptionContext({
    displayName: 'Viewer',
    event: 'redemption.add',
    input: 'hydrate',
    redemption: { id: 'redemption-1', redeemedAt: '2026-07-18T00:00:00.000Z', status: 'fulfilled' },
    reward: { id: 'reward-1', title: 'Hydrate' },
    user: 'viewer',
    userId: 'user-1'
  }), {
    automaticReward: null,
    displayName: 'Viewer',
    event: 'redemption.add',
    input: 'hydrate',
    redeemedAt: '2026-07-18T00:00:00.000Z',
    redemptionId: 'redemption-1',
    reward: { id: 'reward-1', title: 'Hydrate' },
    status: 'fulfilled',
    user: 'viewer',
    userId: 'user-1'
  })
})
