const assert = require('node:assert/strict')
const test = require('node:test')

const { normalizeMediaAction, normalizeReconnectMs } = require('../modules/obs')

test('OBS reconnect interval falls back for unsafe values', () => {
  for (const value of ['-1', '0', '999', 'Infinity', 'NaN', '']) {
    assert.equal(normalizeReconnectMs(value), 5000, `${value} should use the default interval`)
  }
})

test('OBS reconnect interval accepts values at or above one second', () => {
  assert.equal(normalizeReconnectMs('1000'), 1000)
  assert.equal(normalizeReconnectMs('2500.6'), 2501)
})

test('OBS media actions reject unknown commands', () => {
  assert.equal(normalizeMediaAction('restart'), 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART')

  assert.throws(
    () => normalizeMediaAction('resart'),
    error => error.statusCode === 400 && /play, pause, restart, stop/.test(error.message)
  )
})
