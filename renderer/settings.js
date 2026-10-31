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
  document.getElementById('uiMode').value = settings.uiMode === 'classic' ? 'classic' : 'neo';
  document.getElementById('adBlock').checked = settings.adBlockEnabled;
  document.getElementById('animations').checked = settings.animationsEnabled;
  document.getElementById('splash').checked = settings.splashEnabled !== false;
  document.getElementById('taskbarProgress').checked = settings.taskbarProgressEnabled;
  document.getElementById('discord').checked = settings.discordEnabled !== false;
  document.getElementById('velvetone').checked = settings.velvetoneEnabled !== false;
  refreshVelvetone();

  document.getElementById('reporting').checked = settings.reportingEnabled;
  document.getElementById('reportingUsername').value = settings.reportingUsername || '';
  toggleReportingFields(settings.reportingEnabled);

  document.getElementById('overlay').checked = settings.overlayEnabled;
  toggleOverlayUrlRow(settings.overlayEnabled);
  if (settings.overlayEnabled) await refreshOverlayUrl();
}

// Velvetone : seulement avec l'interface classique
async function refreshVelvetone() {
  const classic = document.getElementById('uiMode').value === 'classic';
  document.getElementById('velvetone-row').style.display = classic ? 'block' : 'none';
  if (!classic) return;
  const s = await ipcRenderer.invoke('velvetone:status');
  const on = document.getElementById('velvetone').checked;
  let text;
  if (!s.found) text = "Installe l'extension Velvetone dans Chrome pour l'utiliser ici";
  else if (!s.running) text = `Trouvée (v${s.version}) : redémarre l'appli pour l'activer`;
  else if (s.loaded) text = `Active (v${s.version}, reprise de ton Chrome)`;
  else if (s.error) text = `Impossible de la charger : ${s.error}`;
  else text = on ? `Trouvée (v${s.version})` : `Désactivée (v${s.version} trouvée dans Chrome)`;
  document.getElementById('velvetone-status').textContent = text;
  document.getElementById('velvetone').disabled = !s.found;
  document.getElementById('velvetone-settings-row').style.display = s.loaded && on ? 'flex' : 'none';
}

document.getElementById('velvetone').addEventListener('change', (e) => {
  ipcRenderer.send('settings:set', 'velvetoneEnabled', e.target.checked);
  // le chargement / retrait prend un instant
  setTimeout(refreshVelvetone, 800);
  setTimeout(refreshVelvetone, 2500);
});

document.getElementById('velvetone-settings').addEventListener('click', () => {
  ipcRenderer.send('velvetone:openSettings');
});

ipcRenderer.invoke('app:version').then((v) => {
  document.getElementById('app-version').textContent = 'Version ' + v;
});

document.getElementById('uiMode').addEventListener('change', (e) => {
  ipcRenderer.send('settings:set', 'uiMode', e.target.value);
  refreshVelvetone();
});

document.getElementById('adBlock').addEventListener('change', (e) => {
  ipcRenderer.send('settings:set', 'adBlockEnabled', e.target.checked);
});

document.getElementById('animations').addEventListener('change', (e) => {
  ipcRenderer.send('settings:set', 'animationsEnabled', e.target.checked);
});

document.getElementById('splash').addEventListener('change', (e) => {
  ipcRenderer.send('settings:set', 'splashEnabled', e.target.checked);
});

document.getElementById('taskbarProgress').addEventListener('change', (e) => {
  ipcRenderer.send('settings:set', 'taskbarProgressEnabled', e.target.checked);
});

document.getElementById('discord').addEventListener('change', (e) => {
  ipcRenderer.send('settings:set', 'discordEnabled', e.target.checked);
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
