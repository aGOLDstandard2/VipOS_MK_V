(() => {
  const target = document.querySelector('[data-lower-third]');
  const socket = window.VIPOS_SOCKET;
  const hiddenClass = 'is-lower-third-hidden';

  if (!target || !socket) return;

  function setHidden(hidden) {
    target.classList.toggle(hiddenClass, Boolean(hidden));
  }

  socket.on('lower-third-hide', () => setHidden(true));
  socket.on('lower-third-show', () => setHidden(false));
  socket.on('lower-third-toggle', payload => {
    if (payload && typeof payload.hidden === 'boolean') {
      setHidden(payload.hidden);
      return;
    }

    target.classList.toggle(hiddenClass);
  });
})();
