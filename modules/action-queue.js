function createActionQueue({
  actions,
  logger = console,
  soundCompletionBufferMs = 250,
  soundCompletionFallbackMs = 4000
} = {}) {
  if (!actions) throw new Error('Action queue requires an action runner')

  const pending = []
  const history = []
  const maxHistory = 30
  let nextId = 1
  let paused = false
  let running = null
  let processing = false

  function enqueue({
    name,
    actions: actionList,
    context = {},
    source = 'queue',
    completionDelayMs,
    delayMs,
    fallbackCompletionDelayMs
  }) {
    if (!actionList) throw userInputError('Queue item requires actions')

    const manualCompletionDelayMs = completionDelayMs ?? delayMs
    const item = {
      id: nextId++,
      name: String(name || 'Queued action').trim(),
      actions: actionList,
      completionDelayMs: manualCompletionDelayMs === undefined ? null : normalizeDelay(manualCompletionDelayMs),
      fallbackCompletionDelayMs: normalizeDelay(
        fallbackCompletionDelayMs === undefined ? soundCompletionFallbackMs : fallbackCompletionDelayMs
      ),
      context: { ...context, source },
      source,
      status: 'queued',
      queuedAt: new Date().toISOString()
    }

    pending.push(item)
    processQueue()
    return snapshot()
  }

  function pause() {
    paused = true
    return snapshot()
  }

  function resume() {
    paused = false
    processQueue()
    return snapshot()
  }

  function clear() {
    const cleared = pending.splice(0)
    for (const item of cleared) {
      finish(item, 'cleared')
    }
    return snapshot()
  }

  function skipNext() {
    const item = pending.shift()
    if (item) finish(item, 'skipped')
    return snapshot()
  }

  function getStatus() {
    return snapshot()
  }

  async function processQueue() {
    if (processing || paused || running || !pending.length) return

    processing = true
    running = pending.shift()
    running.status = 'running'
    running.startedAt = new Date().toISOString()

    try {
      const results = await actions.run(running.actions, running.context)
      const completionDelayMs = resolveCompletionDelayMs(running, results, soundCompletionBufferMs)
      running.completionDelayMs = completionDelayMs
      if (completionDelayMs > 0) {
        await wait(completionDelayMs)
      }
      finish(running, 'completed', { results })
    } catch (error) {
      if (logger && typeof logger.error === 'function') {
        logger.error(`Queued action failed: ${error.message}`)
      }
      finish(running, 'failed', { error: error.message })
    } finally {
      running = null
      processing = false
      processQueue()
    }
  }

  function finish(item, status, extra = {}) {
    item.status = status
    item.finishedAt = new Date().toISOString()
    Object.assign(item, extra)
    history.unshift(summarize(item))
    history.splice(maxHistory)
  }

  function snapshot() {
    return {
      paused,
      running: running ? summarize(running) : null,
      pending: pending.map(summarize),
      history: [...history]
    }
  }

  return {
    clear,
    enqueue,
    getStatus,
    pause,
    resume,
    skipNext
  }
}

function summarize(item) {
  return {
    id: item.id,
    name: item.name,
    source: item.source,
    status: item.status,
    completionDelayMs: item.completionDelayMs,
    fallbackCompletionDelayMs: item.fallbackCompletionDelayMs,
    queuedAt: item.queuedAt,
    startedAt: item.startedAt || null,
    finishedAt: item.finishedAt || null,
    error: item.error || null
  }
}

function resolveCompletionDelayMs(item, results, soundCompletionBufferMs) {
  if (item.completionDelayMs !== null) return item.completionDelayMs

  const soundResults = getSoundResults(results)
  if (!soundResults.length) return 0

  const soundDurationMs = getLongestSoundDurationMs(soundResults)
  if (soundDurationMs > 0) {
    return normalizeDelay(soundDurationMs + soundCompletionBufferMs)
  }

  return item.fallbackCompletionDelayMs
}

function getSoundResults(results) {
  return flattenResults(results).filter(result => result && result.type === 'sound.play')
}

function getLongestSoundDurationMs(soundResults) {
  return soundResults
    .map(result => Number(result.durationMs || 0))
    .filter(durationMs => Number.isFinite(durationMs) && durationMs > 0)
    .reduce((max, durationMs) => Math.max(max, durationMs), 0)
}

function flattenResults(value) {
  if (!Array.isArray(value)) return [value]
  return value.flatMap(flattenResults)
}

function normalizeDelay(value) {
  const delay = Number(value || 0)
  if (!Number.isFinite(delay) || delay <= 0) return 0
  return Math.min(Math.round(delay), 10 * 60 * 1000)
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function userInputError(message) {
  const error = new Error(message)
  error.statusCode = 400
  return error
}

module.exports = {
  createActionQueue
}
