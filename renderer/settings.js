const { ipcRenderer, clipboard } = require('electron');

function toggleReportingFields(visible) {
  document.getElementById('reporting-fields').style.display = visible ? 'block' : 'none';
}

function toggleOverlayUrlRow(visible) {
  document.getElementById('overlay-url-row').style.display = visible ? 'flex' : 'none';
}

async function refreshOverlayUrl() {
  const url = await ipcRenderer.invoke('overlay:getUrl');
  document.getElementById('overlay-url').value = url;
}

async function load() {
  const settings = await ipcRenderer.invoke('settings:get');
  document.getElementById('adBlock').checked = settings.adBlockEnabled;
  document.getElementById('animations').checked = settings.animationsEnabled;
  document.getElementById('taskbarProgress').checked = settings.taskbarProgressEnabled;

  document.getElementById('reporting').checked = settings.reportingEnabled;
  document.getElementById('reportingUsername').value = settings.reportingUsername || '';
  toggleReportingFields(settings.reportingEnabled);

  document.getElementById('overlay').checked = settings.overlayEnabled;
  toggleOverlayUrlRow(settings.overlayEnabled);
  if (settings.overlayEnabled) await refreshOverlayUrl();
}

document.getElementById('adBlock').addEventListener('change', (e) => {
  ipcRenderer.send('settings:set', 'adBlockEnabled', e.target.checked);
});

document.getElementById('animations').addEventListener('change', (e) => {
  ipcRenderer.send('settings:set', 'animationsEnabled', e.target.checked);
});

document.getElementById('taskbarProgress').addEventListener('change', (e) => {
  ipcRenderer.send('settings:set', 'taskbarProgressEnabled', e.target.checked);
});

document.getElementById('reporting').addEventListener('change', (e) => {
  ipcRenderer.send('settings:set', 'reportingEnabled', e.target.checked);
  toggleReportingFields(e.target.checked);
});

document.getElementById('reportingUsername').addEventListener('change', (e) => {
  ipcRenderer.send('settings:set', 'reportingUsername', e.target.value.trim());
});

document.getElementById('overlay').addEventListener('change', async (e) => {
  ipcRenderer.send('settings:set', 'overlayEnabled', e.target.checked);
  toggleOverlayUrlRow(e.target.checked);
  if (e.target.checked) await refreshOverlayUrl();
});

document.getElementById('overlay-copy').addEventListener('click', () => {
  const input = document.getElementById('overlay-url');
  clipboard.writeText(input.value);
});

document.getElementById('close').addEventListener('click', () => window.close());

load();
