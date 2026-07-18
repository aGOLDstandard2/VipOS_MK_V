const assert = require('node:assert/strict')
const test = require('node:test')

const { _private } = require('../modules/chat')

test('handler regexes keep normal match behavior', () => {
  const pattern = _private.normalizeRegex('hello')

  assert.equal(_private.testRegex(pattern, 'well hello there'), true)
  assert.equal(_private.testRegex(pattern, 'goodbye'), false)
})

test('handler regexes reject nested quantifiers', () => {
  assert.throws(
    () => _private.normalizeRegex('(a+)+$'),
    /nested quantifiers/
  )
})

test('handler regexes reject oversized patterns', () => {
  assert.throws(
    () => _private.normalizeRegex('x'.repeat(201)),
    /200 characters/
  )
})

test('handler regex matching only evaluates bounded input', () => {
  const pattern = _private.normalizeRegex('needle$')
  const value = `${'x'.repeat(500)}needle`

  assert.equal(_private.testRegex(pattern, value), false)
})
