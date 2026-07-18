const MAX_HANDLER_REGEX_INPUT_LENGTH = 500
const MAX_HANDLER_REGEX_PATTERN_LENGTH = 200

function normalizeRegex(value) {
  if (value instanceof RegExp) return value

  const text = String(value || '').trim()
  if (!text) return null

  try {
    const match = text.match(/^\/(.+)\/([dgimsuvy]*)$/)
    const source = match ? match[1] : text
    const flags = match ? match[2] : 'i'

    validateHandlerRegexSource(source)
    return new RegExp(source, flags)
  } catch (error) {
    throw new Error(`Invalid handler input pattern "${text}": ${error.message}`)
  }
}

function testRegex(pattern, value) {
  pattern.lastIndex = 0
  return pattern.test(String(value || '').slice(0, MAX_HANDLER_REGEX_INPUT_LENGTH))
}

function validateHandlerRegexSource(source) {
  if (source.length > MAX_HANDLER_REGEX_PATTERN_LENGTH) {
    throw new Error(`pattern must be ${MAX_HANDLER_REGEX_PATTERN_LENGTH} characters or fewer`)
  }

  if (hasNestedQuantifier(source)) {
    throw new Error('pattern cannot use nested quantifiers')
  }
}

function hasNestedQuantifier(source) {
  const withoutEscapes = source.replace(/\\./g, '')
  return /\((?:\?:|\?=|\?!|\?<=|\?<!|)?[^)]*(?:[+*]|\{\d+(?:,\d*)?\})[^)]*\)\s*(?:[+*]|\{\d+(?:,\d*)?\})/.test(withoutEscapes)
}

module.exports = {
  normalizeRegex,
  testRegex
}
