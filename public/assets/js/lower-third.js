(() => {
  const target = document.querySelector('[data-lower-third]');
  const socket = window.VIPOS_SOCKET;
  const hiddenClass = 'is-lower-third-hidden';

  if (!target) return;

  function setHidden(hidden) {
    target.classList.toggle(hiddenClass, Boolean(hidden));
  }

  function toggleHidden(payload) {
    if (payload && typeof payload.hidden === 'boolean') {
      setHidden(payload.hidden);
      return;
    }

    target.classList.toggle(hiddenClass);
  }

  if (!socket) return;

  socket.on('lower-third-hide', () => setHidden(true));
  socket.on('lower-third-show', () => setHidden(false));
  socket.on('lower-third-sync', payload => {
    if (payload && typeof payload.hidden === 'boolean') setHidden(payload.hidden);
  });
  socket.on('lower-third-toggle', toggleHidden);

  function requestSync() {
    socket.emit('lower-third-sync-request');
  }

  socket.on('connect', requestSync);
  requestSync();
})();
