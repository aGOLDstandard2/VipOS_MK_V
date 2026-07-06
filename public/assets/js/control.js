const log = document.querySelector('#control-log');
const statusEl = document.querySelector('[data-status]');
const statusDetailsEl = document.querySelector('[data-status-details]');

async function postJson(endpoint, data = {}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  const text = await response.text();
  let payload = { ok: response.ok };

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new Error(`Expected JSON from ${endpoint}, got ${response.status} ${response.statusText}`);
    }
  }

  if (!response.ok) {
    throw new Error(payload.error || response.statusText);
  }

  return payload;
}

function formDataToJson(form) {
  if (form.hasAttribute('data-raw-json')) {
    const field = form.querySelector('textarea, input');
    const value = field ? field.value.trim() : '';
    if (!value) throw new Error('JSON payload is required');
    return JSON.parse(value);
  }

  const data = {};
  new FormData(form).forEach((value, key) => {
    if (value === '') return;

    const field = form.elements[key];
    const shouldParseJson = field && field.hasAttribute && field.hasAttribute('data-json-field');
    data[key] = shouldParseJson ? JSON.parse(value) : coerceFormValue(value);
  });

  return data;
}

function writeLog(value) {
  const formatted = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  log.textContent = formatted;
}

function coerceFormValue(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  return value;
}

function formatStatusValue(value) {
  if (value === undefined || value === null || value === '') return 'n/a';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

function formatDateValue(value) {
  if (!value) return 'n/a';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function statusBadge(label, online) {
  return `<span class="status-pill ${online ? 'is-online' : 'is-offline'}">${escapeHtml(label)}</span>`;
}

function renderStatusDetails(data) {
  if (!statusDetailsEl) return;

  const chat = data.chat || {};
  const obs = data.obs || {};
  const sockets = data.sockets || {};
  const items = [
    ['OBS enabled', formatStatusValue(obs.enabled)],
    ['OBS connected', formatStatusValue(obs.connected)],
    ['OBS identified', formatStatusValue(obs.identified)],
    ['Current scene', formatStatusValue(obs.currentScene)],
    ['OBS error', formatStatusValue(obs.lastError)],
    ['Chat enabled', formatStatusValue(chat.enabled)],
    ['Chat started', formatStatusValue(chat.started)],
    ['Chat connected', formatStatusValue(chat.connected)],
    ['Auth mode', formatStatusValue(chat.authMode)],
    ['Channel', formatStatusValue(chat.broadcasterName)],
    ['Bot', formatStatusValue(chat.botUserName)],
    ['Commands', formatStatusValue(chat.commandCount)],
    ['Commands loaded', formatDateValue(chat.commandsLoadedAt)],
    ['Commands error', formatStatusValue(chat.commandsLastError)],
    ['Messages', formatStatusValue(chat.messageCount)],
    ['Last command', formatDateValue(chat.lastCommandAt)],
    ['Rewards enabled', formatStatusValue(chat.rewardsEnabled)],
    ['Redemptions', formatStatusValue(chat.redemptionCount)],
    ['Redemption handlers', formatStatusValue(chat.redemptionHandlerCount)],
    ['Reward handlers', formatStatusValue(chat.rewardEventHandlerCount)],
    ['Follows', formatStatusValue(chat.followHandlerCount)],
    ['Raids', formatStatusValue(chat.raidHandlerCount)],
    ['Reward error', formatStatusValue(chat.rewardsLastError)],
    ['Chat error', formatStatusValue(chat.lastError)],
    ['Socket clients', formatStatusValue(sockets.clients)]
  ];

  statusDetailsEl.innerHTML = items.map(([label, value]) => (
    `<div class="status-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`
  )).join('');
}

async function refreshStatus() {
  try {
    const response = await fetch('/api/v1/status');
    const data = await response.json();
    const chatLabel = data.chat.connected ? 'Chat online' : (data.chat.enabled ? 'Chat offline' : 'Chat disabled');
    const socketCount = data.sockets.clients || 0;

    statusEl.innerHTML = [
      statusBadge(data.obs.identified ? 'OBS online' : 'OBS offline', data.obs.identified),
      statusBadge(chatLabel, data.chat.connected),
      `<span class="status-pill">${socketCount} socket${socketCount === 1 ? '' : 's'}</span>`
    ].join('');
    renderStatusDetails(data);
  } catch (error) {
    statusEl.textContent = 'Status unavailable';
    if (statusDetailsEl) {
      statusDetailsEl.innerHTML = '<div class="status-item"><span>Status</span><strong>Unavailable</strong></div>';
    }
  }
}

document.querySelectorAll('[data-json-form]').forEach(form => {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const payload = await postJson(form.dataset.endpoint, formDataToJson(form));
      writeLog(payload);
      refreshStatus();
    } catch (error) {
      writeLog(error.message);
    }
  });
});

document.querySelectorAll('[data-post]').forEach(button => {
  button.addEventListener('click', async () => {
    try {
      const payload = await postJson(button.dataset.post);
      writeLog(payload);
      refreshStatus();
    } catch (error) {
      writeLog(error.message);
    }
  });
});

document.querySelectorAll('[data-refresh-status]').forEach(button => {
  button.addEventListener('click', refreshStatus);
});

document.querySelectorAll('[data-clear-log]').forEach(button => {
  button.addEventListener('click', () => {
    log.textContent = '';
  });
});

socket.on('connect', refreshStatus);
socket.on('disconnect', refreshStatus);

refreshStatus();
setInterval(refreshStatus, 5000);
