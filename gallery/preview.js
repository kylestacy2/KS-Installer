const pair = document.getElementById('pair');
pair.addEventListener('change', () => {
  document.getElementById(pair.dataset.pairTarget).setAttribute('href', pair.value);
  if (pair.dataset.pairTarget === 'model-image') document.getElementById('model-name').textContent = pair.selectedOptions[0].dataset.modelName;
});
for (const input of document.querySelectorAll('input[name="mode"]')) input.addEventListener('change', () => {
  const boot = document.getElementById('boot').checked;
  document.getElementById('dashboard').classList.toggle('is-hidden', boot);
  document.getElementById('pair-setting').hidden = boot || !pair.options.length;
  document.getElementById('screen-title').textContent = boot ? 'Startup screen preview' : 'KSE Touch Transparent dashboard preview';
  document.getElementById('caption').textContent = boot ? '800 × 480 · Full-screen startup artwork at power-on.' : '800 × 480 · KSE Touch Transparent mode · Sample electric dashboard and telemetry.';
});
