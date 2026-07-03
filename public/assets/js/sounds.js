const stage = document.querySelector('#sound-stage');

socket.on('sound-play', ({ src, volume = 1 }) => {
  if (!src) return;

  const audio = new Audio("/assets/sounds/" + src);
  const numericVolume = Number(volume);
  audio.volume = Number.isFinite(numericVolume) ? Math.min(Math.max(numericVolume, 0), 1) : 1;
  audio.addEventListener('ended', () => audio.remove());
  audio.addEventListener('error', () => audio.remove());

  if (stage) stage.appendChild(audio);
  audio.play().catch(error => console.error('Unable to play sound', error));
});
