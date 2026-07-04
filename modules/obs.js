const { default: OBSWebSocket } = require('obs-websocket-js')

function createObsService({ logger = console } = {}) {
  const obs = new OBSWebSocket()
  const address = process.env.OBS_ADDRESS
  const password = process.env.OBS_PASSWORD || undefined
  const reconnectMs = Number(process.env.OBS_RECONNECT_RETRY_INTERVAL) || 5000

  const state = {
    enabled: process.env.OBS_ENABLED !== 'false' && Boolean(address),
    connected: false,
    identified: false,
    connecting: false,
    currentScene: null,
    lastError: null,
    reconnectTimer: null
  }

  obs.on('ConnectionOpened', () => {
    state.connected = true
    logger.log('OBS connection opened')
  })

  obs.on('Identified', async () => {
    state.identified = true
    state.lastError = null

    try {
      const currentScene = await getCurrentScene()
      logger.log(`OBS identified, current scene: ${currentScene}`)
    } catch (error) {
      logger.warn(`OBS identified, but current scene could not be read: ${error.message}`)
    }
  })

  obs.on('ConnectionClosed', () => {
    state.connected = false
    state.identified = false
    logger.warn('OBS connection closed')
    scheduleReconnect()
  })

  obs.on('CurrentProgramSceneChanged', data => {
    state.currentScene = data.sceneName
  })

  async function connect() {
    if (!state.enabled) {
      logger.warn('OBS is disabled because OBS_ADDRESS is not configured')
      return
    }

    if (state.connecting || state.identified) return

    state.connecting = true
    clearTimeout(state.reconnectTimer)
    state.reconnectTimer = null

    try {
      const info = await obs.connect(address, password)
      state.connected = true
      state.identified = true
      state.lastError = null
      logger.log('OBS connected and identified', info)
    } catch (error) {
      state.connected = false
      state.identified = false
      state.lastError = error.message
      logger.error(`Error connecting to OBS: ${error.message}`)
      scheduleReconnect()
    } finally {
      state.connecting = false
    }
  }

  function scheduleReconnect() {
    if (!state.enabled || state.reconnectTimer) return
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null
      connect()
    }, reconnectMs)
  }

  async function call(requestType, requestData = {}) {
    if (!state.enabled) throw new Error('OBS is not configured')

    try {
      return await obs.call(requestType, requestData)
    } catch (error) {
      state.lastError = error.message
      throw new Error(`OBS ${requestType} failed: ${error.message}`)
    }
  }

  async function getCurrentScene() {
    const data = await call('GetCurrentProgramScene')
    state.currentScene = data.currentProgramSceneName
    return data.currentProgramSceneName
  }

  async function switchScene(sceneName) {
    await call('SetCurrentProgramScene', { sceneName })
    state.currentScene = sceneName
  }

  async function getSceneItemId(sceneName, sourceName) {
    const scene = sceneName || await getCurrentScene()
    const data = await call('GetSceneItemId', { sceneName: scene, sourceName })
    return { sceneName: scene, sceneItemId: data.sceneItemId }
  }

  async function setSourceVisibility(sceneName, sourceName, sceneItemEnabled) {
    const item = await getSceneItemId(sceneName, sourceName)
    await call('SetSceneItemEnabled', {
      sceneName: item.sceneName,
      sceneItemId: item.sceneItemId,
      sceneItemEnabled
    })
  }

  async function toggleSourceVisibility(sceneName, sourceName) {
    const item = await getSceneItemId(sceneName, sourceName)
    const data = await call('GetSceneItemEnabled', {
      sceneName: item.sceneName,
      sceneItemId: item.sceneItemId
    })
    const nextVisible = !data.sceneItemEnabled
    await setSourceVisibility(item.sceneName, sourceName, nextVisible)
    return nextVisible
  }

  async function setInputMute(inputName, inputMuted) {
    await call('SetInputMute', { inputName, inputMuted })
  }

  async function toggleInputMute(inputName) {
    const data = await call('GetInputMute', { inputName })
    const nextMuted = !data.inputMuted
    await setInputMute(inputName, nextMuted)
    return nextMuted
  }

  async function mediaAction(inputName, action) {
    const mediaAction = normalizeMediaAction(action)
    await call('TriggerMediaInputAction', { inputName, mediaAction })
  }

  function getStatus() {
    return {
      enabled: state.enabled,
      connected: state.connected,
      identified: state.identified,
      currentScene: state.currentScene,
      lastError: state.lastError
    }
  }

  return {
    connect,
    call,
    getCurrentScene,
    getStatus,
    mediaAction,
    obs,
    setInputMute,
    setSourceVisibility,
    switchScene,
    toggleInputMute,
    toggleSourceVisibility
  }
}

function normalizeMediaAction(action) {
  const normalized = String(action).trim().toLowerCase()
  const actions = {
    pause: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE',
    play: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY',
    restart: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
    stop: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP'
  }

  return actions[normalized] || action
}

module.exports = {
  createObsService
}
