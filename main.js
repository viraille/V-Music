const { app, BrowserWindow, WebContentsView, session, ipcMain, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const Store = require('electron-store');
const browserLogin = require('./neo/browser-login');

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
    splashEnabled: true,
    uiMode: 'neo', // 'neo' (interface maison, par défaut) ou 'classic' (site YouTube Music restylé)
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

// --- Bloqueur basé sur des listes de filtres (bibliothèque Ghostery) ---
// En plus de notre petite liste ci-dessus, on utilise les listes de filtres
// publiques à jour (type EasyList), que la bibliothèque télécharge et met en
// cache sur le disque. Tout est protégé par des try/catch : si la
// bibliothèque est absente (npm install pas fait), échoue ou n'a pas
// internet au premier lancement, l'appli garde simplement notre blocage
// de base.
//
// On n'utilise que son filtrage réseau (le handler onBeforeRequest) et pas
// enableBlockingInSession : ce dernier dépend d'une API Electron récente
// (registerPreloadScript) absente d'Electron 31.
let listBlocker = null;
const ENGINE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // listes rafraîchies chaque semaine

async function initListBlocker() {
  try {
    const { ElectronBlocker } = require('@ghostery/adblocker-electron');
    const cachePath = path.join(app.getPath('userData'), 'adblock-engine.bin');

    // Cache trop vieux : on le supprime pour forcer un nouveau téléchargement
    // des listes.
    try {
      const { mtimeMs } = await fs.promises.stat(cachePath);
      if (Date.now() - mtimeMs > ENGINE_MAX_AGE_MS) await fs.promises.unlink(cachePath);
    } catch (e) {
      // pas de cache encore, normal au premier lancement
    }

    listBlocker = await ElectronBlocker.fromPrebuiltAdsOnly(fetch, {
      path: cachePath,
      read: fs.promises.readFile,
      write: fs.promises.writeFile,
    });
  } catch (e) {
    console.error('Bloqueur à listes indisponible, blocage de base conservé :', e.message);
    listBlocker = null;
  }
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
    height: 590,
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

// ---------- Écran de lancement (animation requin) ----------
// L'animation s'affiche DANS la fenêtre de l'appli (une vue qui la recouvre)
// pendant que YouTube Music charge. Elle reste au moins le temps de
// l'animation, puis disparaît en fondu.
const SPLASH_MIN_MS = 1100; // animation (~900 ms) + une petite marge
const SPLASH_MAX_MS = 15000; // sécurité : on retire la vue même si le chargement traîne

function attachSplash(win) {
  let view = null;
  try {
    view = new WebContentsView({
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
  } catch (e) {
    return () => {};
  }
  const fit = () => {
    if (win.isDestroyed()) return;
    const [w, h] = win.getContentSize();
    view.setBounds({ x: 0, y: 0, width: w, height: h });
  };
  win.contentView.addChildView(view);
  fit();
  win.on('resize', fit);
  win.on('maximize', fit);
  win.on('unmaximize', fit);
  win.on('enter-full-screen', fit);
  win.on('leave-full-screen', fit);
  view.webContents.loadFile(path.join(__dirname, 'renderer', 'splash.html'), {
    query: { embedded: '1' },
  });

  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    const wc = view.webContents;
    // Fondu de sortie, puis on retire la vue
    try {
      wc.executeJavaScript(
        "document.getElementById('splash').style.transition='opacity 350ms ease';document.getElementById('splash').style.opacity='0';"
      ).catch(() => {});
    } catch (e) {}
    setTimeout(() => {
      try {
        if (!win.isDestroyed()) win.contentView.removeChildView(view);
        if (!wc.isDestroyed()) wc.close();
      } catch (e) {}
    }, 400);
  };
  return remove;
}

// ---------- Blocage des pubs sur la session YouTube Music ----------
let adBlockInstalled = false;
let loginWindow = null;
function setupAdBlock(ytSession) {
  if (adBlockInstalled) return;
  adBlockInstalled = true;
  ytSession.webRequest.onBeforeRequest((details, callback) => {
    // La fenêtre de connexion Google n'est jamais filtrée : on ne touche à rien de ce
    // qu'elle charge, sinon Google peut juger la page "anormale".
    if (loginWindow && !loginWindow.isDestroyed() && details.webContentsId === loginWindow.webContents.id) {
      callback({ cancel: false });
      return;
    }
    if (!store.get('adBlockEnabled', true)) {
      callback({ cancel: false });
      return;
    }
    if (isAdRequest(details.url)) {
      callback({ cancel: true });
      return;
    }

    // Listes de filtres (si chargées). Le garde "answered" évite de répondre
    // deux fois à Electron si la bibliothèque plante après avoir répondu.
    let answered = false;
    const respond = (response) => {
      if (answered) return;
      answered = true;
      callback(response);
    };
    if (listBlocker) {
      try {
        listBlocker.onBeforeRequest(details, respond);
        return;
      } catch (e) {
        // on retombe sur "ne pas bloquer" ci-dessous
      }
    }
    respond({ cancel: false });
  });
}

// ---------- Fenêtre principale ----------
function createWindow() {
  const useSplash = store.get('splashEnabled', true);
  const splashStartedAt = Date.now();

  const ytSession = session.fromPartition('persist:ytmusic-custom');

  setupAdBlock(ytSession);

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

  // Animation de lancement par-dessus la page, retirée quand YouTube Music est chargé
  if (useSplash) {
    const removeSplash = attachSplash(win);
    const done = () => {
      const wait = Math.max(0, SPLASH_MIN_MS - (Date.now() - splashStartedAt));
      setTimeout(removeSplash, wait);
    };
    win.webContents.once('did-finish-load', done);
    setTimeout(removeSplash, SPLASH_MAX_MS);
  }

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


// ---------- Nouvelle interface ("neo") ----------
// La fenêtre affiche notre propre interface (renderer/neo). Le son vient d'une
// page YouTube Music cachée, le "moteur" : même session connectée, même
// blocage de pub. L'interface lui envoie des commandes et lit son état.
const { createApi } = require('./neo/api');
let engineWindow = null;
let engineLoadedOnce = false;
let latestEngineState = null;
let appQuitting = false;

function engineLoaded(timeout = 20000) {
  return new Promise((resolve) => {
    const wc = engineWindow && !engineWindow.isDestroyed() ? engineWindow.webContents : null;
    if (!wc) return resolve();
    if (engineLoadedOnce && !wc.isLoading()) return resolve();
    const done = () => {
      clearTimeout(timer);
      wc.removeListener('did-finish-load', done);
      resolve();
    };
    const timer = setTimeout(done, timeout);
    wc.once('did-finish-load', done);
  });
}

const neoApi = createApi(
  () => (engineWindow && !engineWindow.isDestroyed() ? engineWindow.webContents : null),
  engineLoaded,
  app.isPackaged ? null : path.join(__dirname, 'debug')
);

// Connexion Google : une fenêtre dédiée, "propre" (aucun script injecté, aucun filtre),
// qui partage la session de l'app. Elle se referme toute seule dès que la connexion
// est réussie, puis le moteur recharge YouTube Music avec le compte connecté.
const LOGIN_URL =
  'https://accounts.google.com/ServiceLogin?service=youtube&continue=' +
  encodeURIComponent('https://music.youtube.com/');

function notifyLogin() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('neo:login-done');
}

// Identité "Chrome" complète et cohérente : l'en-tête User-Agent, les indices client
// (sec-ch-ua) et navigator.userAgentData disent tous la même chose. Google refuse
// les navigateurs dont ces éléments se contredisent ou trahissent Electron.
const withTimeout = (p, ms) => Promise.race([p, new Promise((resolve) => setTimeout(resolve, ms))]);

async function presentAsChrome(wc) {
  const full = process.versions.chrome;
  const major = full.split('.')[0];
  const plat =
    process.platform === 'darwin'
      ? { ua: 'Macintosh; Intel Mac OS X 10_15_7', nav: 'MacIntel', name: 'macOS', ver: '14.0.0', arch: 'arm' }
      : process.platform === 'linux'
      ? { ua: 'X11; Linux x86_64', nav: 'Linux x86_64', name: 'Linux', ver: '6.0.0', arch: 'x86' }
      : { ua: 'Windows NT 10.0; Win64; x64', nav: 'Win32', name: 'Windows', ver: '10.0.0', arch: 'x86' };
  const ua = `Mozilla/5.0 (${plat.ua}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  wc.setUserAgent(ua);
  const loc = app.getLocale() || 'en-US';
  const base = loc.split('-')[0];
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    await withTimeout(wc.debugger.sendCommand('Emulation.setUserAgentOverride', {
      userAgent: ua,
      acceptLanguage: base === loc ? loc : `${loc},${base}`,
      platform: plat.nav,
      userAgentMetadata: {
        brands: [
          { brand: 'Chromium', version: major },
          { brand: 'Google Chrome', version: major },
          { brand: 'Not/A)Brand', version: '8' },
        ],
        fullVersionList: [
          { brand: 'Chromium', version: full },
          { brand: 'Google Chrome', version: full },
          { brand: 'Not/A)Brand', version: '8.0.0.0' },
        ],
        fullVersion: full,
        platform: plat.name,
        platformVersion: plat.ver,
        architecture: plat.arch,
        model: '',
        mobile: false,
        bitness: '64',
        wow64: false,
      },
    }), 2500);
    // Secondaire : on n'attend pas la réponse.
    wc.debugger
      .sendCommand('Page.enable')
      .then(() =>
        wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
          source: "if (!window.chrome) { Object.defineProperty(window, 'chrome', { value: { app: { isInstalled: false }, runtime: {} }, configurable: true }); }",
        })
      )
      .catch(() => {});
  } catch (e) {
    // sans le débogueur on garde au moins le User-Agent propre
  }
}

// Après une connexion réussie : le moteur recharge YouTube Music avec le compte connecté,
// puis l'interface rafraîchit la photo de profil et les listes.
function afterLogin() {
  latestEngineState = null;
  if (engineWindow && !engineWindow.isDestroyed()) {
    engineWindow.webContents.once('did-finish-load', () => setTimeout(notifyLogin, 300));
    engineWindow.webContents.loadURL(MUSIC_ORIGIN);
  } else {
    notifyLogin();
  }
}

// Méthode principale : Google accepte la connexion dans Edge / Chrome (pas dans une appli
// Electron). On y ouvre la page de connexion, puis on récupère la session.
let loginBusy = false;
async function importGoogleCookies(cookies) {
  const ses = session.fromPartition('persist:ytmusic-custom');
  const list = cookies.map((c) => browserLogin.toElectronCookie(c)).filter(Boolean);
  await Promise.all(list.map((c) => ses.cookies.set(c).catch(() => {})));
  try {
    await ses.cookies.flushStore();
  } catch (e) {}
  return list.length;
}

function openLogin() {
  if (loginBusy) return;
  const exe = browserLogin.findBrowser();
  if (!exe) {
    openEmbeddedLogin();
    return;
  }
  loginBusy = true;
  browserLogin
    .runExternalLogin({ exe, url: LOGIN_URL })
    .then(async (cookies) => {
      const n = await importGoogleCookies(cookies);
      if (n) afterLogin();
    })
    .catch((e) => {
      // Fenêtre fermée / délai dépassé : rien à faire. Navigateur inutilisable : secours.
      if (e && e.code === 'launch') openEmbeddedLogin();
    })
    .finally(() => {
      loginBusy = false;
    });
}

// Secours (aucun Edge/Chrome trouvé) : fenêtre intégrée, que Google peut refuser.
function openEmbeddedLogin() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.show();
    loginWindow.focus();
    return;
  }
  const ytSession = session.fromPartition('persist:ytmusic-custom');
  const w = new BrowserWindow({
    width: 520,
    height: 760,
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    title: 'Connexion à Google',
    backgroundColor: '#202124',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: { session: ytSession, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  loginWindow = w;
  const wc = w.webContents;
  let finished = false;
  let checking = false;

  w.on('closed', () => {
    loginWindow = null;
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  const finish = () => {
    if (finished) return;
    finished = true;
    if (!w.isDestroyed()) w.close();
    afterLogin();
  };

  // Connexion réussie = on est revenu sur YouTube Music ET le cookie de session existe.
  const check = async () => {
    if (finished || checking || w.isDestroyed()) return;
    if (!isMusicUrl(wc.getURL())) return;
    checking = true;
    try {
      for (let i = 0; i < 6 && !finished && !w.isDestroyed(); i++) {
        const cookies = await ytSession.cookies.get({ name: 'SAPISID' });
        if (cookies.length) return finish();
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (e) {
      // on réessaiera à la prochaine navigation
    } finally {
      checking = false;
    }
  };
  wc.on('did-navigate', check);
  wc.on('did-finish-load', check);

  // La fenêtre s'affiche tout de suite ; la page de connexion se charge dès que l'identité
  // "Chrome" est en place (ou après 3,5 s au plus, quoi qu'il arrive).
  withTimeout(presentAsChrome(wc).catch(() => {}), 3500).then(() => {
    if (w.isDestroyed()) return;
    wc.loadURL(LOGIN_URL).catch(() => {});
  });
}

function createEngineWindow(ytSession) {
  const eng = new BrowserWindow({
    width: 1000,
    height: 720,
    show: false,
    title: 'YouTube Music (moteur)',
    backgroundColor: '#0b0b0f',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      session: ytSession,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
      backgroundThrottling: false, // la lecture ne doit jamais ralentir en arrière-plan
    },
  });
  engineWindow = eng;

  // Google refuse la connexion dans un navigateur qui se déclare "Electron" :
  // on présente la même identité que Chrome.
  eng.webContents.setUserAgent(
    eng.webContents.getUserAgent().replace(/\s(Electron|ytmusic-custom|v-music)\/\S+/gi, '')
  );

  const lastUrl = store.get('lastUrl');
  eng.loadURL(isMusicUrl(lastUrl) ? lastUrl : MUSIC_ORIGIN);

  const rememberUrl = (event, url, isMainFrame) => {
    if (isMainFrame === false) return;
    if (isMusicUrl(url)) store.set('lastUrl', url);
  };
  // Sans cookies (après une déconnexion, ou au premier lancement), YouTube peut afficher sa
  // page de consentement : on montre alors la fenêtre du moteur pour que tu puisses répondre,
  // puis elle se cache toute seule dès qu'on est revenu sur YouTube Music.
  let consentShown = false;
  eng.webContents.on('did-navigate', (event, url) => {
    if (/^https:\/\/consent\.(youtube|google)\.com\//.test(url)) {
      consentShown = true;
      eng.setTitle('YouTube Music : consentement');
      eng.setSize(1000, 720);
      eng.center();
      eng.show();
    } else if (consentShown && isMusicUrl(url)) {
      consentShown = false;
      eng.hide();
    }
  });
  eng.webContents.on('did-navigate', rememberUrl);
  eng.webContents.on('did-navigate-in-page', rememberUrl);
  eng.webContents.on('will-prevent-unload', (event) => event.preventDefault());

  eng.webContents.on('did-finish-load', () => {
    engineLoadedOnce = true;
    const read = (...p) => fs.readFileSync(path.join(__dirname, ...p), 'utf8');
    // Jamais de script injecté ailleurs que sur YouTube Music (surtout pas sur une page Google).
    if (!isMusicUrl(eng.webContents.getURL())) return;
    eng.webContents.executeJavaScript(read('renderer', 'inject.js')).catch(() => {});
    eng.webContents.executeJavaScript(read('renderer', 'neo', 'engine.js')).catch(() => {});
  });

  // La croix de cette fenêtre la cache seulement : la lecture continue.
  eng.on('close', (e) => {
    if (!appQuitting) {
      e.preventDefault();
      eng.hide();
    }
  });
  eng.on('closed', () => {
    engineWindow = null;
  });
  return eng;
}

function createNeoWindow() {
  const useSplash = store.get('splashEnabled', true);
  const startedAt = Date.now();
  const ytSession = session.fromPartition('persist:ytmusic-custom');
  setupAdBlock(ytSession);

  const savedBounds = getRestorableBounds();
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 340,
    minHeight: 420,
    ...(savedBounds || {}),
    backgroundColor: '#111116',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'neo', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = win;
  if (store.get('windowMaximized', false)) win.maximize();

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

  // Liens externes : dans le navigateur, jamais dans notre fenêtre
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  if (useSplash) {
    const removeSplash = attachSplash(win);
    win.webContents.once('did-finish-load', () => {
      setTimeout(removeSplash, Math.max(0, SPLASH_MIN_MS - (Date.now() - startedAt)));
    });
    setTimeout(removeSplash, SPLASH_MAX_MS);
  }

  createEngineWindow(ytSession);
  win.loadFile(path.join(__dirname, 'renderer', 'neo', 'index.html'));

  win.on('closed', () => {
    mainWindow = null;
    appQuitting = true;
    if (engineWindow && !engineWindow.isDestroyed()) engineWindow.destroy();
  });
  return win;
}

// Pendant qu'une nouvelle page se charge, YouTube Music peut jouer quelques secondes
// n'importe quoi (un ancien morceau mémorisé...). On coupe le son du moteur jusqu'à ce que
// le bon morceau soit réellement en lecture.
let muteUntil = null; // identifiant attendu ('' = n'importe lequel qui joue vraiment)
let muteTimer = null;
function unmuteEngine() {
  clearTimeout(muteTimer);
  muteUntil = null;
  if (engineWindow && !engineWindow.isDestroyed()) engineWindow.webContents.setAudioMuted(false);
}
function muteEngineUntil(videoId) {
  if (!engineWindow || engineWindow.isDestroyed()) return;
  muteUntil = videoId || '';
  engineWindow.webContents.setAudioMuted(true);
  clearTimeout(muteTimer);
  muteTimer = setTimeout(unmuteEngine, 12000); // sécurité : jamais muet indéfiniment
}

function neoPlay(target) {
  if (!engineWindow || engineWindow.isDestroyed() || !target) return;
  const videoId = /^[\w-]{6,20}$/.test(target.videoId || '') ? target.videoId : '';
  const playlistId = /^[\w-]{5,80}$/.test(target.playlistId || '') ? target.playlistId : '';
  if (!videoId && !playlistId) return;
  const wc = engineWindow.webContents;
  const url = videoId
    ? `${MUSIC_ORIGIN}/watch?v=${videoId}${playlistId ? `&list=${playlistId}` : ''}`
    : `${MUSIC_ORIGIN}/watch?list=${playlistId}`;
  const hardLoad = () => {
    if (!engineWindow || engineWindow.isDestroyed()) return;
    muteEngineUntil(videoId);
    engineWindow.webContents.loadURL(url);
  };
  // Avec une playlist/album, on recharge toujours : c'est ce qui garantit que la file
  // d'attente est bien celle de la playlist (et que « suivant » passe au morceau suivant).
  if (!videoId || playlistId) return hardLoad();
  // D'abord un changement "en place" (instantané). On vérifie que ça a marché, sinon on recharge.
  wc.executeJavaScript(
    `window.__neo ? window.__neo.open(${JSON.stringify(videoId)}, ${JSON.stringify(playlistId)}) : false`
  )
    .then((ok) => {
      if (!ok) return hardLoad();
      setTimeout(() => {
        if (!latestEngineState || latestEngineState.videoId !== videoId) hardLoad();
      }, 3000);
    })
    .catch(hardLoad);
}

const NEO_COMMANDS = new Set(['toggle', 'play', 'pause', 'next', 'prev', 'seek', 'volume', 'hold']);

ipcMain.handle('neo:home', () => neoApi.home());
ipcMain.handle('neo:search', (e, q, params) => neoApi.search(String(q || '').slice(0, 200), params ? String(params) : ''));
ipcMain.handle('neo:browse', (e, id) => neoApi.browse(String(id || '')));
ipcMain.handle('neo:more', (e, token, kind) => neoApi.more(String(token || ''), kind === 'search' ? 'search' : 'browse'));
ipcMain.handle('neo:service', (e, spec) => neoApi.service(spec));
ipcMain.handle('neo:playlistsFor', (e, videoId) => neoApi.playlistsFor(String(videoId || '')));
ipcMain.handle('neo:addToPlaylist', (e, playlistId, videoId) => neoApi.addToPlaylist(String(playlistId || ''), String(videoId || '')));
ipcMain.handle('neo:account', () => neoApi.account());
ipcMain.handle('neo:logout', async () => {
  // Déconnexion : on efface les cookies de connexion de cette appli (pas ceux de ton navigateur)
  const ses = session.fromPartition('persist:ytmusic-custom');
  await ses.clearStorageData({ storages: ['cookies'] });
  try { await ses.cookies.flushStore(); } catch (e) {}
  latestEngineState = null;
  if (engineWindow && !engineWindow.isDestroyed()) engineWindow.webContents.loadURL(MUSIC_ORIGIN);
  notifyLogin();
  return true;
});
ipcMain.handle('neo:library', (e, kind) => neoApi.library(String(kind || '')));
ipcMain.handle('neo:getState', () => latestEngineState);
ipcMain.on('neo:play', (e, target) => neoPlay(target));
ipcMain.on('neo:cmd', (e, name, arg) => {
  if (!NEO_COMMANDS.has(name) || !engineWindow || engineWindow.isDestroyed()) return;
  const a =
    typeof arg === 'number' && Number.isFinite(arg) ? String(arg) : typeof arg === 'boolean' ? String(arg) : '';
  engineWindow.webContents
    .executeJavaScript(`window.__neo && window.__neo.${name}(${a})`)
    .catch(() => {});
});
ipcMain.on('neo:login', () => openLogin());
// Montre la page YouTube Music cachée (consentement, vérification...) quand quelque chose bloque.
ipcMain.on('neo:showEngine', () => {
  if (!engineWindow || engineWindow.isDestroyed()) return;
  engineWindow.setSize(1000, 720);
  engineWindow.center();
  engineWindow.show();
  engineWindow.focus();
});
ipcMain.on('engine:state', (event, state) => {
  if (!engineWindow || event.sender !== engineWindow.webContents) return;
  latestEngineState = state;
  if (muteUntil !== null && state.isPlaying && state.currentTime > 0.2 && state.playerId &&
      (!muteUntil || state.playerId === muteUntil)) {
    unmuteEngine();
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('neo:state', state);
});

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
  // Sans await : la fenêtre s'ouvre tout de suite, les listes s'activent dès
  // qu'elles sont prêtes.
  initListBlocker();
  browserLogin.cleanupOldProfiles(); // profils temporaires de connexion oubliés (cookies)
  if (store.get('uiMode', 'neo') === 'neo') createNeoWindow();
  else createWindow();
  if (store.get('overlayEnabled', false)) startOverlayServer();
  setInterval(flushPlayback, 5000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (store.get('uiMode', 'neo') === 'neo') createNeoWindow();
      else createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  appQuitting = true;
  flushPlayback();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(-1);
  stopOverlayServer();
  // Signale l'arrêt tout de suite plutôt que d'attendre le timeout côté
  // serveur. Best-effort : on ne bloque pas la fermeture si ça échoue.
  lastReportSentAt = 0; // force l'envoi malgré le throttle
  sendReport({ trackTitle: '', trackArtist: '', isPlaying: false }).catch(() => {});
});
