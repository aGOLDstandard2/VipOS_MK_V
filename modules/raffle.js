const fs = require('fs')
const path = require('path')

const DEFAULT_STATE_FILE = path.join(__dirname, '..', 'config', 'raffle.json')
const DEFAULT_MIN_DELAY_MS = 5 * 60 * 1000
const DEFAULT_MAX_DELAY_MS = 10 * 60 * 1000
const DEFAULT_ENTRY_WINDOW_MS = 2 * 60 * 1000
const DEFAULT_COUNTDOWN_INTERVAL_MS = 30 * 1000
const DEFAULT_WIN_POINTS = 1
const DEFAULT_ENTRY_COMMAND = '!join'
const DEFAULT_POINTS_COMMAND = '!points'

function createRaffleService({
  logger = console,
  announce = async () => {},
  announceImmediate = announce,
  stateFile = DEFAULT_STATE_FILE,
  settings = readEnvSettings()
} = {}) {
  let eventTimer = null
  let closeTimer = null
  let countdownTimer = null
  const state = loadState(stateFile, settings, logger)

  function enable() {
    if (state.enabled) return getStatus()

    state.enabled = true
    state.updatedAt = nowIso()
    save()
    return start()
  }

  function disable() {
    state.enabled = false
    state.updatedAt = nowIso()
    clearEventTimer()
    clearCountdownTimer()
    if (state.current && state.current.status === 'open') {
      state.current.status = 'canceled'
      state.current.closedAt = nowIso()
    }
    state.nextEventAt = null
    save()
    return getStatus()
  }

  function toggle() {
    return state.enabled ? disable() : enable()
  }

  function start() {
    if (state.current && state.current.status === 'open') return getStatus()

    clearEventTimer()
    clearCloseTimer()

    const openedAt = nowIso()
    const closesAt = new Date(Date.now() + state.settings.entryWindowMs).toISOString()
    const roundNumber = Number(state.totals.roundsStarted || 0) + 1

    state.current = {
      id: `raffle-${Date.now()}`,
      roundNumber,
      status: 'open',
      openedAt,
      closesAt,
      entrants: {}
    }
    state.nextEventAt = null
    state.totals.roundsStarted = roundNumber
    state.updatedAt = openedAt
    save()

    scheduleClose()
    scheduleCountdown()
    announceRaffleOpen().catch(handleAnnounceError)
    return getStatus()
  }

  function close() {
    if (!state.current || state.current.status !== 'open') return getStatus()

    clearCloseTimer()
    clearCountdownTimer()

    const closedAt = nowIso()
    const entrants = Object.values(state.current.entrants || {})
    const winner = entrants.length ? entrants[Math.floor(Math.random() * entrants.length)] : null

    state.current.status = 'closed'
    state.current.closedAt = closedAt
    state.current.winner = winner ? summarizeUser(winner) : null
    state.updatedAt = closedAt
    state.totals.roundsClosed = Number(state.totals.roundsClosed || 0) + 1

    const historyItem = {
      id: state.current.id,
      roundNumber: state.current.roundNumber,
      openedAt: state.current.openedAt,
      closedAt,
      entrantCount: entrants.length,
      winner: winner ? summarizeUser(winner) : null
    }

    if (winner) {
      const user = ensureUser(winner)
      user.wins += 1
      user.points += state.settings.winPoints
      user.lastWonAt = closedAt
      historyItem.pointsAwarded = state.settings.winPoints
    }

    state.history.unshift(historyItem)
    state.history = state.history.slice(0, state.settings.maxHistory)
    save()

    announceRaffleClosed(historyItem).catch(handleAnnounceError)
    scheduleNextEvent()
    return getStatus()
  }

  async function handleChatMessage(context = {}) {
    const command = getCommandName(context.message)
    if (!command) return false

    if (command === normalizeCommand(state.settings.entryCommand)) {
      enter(context)
      return true
    }

    if (command === normalizeCommand(state.settings.pointsCommand)) {
      await announcePoints(context)
      return true
    }

    return false
  }

  function enter(context = {}) {
    if (!state.current || state.current.status !== 'open') {
      announceNoOpenRaffle(context).catch(handleAnnounceError)
      return getStatus()
    }

    if (Date.now() >= new Date(state.current.closesAt).getTime()) {
      close()
      return getStatus()
    }

    const user = ensureUser(context)
    const wasEntered = Boolean(state.current.entrants[user.key])

    state.current.entrants[user.key] = summarizeUser(user)
    state.current.entrantCount = Object.keys(state.current.entrants).length

    if (!wasEntered) {
      user.entries += 1
      user.lastEnteredAt = nowIso()
      state.totals.entries = Number(state.totals.entries || 0) + 1
      announceEntered(user, state.current.entrantCount).catch(handleAnnounceError)
    } else {
      announceAlreadyEntered(user).catch(handleAnnounceError)
    }

    state.updatedAt = nowIso()
    save()
    return getStatus()
  }

  function scheduleNextEvent() {
    clearEventTimer()

    if (!state.enabled) {
      state.nextEventAt = null
      save()
      return
    }

    if (state.current && state.current.status === 'open') {
      scheduleClose()
      scheduleCountdown()
      return
    }

    const delay = randomDelay(state.settings.minDelayMs, state.settings.maxDelayMs)
    state.nextEventAt = new Date(Date.now() + delay).toISOString()
    save()

    eventTimer = setTimeout(() => {
      eventTimer = null
      start()
    }, delay)
  }

  function scheduleCountdown() {
    clearCountdownTimer()
    if (!state.current || state.current.status !== 'open') return
    if (state.settings.countdownIntervalMs <= 0) return

    const closesAt = new Date(state.current.closesAt).getTime()
    const remainingMs = closesAt - Date.now()
    if (remainingMs <= 0) return

    const delay = Math.min(state.settings.countdownIntervalMs, remainingMs)
    countdownTimer = setTimeout(() => {
      countdownTimer = null
      announceCountdown()
      scheduleCountdown()
    }, delay)
  }

  function scheduleClose() {
    clearCloseTimer()
    if (!state.current || state.current.status !== 'open') return

    const delay = Math.max(new Date(state.current.closesAt).getTime() - Date.now(), 0)
    closeTimer = setTimeout(() => {
      closeTimer = null
      close()
    }, delay)
  }

  function startTimers() {
    if (state.current && state.current.status === 'open') {
      if (Date.now() >= new Date(state.current.closesAt).getTime()) close()
      else {
        scheduleClose()
        scheduleCountdown()
      }
    }

    if (state.enabled) scheduleNextEvent()
  }

  function stopTimers() {
    clearEventTimer()
    clearCloseTimer()
    clearCountdownTimer()
  }

  function getStatus() {
    const users = Object.values(state.users || {})
      .map(user => ({ ...user }))
      .sort((a, b) => b.points - a.points || b.wins - a.wins || a.displayName.localeCompare(b.displayName))

    const current = state.current ? {
      ...state.current,
      entrants: undefined,
      entrantCount: Object.keys(state.current.entrants || {}).length
    } : null

    return {
      enabled: state.enabled,
      current,
      countdownIntervalMs: state.settings.countdownIntervalMs,
      entryCommand: state.settings.entryCommand,
      pointsCommand: state.settings.pointsCommand,
      entryWindowMs: state.settings.entryWindowMs,
      lastError: state.lastError || null,
      nextEventAt: state.nextEventAt,
      totals: { ...state.totals },
      updatedAt: state.updatedAt,
      users,
      winners: state.history.slice(0, 10)
    }
  }

  function ensureUser(context = {}) {
    const key = normalizeUserKey(context)
    if (!state.users[key]) {
      state.users[key] = {
        key,
        userId: context.userId || '',
        username: context.username || context.user || '',
        displayName: context.displayName || context.username || context.user || 'Viewer',
        entries: 0,
        wins: 0,
        points: 0,
        lastEnteredAt: null,
        lastWonAt: null
      }
    }

    const user = state.users[key]
    user.userId = context.userId || user.userId || ''
    user.username = context.username || context.user || user.username || ''
    user.displayName = context.displayName || user.displayName || user.username || 'Viewer'
    return user
  }

  function save() {
    persistState(stateFile, state, logger)
  }

  async function announceRaffleOpen() {
    await announce([
      {
        type: 'chat.say',
        message: `Raffle is open. Type ${state.settings.entryCommand} to enter. Winner picked in ${formatDuration(state.settings.entryWindowMs)}.`
      },
      {
        type: 'overlay.alert',
        message: `Raffle open: type ${state.settings.entryCommand} to enter.`
      }
    ], { source: 'raffle', raffle: { event: 'open', id: state.current.id } })
  }

  async function announceRaffleClosed(historyItem) {
    const message = historyItem.winner
      ? `Raffle winner: ${historyItem.winner.displayName}. +${historyItem.pointsAwarded} point.`
      : 'Raffle closed with no entries.'

    await announce([
      { type: 'chat.say', message },
      { type: 'overlay.alert', message }
    ], { source: 'raffle', raffle: { event: 'closed', id: historyItem.id } })
  }

  function announceCountdown() {
    if (!state.current || state.current.status !== 'open') return

    const remainingSeconds = Math.max(Math.ceil((new Date(state.current.closesAt).getTime() - Date.now()) / 1000), 0)
    if (remainingSeconds <= 0) return

    safeAnnounce({
      type: 'chat.say',
      message: `Raffle closes in ${remainingSeconds} second${remainingSeconds === 1 ? '' : 's'}. Type ${state.settings.entryCommand} to enter.`
    }, { source: 'raffle', raffle: { event: 'countdown', id: state.current.id, remainingSeconds } }, announceImmediate)
  }

  async function announceEntered(user, entrantCount) {
    await announce({
      type: 'chat.say',
      message: `${user.displayName} entered the raffle. ${entrantCount} entered.`
    }, { source: 'raffle', raffle: { event: 'entry', userId: user.userId, username: user.username } })
  }

  async function announceAlreadyEntered(user) {
    await announce({
      type: 'chat.say',
      message: `${user.displayName}, you are already entered.`
    }, { source: 'raffle', raffle: { event: 'duplicate-entry', userId: user.userId, username: user.username } })
  }

  async function announceNoOpenRaffle(context) {
    await announce({
      type: 'chat.say',
      message: `No raffle is open right now. Next raffle: ${state.nextEventAt ? formatDate(state.nextEventAt) : 'not scheduled'}.`
    }, { source: 'raffle', messageId: context.messageId })
  }

  async function announcePoints(context) {
    const user = ensureUser(context)
    await announce({
      type: 'chat.say',
      message: `${user.displayName}: ${user.points} raffle point${user.points === 1 ? '' : 's'}, ${user.wins} win${user.wins === 1 ? '' : 's'}, ${user.entries} entr${user.entries === 1 ? 'y' : 'ies'}.`
    }, { source: 'raffle', messageId: context.messageId })
  }

  function handleAnnounceError(error) {
    state.lastError = error.message
    logger.error(`Raffle announcement failed: ${error.message}`)
    save()
  }

  function safeAnnounce(actionList, context, announcer = announce) {
    try {
      Promise.resolve(announcer(actionList, context)).catch(handleAnnounceError)
    } catch (error) {
      handleAnnounceError(error)
    }
  }

  function clearEventTimer() {
    if (eventTimer) clearTimeout(eventTimer)
    eventTimer = null
  }

  function clearCloseTimer() {
    if (closeTimer) clearTimeout(closeTimer)
    closeTimer = null
  }

  function clearCountdownTimer() {
    if (countdownTimer) clearTimeout(countdownTimer)
    countdownTimer = null
  }

  startTimers()

  return {
    close,
    disable,
    enable,
    enter,
    getStatus,
    handleChatMessage,
    start,
    stopTimers,
    toggle
  }
}

function loadState(stateFile, settings, logger = console) {
  const stored = readJson(stateFile, logger)
  const now = nowIso()
  return {
    enabled: Boolean(stored.enabled ?? settings.enabled),
    current: stored.current || null,
    history: Array.isArray(stored.history) ? stored.history : [],
    lastError: stored.lastError || null,
    nextEventAt: stored.nextEventAt || null,
    settings: normalizeSettings({ ...(stored.settings || {}), ...settings }),
    totals: {
      entries: 0,
      roundsClosed: 0,
      roundsStarted: 0,
      ...(stored.totals || {})
    },
    updatedAt: stored.updatedAt || now,
    users: stored.users && typeof stored.users === 'object' ? stored.users : {}
  }
}

function persistState(stateFile, state, logger) {
  const tempFile = `${stateFile}.${process.pid}.${Date.now()}.tmp`

  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true })
    fs.writeFileSync(tempFile, `${JSON.stringify(state, null, 2)}\n`)
    replaceFile(tempFile, stateFile)
  } catch (error) {
    logger.error(`Failed to persist raffle state: ${error.message}`)
    cleanupTempFile(tempFile, logger)
  }
}

function replaceFile(tempFile, targetFile) {
  try {
    fs.renameSync(tempFile, targetFile)
  } catch (error) {
    if (!['EACCES', 'EPERM'].includes(error.code)) throw error
    fs.copyFileSync(tempFile, targetFile)
    fs.unlinkSync(tempFile)
  }
}

function cleanupTempFile(tempFile, logger) {
  try {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile)
  } catch (error) {
    if (logger && typeof logger.warn === 'function') {
      logger.warn(`Failed to remove raffle temp file: ${error.message}`)
    }
  }
}

function readJson(file, logger = console) {
  if (!file || !fs.existsSync(file)) return {}

  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (logger && typeof logger.warn === 'function') {
      logger.warn(`Failed to load raffle state ${file}: ${error.message}`)
    }
    return {}
  }
}

function readEnvSettings() {
  const settings = {}

  if (process.env.RAFFLE_ENABLED !== undefined) settings.enabled = parseBool(process.env.RAFFLE_ENABLED, false)
  if (process.env.RAFFLE_ENTRY_COMMAND) settings.entryCommand = process.env.RAFFLE_ENTRY_COMMAND
  if (process.env.RAFFLE_POINTS_COMMAND) settings.pointsCommand = process.env.RAFFLE_POINTS_COMMAND
  if (process.env.RAFFLE_COUNTDOWN_INTERVAL_MS) settings.countdownIntervalMs = numberOrZero(process.env.RAFFLE_COUNTDOWN_INTERVAL_MS, DEFAULT_COUNTDOWN_INTERVAL_MS)
  if (process.env.RAFFLE_ENTRY_WINDOW_MS) settings.entryWindowMs = numberOrDefault(process.env.RAFFLE_ENTRY_WINDOW_MS, DEFAULT_ENTRY_WINDOW_MS)
  if (process.env.RAFFLE_MAX_DELAY_MS) settings.maxDelayMs = numberOrDefault(process.env.RAFFLE_MAX_DELAY_MS, DEFAULT_MAX_DELAY_MS)
  if (process.env.RAFFLE_MAX_HISTORY) settings.maxHistory = numberOrDefault(process.env.RAFFLE_MAX_HISTORY, 50)
  if (process.env.RAFFLE_MIN_DELAY_MS) settings.minDelayMs = numberOrDefault(process.env.RAFFLE_MIN_DELAY_MS, DEFAULT_MIN_DELAY_MS)
  if (process.env.RAFFLE_WIN_POINTS) settings.winPoints = numberOrDefault(process.env.RAFFLE_WIN_POINTS, DEFAULT_WIN_POINTS)

  return settings
}

function normalizeSettings(settings = {}) {
  const minDelayMs = numberOrDefault(settings.minDelayMs, DEFAULT_MIN_DELAY_MS)
  const maxDelayMs = Math.max(numberOrDefault(settings.maxDelayMs, DEFAULT_MAX_DELAY_MS), minDelayMs)

  return {
    enabled: Boolean(settings.enabled),
    countdownIntervalMs: numberOrZero(settings.countdownIntervalMs, DEFAULT_COUNTDOWN_INTERVAL_MS),
    entryCommand: normalizeChatCommand(settings.entryCommand || DEFAULT_ENTRY_COMMAND),
    pointsCommand: normalizeChatCommand(settings.pointsCommand || DEFAULT_POINTS_COMMAND),
    entryWindowMs: numberOrDefault(settings.entryWindowMs, DEFAULT_ENTRY_WINDOW_MS),
    maxDelayMs,
    maxHistory: numberOrDefault(settings.maxHistory, 50),
    minDelayMs,
    winPoints: numberOrDefault(settings.winPoints, DEFAULT_WIN_POINTS)
  }
}

function normalizeChatCommand(value) {
  const text = String(value || '').trim().toLowerCase()
  if (!text) return DEFAULT_ENTRY_COMMAND
  return text.startsWith('!') ? text : `!${text}`
}

function getCommandName(message) {
  const match = String(message || '').trim().match(/^(\S+)/)
  return match ? normalizeCommand(match[1]) : ''
}

function normalizeCommand(value) {
  return String(value || '').trim().toLowerCase()
}

function normalizeUserKey(context = {}) {
  return String(context.userId || context.username || context.user || context.displayName || 'unknown').trim().toLowerCase()
}

function summarizeUser(user) {
  return {
    key: user.key,
    userId: user.userId,
    username: user.username,
    displayName: user.displayName
  }
}

function randomDelay(minDelayMs, maxDelayMs) {
  if (maxDelayMs <= minDelayMs) return minDelayMs
  return Math.floor(minDelayMs + Math.random() * (maxDelayMs - minDelayMs + 1))
}

function numberOrDefault(value, defaultValue) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.round(number) : defaultValue
}

function numberOrZero(value, defaultValue) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : defaultValue
}

function parseBool(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase())
}

function nowIso() {
  return new Date().toISOString()
}

function formatDuration(ms) {
  const seconds = Math.max(Math.round(ms / 1000), 1)
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (!minutes) return `${seconds} second${seconds === 1 ? '' : 's'}`
  if (!remainingSeconds) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  return `${minutes}m ${remainingSeconds}s`
}

function formatDate(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleTimeString()
}

module.exports = {
  createRaffleService
}
