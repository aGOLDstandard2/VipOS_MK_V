const assert = require('node:assert/strict')
const test = require('node:test')

const {
  formatHttpError,
  parseResponseText,
  simulateLiveEvent
} = require('../scripts/simulate-twitch-event')

test('live Twitch simulator reports a JSON error response', () => {
  const body = '{"error":"Unknown event type"}'
  const payload = parseResponseText(body)

  assert.equal(
    formatHttpError({ status: 404, statusText: 'Not Found' }, payload, body),
    '404 Not Found: Unknown event type'
  )
})

test('live Twitch simulator reports a non-JSON error response', () => {
  const body = '<html><body>Route not found</body></html>'
  const payload = parseResponseText(body)

  assert.equal(payload, null)
  assert.equal(
    formatHttpError({ status: 404, statusText: 'Not Found' }, payload || {}, body),
    '404 Not Found: <html><body>Route not found</body></html>'
  )
})

test('live Twitch simulator rejects a successful non-JSON response', async () => {
  const originalFetch = global.fetch
  global.fetch = async () => ({
    ok: true,
    text: async () => '<html><body>Unexpected response</body></html>'
  })

  try {
    await assert.rejects(
      simulateLiveEvent('follow', {}, 'fixtures/twitch/follow.json', 'http://127.0.0.1:8080'),
      /Expected a JSON object response from http:\/\/127\.0\.0\.1:8080\/api\/v1\/twitch\/simulate\/follow/
    )
  } finally {
    global.fetch = originalFetch
  }
})
