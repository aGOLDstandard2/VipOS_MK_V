const assert = require('node:assert/strict')
const test = require('node:test')

const { normalizeRegex, testRegex } = require('../modules/chat-regex')

test('handler regexes keep normal match behavior', () => {
  const pattern = normalizeRegex('hello')

  assert.equal(testRegex(pattern, 'well hello there'), true)
  assert.equal(testRegex(pattern, 'goodbye'), false)
})

test('handler regexes reject nested quantifiers', () => {
  for (const pattern of [
    '(a+)+$',
    '((a+)b)+$',
    '([a-z]+)+$',
    '(a{1,3}b)*'
  ]) {
    assert.throws(
      () => normalizeRegex(pattern),
      /nested quantifiers/,
      `${pattern} should be rejected`
    )
  }
})

test('handler regexes allow grouped patterns without nested quantifiers', () => {
  for (const pattern of [
    '(hello|hi)+',
    '(a\\+)+',
    '[a-z]+'
  ]) {
    assert.doesNotThrow(() => normalizeRegex(pattern), `${pattern} should be accepted`)
  }
})

test('handler regexes reject oversized patterns', () => {
  assert.throws(
    () => normalizeRegex('x'.repeat(201)),
    /200 characters/
  )
})

test('handler regex matching only evaluates bounded input', () => {
  const pattern = normalizeRegex('needle$')
  const value = `${'x'.repeat(500)}needle`

  assert.equal(testRegex(pattern, value), false)
})
