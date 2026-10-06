const { app, BrowserWindow, session, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const Store = require('electron-store');

// Dashboard : table Supabase "listening_status", pas de serveur perso à
// exposer. La clé ici est la clé publique "publishable" (sb_publishable_...),
// faite pour être embarquée côté client — jamais la clé secrète.
const SUPABASE_URL = 'https://lzybmblhxsjsazcqpcsc.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_5ePk4hVX1n15QahRgDWvLQ_G-neHf1G';

const store = new Store({
  defaults: {
    adBlockEnabled: true,
    animationsEnabled: true,
    taskbarProgressEnabled: true,
    overlayEnabled: false,
    overlayPort: 47811,
    reportingEnabled: true,
    reportingUsername: os.userInfo().username,
    reportingClientId: null,
    windowBounds: null,
    windowMaximized: false,
    lastUrl: null,
    lastPlayback: null, // { videoId, position }
  },
});

// ID stable qui identifie ce poste auprès du dashboard, généré une seule
// fois puis conservé sur disque.
if (!store.get('reportingClientId')) {
  store.set('reportingClientId', crypto.randomUUID());
}

// --- Liste de domaines/segments d'URL liés à la pub et au tracking ---
const AD_BLOCK_PATTERNS = [
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'google-analytics.com',
  'adservice.google.',
  'pagead2.googlesyndication.com',
  'static.doubleclick.net',
  'tpc.googlesyndication.com',
  'securepubads.g.doubleclick.net',
  'imasdk.googleapis.com',
  '2mdn.net',
  '/pagead/',
  '/api/stats/ads',
  '/api/stats/qoe',
  '/api/stats/atr',
  '/ptracking',
  'get_midroll',
  'ad_break',
  'youtubei/v1/log_event',
  'youtubei/v1/att/get',
];

function isAdRequest(url) {
  return AD_BLOCK_PATTERNS.some((pattern) => url.includes(pattern));
}

let mainWindow = null;
let settingsWindow = null;

// ---------- Serveur overlay pour OBS ----------
// Petit serveur HTTP local (sans dépendance externe) qui sert une page
// overlay.html et pousse l'état de lecture en temps réel via
// Server-Sent Events. À coller dans une source "Navigateur" OBS.
let overlayServer = null;
const overlaySSEClients = new Set();
let lastOverlayState = null;

function broadcastOverlayState(state) {
  lastOverlayState = state;
  if (overlaySSEClients.size === 0) return;
  const payload = `data: ${JSON.stringify(state)}\n\n`;
  overlaySSEClients.forEach((res) => res.write(payload));
}

function startOverlayServer() {
  if (overlayServer) return;
  const port = store.get('overlayPort', 47811);

  overlayServer = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      const html = fs.readFileSync(
        path.join(__dirname, 'renderer', 'overlay.html'),
        'utf8'
      );
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (req.url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('\n');
      overlaySSEClients.add(res);
      if (lastOverlayState) {
        res.write(`data: ${JSON.stringify(lastOverlayState)}\n\n`);
      }
      req.on('close', () => overlaySSEClients.delete(res));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  overlayServer.on('error', (err) => {
    console.error('Overlay OBS : erreur serveur', err.message);
    overlayServer = null;
  });

  overlayServer.listen(port, '0.0.0.0');
}

function stopOverlayServer() {
  if (!overlayServer) return;
  overlaySSEClients.forEach((res) => res.end());
  overlaySSEClients.clear();
  overlayServer.close();
  overlayServer = null;
}

// ---------- Rapport vers le dashboard (Supabase) ----------
// Envoie l'état de lecture dans la table "listening_status" d'un projet
// Supabase, pour un dashboard "qui écoute quoi" partagé entre plusieurs
// postes, où qu'ils soient (pas besoin d'être sur le même réseau). Un
// upsert par client_id : chaque poste a une seule ligne, mise à jour en
// continu plutôt que d'accumuler un historique.
let lastReportSentAt = 0;
const REPORT_MIN_INTERVAL_MS = 3000; // throttle, pas la peine de spammer

async function sendReport(state) {
  if (!store.get('reportingEnabled', false)) return;

  const now = Date.now();
  if (now - lastReportSentAt < REPORT_MIN_INTERVAL_MS) return;
  lastReportSentAt = now;

  const payload = {
    client_id: store.get('reportingClientId'),
    username: store.get('reportingUsername', os.userInfo().username),
    track_title: state.trackTitle || '',
    track_artist: state.trackArtist || '',
    is_playing: Boolean(state.isPlaying),
    updated_at: new Date().toISOString(),
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    await fetch(
      `${SUPABASE_URL}/rest/v1/listening_status?on_conflict=client_id`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_PUBLISHABLE_KEY,
          Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify([payload]),
        signal: controller.signal,
      }
    );
    clearTimeout(timeout);
  } catch (e) {
    // Supabase injoignable (pas de réseau, etc.), pas grave : on retentera
    // au prochain report. Pas d'erreur remontée à l'UI pour rester discret.
  }
}

// ---------- Fenêtre de paramètres ----------
function openSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 380,
    height: 460,
    resizable: false,
    title: 'Paramètres',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    parent: mainWindow || undefined,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

// ---------- Mémoire de la fenêtre, de la page et de la lecture ----------
const MUSIC_ORIGIN = 'https://music.youtube.com';

function isMusicUrl(url) {
  return typeof url === 'string' && url.startsWith(MUSIC_ORIGIN + '/');
}

// Position/taille sauvegardées, utilisées seulement si la barre de titre
// tombe encore sur un écran (écran débranché, résolution changée...).
function getRestorableBounds() {
  const b = store.get('windowBounds');
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return null;
  const px = b.x + b.width / 2;
  const py = b.y + 20;
  const onScreen = screen.getAllDisplays().some(({ workArea: a }) =>
    px >= a.x && px < a.x + a.width && py >= a.y && py < a.y + a.height
  );
  return onScreen ? b : null;
}

function saveWindowBounds(win) {
  if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
  store.set('windowMaximized', win.isMaximized());
  store.set('windowBounds', win.getNormalBounds());
}

// Dernière position de lecture reçue de la page. Gardée en mémoire et écrite
// sur disque toutes les 5 s (et à la fermeture) pour ne pas écrire à chaque
// seconde.
let pendingPlayback = null;
let resumeConsumed = false;

function flushPlayback() {
  if (!pendingPlayback) return;
  store.set('lastPlayback', pendingPlayback);
  pendingPlayback = null;
}

// ---------- Fenêtre principale ----------
function createWindow() {
  const ytSession = session.fromPartition('persist:ytmusic-custom');

  ytSession.webRequest.onBeforeRequest((details, callback) => {
    const shouldBlock = store.get('adBlockEnabled', true) && isAdRequest(details.url);
    callback({ cancel: shouldBlock });
  });

  const savedBounds = getRestorableBounds();

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    ...(savedBounds || {}),
    backgroundColor: '#0b0b0f',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      session: ytSession,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
    },
  });

  mainWindow = win;
  if (store.get('windowMaximized', false)) win.maximize();

  // Sauvegarde de la position/taille (avec un petit délai pour ne pas
  // écrire pendant tout le glisser/redimensionner).
  let boundsTimer = null;
  const scheduleSaveBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => saveWindowBounds(win), 500);
  };
  win.on('resize', scheduleSaveBounds);
  win.on('move', scheduleSaveBounds);
  win.on('maximize', scheduleSaveBounds);
  win.on('unmaximize', scheduleSaveBounds);
  win.on('close', () => {
    clearTimeout(boundsTimer);
    saveWindowBounds(win);
  });

  // On rouvre la dernière page de YouTube Music visitée plutôt que
  // l'accueil.
  const lastUrl = store.get('lastUrl');
  win.loadURL(isMusicUrl(lastUrl) ? lastUrl : MUSIC_ORIGIN);

  const rememberUrl = (event, url, isMainFrame) => {
    if (isMainFrame === false) return;
    if (isMusicUrl(url)) store.set('lastUrl', url);
  };
  win.webContents.on('did-navigate', rememberUrl);
  win.webContents.on('did-navigate-in-page', rememberUrl);

  // Empêche YouTube Music de bloquer la fermeture de la fenêtre avec un
  // prompt natif "Quitter le site ?" quand une musique est en cours de
  // lecture (comportement standard des pages web via beforeunload).
  win.webContents.on('will-prevent-unload', (event) => {
    event.preventDefault();
  });

  win.webContents.on('did-finish-load', () => {
    const baseCss = fs.readFileSync(
      path.join(__dirname, 'renderer', 'base.css'),
      'utf8'
    );
    win.webContents.insertCSS(baseCss);

    if (store.get('animationsEnabled', true)) {
      const animCss = fs.readFileSync(
        path.join(__dirname, 'renderer', 'animations.css'),
        'utf8'
      );
      win.webContents.insertCSS(animCss);
    }

    const js = fs.readFileSync(
      path.join(__dirname, 'renderer', 'inject.js'),
      'utf8'
    );
    win.webContents.executeJavaScript(js).catch(() => {});
  });

  win.on('closed', () => {
    mainWindow = null;
  });

  return win;
}

// ---------- IPC ----------
ipcMain.handle('settings:get', () => store.store);

ipcMain.on('settings:set', (event, key, value) => {
  store.set(key, value);

  if (key === 'taskbarProgressEnabled' && !value && mainWindow) {
    mainWindow.setProgressBar(-1);
  }
  if (key === 'overlayEnabled') {
    if (value) startOverlayServer();
    else stopOverlayServer();
  }
});

ipcMain.handle('overlay:getUrl', () => {
  return `http://localhost:${store.get('overlayPort', 47811)}`;
});

ipcMain.on('open-settings', () => openSettingsWindow());

ipcMain.on('progress:update', (event, ratio, isPlaying) => {
  if (!mainWindow) return;
  if (!store.get('taskbarProgressEnabled', true)) {
    mainWindow.setProgressBar(-1);
    return;
  }
  const value = Number.isFinite(ratio) ? Math.min(Math.max(ratio, 0), 1) : 0;
  mainWindow.setProgressBar(value, { mode: isPlaying ? 'normal' : 'paused' });
});

ipcMain.on('report:send', (event, state) => {
  sendReport(state);
  broadcastOverlayState(state);
});

ipcMain.handle('report:getClientId', () => store.get('reportingClientId'));

ipcMain.on('playback:save', (event, state) => {
  if (!state || typeof state.videoId !== 'string' || !Number.isFinite(state.position)) return;
  pendingPlayback = { videoId: state.videoId, position: state.position };
});

// Ne rend la position sauvegardée qu'une seule fois par lancement, pour
// qu'un simple rechargement de page en cours de session ne ramène pas la
// lecture en arrière.
ipcMain.handle('playback:getResume', () => {
  if (resumeConsumed) return null;
  resumeConsumed = true;
  return store.get('lastPlayback', null);
});

// ---------- Cycle de vie ----------
app.whenReady().then(() => {
  createWindow();
  if (store.get('overlayEnabled', false)) startOverlayServer();
  setInterval(flushPlayback, 5000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  flushPlayback();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(-1);
  stopOverlayServer();
  // Signale l'arrêt tout de suite plutôt que d'attendre le timeout côté
  // serveur. Best-effort : on ne bloque pas la fermeture si ça échoue.
  lastReportSentAt = 0; // force l'envoi malgré le throttle
  sendReport({ trackTitle: '', trackArtist: '', isPlaying: false }).catch(() => {});
});
