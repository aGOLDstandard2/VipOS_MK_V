const assert = require('node:assert/strict')
const test = require('node:test')

const {
  getConfiguredEventSubHandlerGroups,
  getUnsubscribedEventSubHandlerGroups
} = require('../modules/chat')

test('configured EventSub handler groups match restart-warning group names', () => {
  const groups = getConfiguredEventSubHandlerGroups({
    automaticRedemptionHandlerCount: 1,
    followHandlerCount: 1,
    raidHandlerCount: 1,
    redemptionHandlerCount: 1,
    redemptionUpdateHandlerCount: 1,
    rewardAddEventHandlerCount: 1,
    rewardRemoveEventHandlerCount: 1,
    rewardUpdateEventHandlerCount: 1,
    subscriptionHandlerCount: 1
  })

  assert.deepEqual([...groups], [
    'follows',
    'raids',
    'subscriptions',
    'redemptions',
    'redemption updates',
    'automatic redemptions',
    'reward add events',
    'reward update events',
    'reward remove events'
  ])
})

test('EventSub restart comparison reports only newly configured groups', () => {
  const configuredGroups = getConfiguredEventSubHandlerGroups({
    followHandlerCount: 1,
    raidHandlerCount: 1,
    rewardUpdateEventHandlerCount: 1
  })
  const subscribedGroups = new Set(['follows'])

  assert.deepEqual(
    getUnsubscribedEventSubHandlerGroups(configuredGroups, subscribedGroups),
    ['raids', 'reward update events']
  )
})
