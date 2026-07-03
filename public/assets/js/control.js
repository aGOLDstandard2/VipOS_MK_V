const log = document.querySelector('#control-log');
const statusEl = document.querySelector('[data-status]');

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
  const data = {};
  new FormData(form).forEach((value, key) => {
    if (value !== '') data[key] = value;
  });
  return data;
}

function writeLog(value) {
  const formatted = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  log.textContent = formatted;
}

async function refreshStatus() {
  try {
    const response = await fetch('/api/v1/status');
    const data = await response.json();
    statusEl.textContent = [
      `OBS ${data.obs.identified ? 'online' : 'offline'}`,
      `Chat ${data.chat.connected ? 'online' : (data.chat.enabled ? 'offline' : 'disabled')}`,
      `${data.sockets.clients} socket${data.sockets.clients === 1 ? '' : 's'}`
    ].join(' | ');
  } catch (error) {
    statusEl.textContent = 'Status unavailable';
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

socket.on('connect', refreshStatus);
socket.on('disconnect', refreshStatus);

refreshStatus();
setInterval(refreshStatus, 5000);
