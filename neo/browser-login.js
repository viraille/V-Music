// Connexion Google via le VRAI navigateur de l'utilisateur (Edge / Chrome).
//
// Google refuse la connexion dans les applications Electron ("ce navigateur ou cette
// application ne sont peut-être pas sécurisés"). On ouvre donc la page de connexion dans
// Edge ou Chrome (profil temporaire, vierge), l'utilisateur se connecte normalement, puis
// on récupère uniquement les cookies Google / YouTube de cette session pour les donner à
// V Music. Le profil temporaire est supprimé ensuite.
//
// Le dialogue avec le navigateur passe par le protocole DevTools (WebSocket local), avec un
// petit client WebSocket maison : aucune dépendance en plus.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PROFILE_PREFIX = 'vmusic-login-';

function findBrowser() {
  const env = process.env;
  const list =
    process.platform === 'win32'
      ? [
          env['PROGRAMFILES(X86)'] && path.join(env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          env.PROGRAMFILES && path.join(env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          env.PROGRAMFILES && path.join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          env['PROGRAMFILES(X86)'] && path.join(env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
          env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ]
      : process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/microsoft-edge', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return list.filter(Boolean).find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch (e) {
      return false;
    }
  });
}

// ---------- Client WebSocket minimal (texte uniquement) ----------
function wsConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const req = http.request({
      host: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13',
      },
    });
    req.on('error', reject);
    req.on('response', () => reject(new Error('mise à niveau WebSocket refusée')));
    req.on('upgrade', (res, socket, head) => {
      let buf = Buffer.alloc(0);
      let frags = [];
      const listeners = { message: [], close: [] };
      let closed = false;
      const emitClose = () => {
        if (closed) return;
        closed = true;
        listeners.close.forEach((f) => f());
      };

      const sendFrame = (opcode, payload) => {
        if (closed) return;
        const mask = crypto.randomBytes(4);
        let head2;
        if (payload.length < 126) head2 = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
        else if (payload.length < 65536) {
          head2 = Buffer.alloc(4);
          head2[0] = 0x80 | opcode;
          head2[1] = 0x80 | 126;
          head2.writeUInt16BE(payload.length, 2);
        } else {
          head2 = Buffer.alloc(10);
          head2[0] = 0x80 | opcode;
          head2[1] = 0x80 | 127;
          head2.writeBigUInt64BE(BigInt(payload.length), 2);
        }
        const body = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) body[i] = payload[i] ^ mask[i & 3];
        socket.write(Buffer.concat([head2, mask, body]));
      };

      const parse = () => {
        for (;;) {
          if (buf.length < 2) return;
          const fin = !!(buf[0] & 0x80);
          const op = buf[0] & 0x0f;
          let len = buf[1] & 0x7f;
          let off = 2;
          if (len === 126) {
            if (buf.length < 4) return;
            len = buf.readUInt16BE(2);
            off = 4;
          } else if (len === 127) {
            if (buf.length < 10) return;
            len = Number(buf.readBigUInt64BE(2));
            off = 10;
          }
          if (buf.length < off + len) return;
          const payload = buf.subarray(off, off + len);
          buf = buf.subarray(off + len);
          if (op === 0x8) {
            sendFrame(0x8, Buffer.alloc(0));
            socket.end();
            emitClose();
            return;
          }
          if (op === 0x9) {
            sendFrame(0xa, payload);
            continue;
          }
          if (op === 0xa) continue;
          // 0x1 texte, 0x2 binaire, 0x0 suite
          frags.push(payload);
          if (fin) {
            const text = Buffer.concat(frags).toString('utf8');
            frags = [];
            listeners.message.forEach((f) => f(text));
          }
        }
      };

      socket.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        parse();
      });
      socket.on('close', emitClose);
      socket.on('error', emitClose);
      if (head && head.length) {
        buf = Buffer.from(head);
        parse();
      }
      resolve({
        send: (text) => sendFrame(0x1, Buffer.from(text, 'utf8')),
        onMessage: (f) => listeners.message.push(f),
        onClose: (f) => listeners.close.push(f),
        close: () => {
          try {
            socket.destroy();
          } catch (e) {}
          emitClose();
        },
        get closed() {
          return closed;
        },
      });
    });
    req.end();
  });
}

// ---------- Protocole DevTools ----------
async function cdpConnect(wsUrl) {
  const ws = await wsConnect(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.onMessage((text) => {
    let m;
    try {
      m = JSON.parse(text);
    } catch (e) {
      return;
    }
    const p = m.id && pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.reject(new Error(m.error.message || 'erreur DevTools'));
    else p.resolve(m.result);
  });
  ws.onClose(() => {
    pending.forEach((p) => {
      clearTimeout(p.timer);
      p.reject(new Error('navigateur fermé'));
    });
    pending.clear();
  });
  return {
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        if (ws.closed) return reject(new Error('navigateur fermé'));
        const i = ++id;
        const timer = setTimeout(() => {
          pending.delete(i);
          reject(new Error('délai dépassé'));
        }, 15000);
        pending.set(i, { resolve, reject, timer });
        ws.send(JSON.stringify({ id: i, method, params }));
      });
    },
    onClose: (f) => ws.onClose(f),
    get closed() {
      return ws.closed;
    },
    close: () => ws.close(),
  };
}

// ---------- Cookies ----------
const WANTED_HOST = /(^|\.)(youtube\.com|google\.[a-z]{2,3}(\.[a-z]{2})?)$/i;

// Cookie du navigateur (format DevTools) -> cookie Electron. null = on ne le garde pas.
function toElectronCookie(c, nowSec = Date.now() / 1000) {
  if (!c || !c.name || !c.domain || c.partitionKey) return null;
  const host = c.domain.replace(/^\./, '');
  if (!WANTED_HOST.test(host)) return null;
  const p = c.path || '/';
  const o = {
    url: `https://${host}${p}`,
    name: c.name,
    value: c.value,
    path: p,
    secure: !!c.secure || c.sameSite === 'None',
    httpOnly: !!c.httpOnly,
    sameSite: c.sameSite === 'None' ? 'no_restriction' : c.sameSite === 'Strict' ? 'strict' : c.sameSite === 'Lax' ? 'lax' : 'unspecified',
    // Un cookie de session disparaîtrait à la fermeture de l'app : on le garde 14 jours.
    expirationDate: c.session || !(c.expires > 0) ? nowSec + 14 * 86400 : c.expires,
  };
  if (c.domain.startsWith('.') && !c.name.startsWith('__Host-')) o.domain = c.domain;
  return o;
}

const isLoggedIn = (cookies) =>
  cookies.some((c) => c.name === 'SAPISID' && /(^|\.)youtube\.com$/i.test(c.domain.replace(/^\./, '')));

// ---------- Nettoyage des profils temporaires ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function removeDir(dir, tries = 12) {
  for (let i = 0; i < tries; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch (e) {
      await sleep(500); // fichiers encore verrouillés par le navigateur qui se ferme
    }
  }
  return false;
}

// Au démarrage : supprime les profils temporaires oubliés (plantage, arrêt brutal...).
function cleanupOldProfiles() {
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (name.startsWith(PROFILE_PREFIX)) removeDir(path.join(os.tmpdir(), name), 3);
    }
  } catch (e) {}
}

// Ouvre `url` dans le navigateur `exe` et attend que l'utilisateur soit connecté.
// Résout avec les cookies (format DevTools) ; rejette avec err.code :
//   'launch' (impossible de démarrer / piloter le navigateur), 'closed' (fenêtre fermée
//   avant la connexion), 'timeout'.
async function runExternalLogin({ exe, url, timeoutMs = 15 * 60 * 1000, onStatus = () => {}, extraArgs = [] }) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), PROFILE_PREFIX));
  const fail = (code, msg) => Object.assign(new Error(msg || code), { code });
  let child = null;
  let cdp = null;
  let exited = false;

  const shutdown = () => {
    try {
      if (cdp && !cdp.closed) cdp.call('Browser.close').catch(() => {});
    } catch (e) {}
    setTimeout(() => {
      try {
        if (cdp) cdp.close();
        if (child && !exited) child.kill();
      } catch (e) {}
      setTimeout(() => removeDir(profile), 1500);
    }, 1200);
  };

  try {
    child = spawn(
      exe,
      [
        `--user-data-dir=${profile}`,
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-sync',
        '--window-size=560,800',
        ...extraArgs,
        `--app=${url}`,
      ],
      { stdio: 'ignore' }
    );
    child.on('error', () => {
      exited = true;
    });
    child.on('exit', () => {
      exited = true;
    });

    // Le navigateur écrit le port DevTools dans son profil dès qu'il est prêt.
    let port = null;
    let wsPath = null;
    for (let i = 0; i < 100 && !port; i++) {
      if (exited) throw fail('launch', 'le navigateur s\'est arrêté');
      try {
        const lines = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n');
        if (lines[0] && lines[1]) {
          port = Number(lines[0]);
          wsPath = lines[1].trim();
        }
      } catch (e) {}
      if (!port) await sleep(200);
    }
    if (!port) throw fail('launch', 'port DevTools introuvable');

    try {
      cdp = await cdpConnect(`ws://127.0.0.1:${port}${wsPath}`);
    } catch (e) {
      throw fail('launch', e.message);
    }
    onStatus('waiting');

    const started = Date.now();
    let lastCookies = null;
    for (;;) {
      if (cdp.closed) throw fail('closed');
      if (Date.now() - started > timeoutMs) throw fail('timeout');
      try {
        const { cookies } = await cdp.call('Storage.getCookies');
        lastCookies = cookies || [];
        if (isLoggedIn(lastCookies)) {
          // On attend d'être revenu sur YouTube Music (consentement éventuel compris).
          const { targetInfos } = await cdp.call('Target.getTargets');
          if ((targetInfos || []).some((t) => t.type === 'page' && /^https:\/\/music\.youtube\.com\//.test(t.url))) {
            await sleep(2000);
            const fin = await cdp.call('Storage.getCookies');
            return fin.cookies || lastCookies;
          }
        }
      } catch (e) {
        if (cdp.closed) throw fail('closed');
      }
      await sleep(1500);
    }
  } finally {
    shutdown();
  }
}

module.exports = { findBrowser, runExternalLogin, toElectronCookie, isLoggedIn, cleanupOldProfiles, wsConnect, cdpConnect, PROFILE_PREFIX };
