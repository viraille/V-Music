// Statut Discord (« Rich Presence ») : affiche le titre en cours dans le profil Discord.
//
// Aucune connexion à faire : on parle à l'appli Discord ouverte sur le PC, par son canal
// local (\\?\pipe\discord-ipc-0 à 9), comme Spotify ou les jeux. Si Discord n'est pas lancé,
// on réessaie de temps en temps, sans rien afficher.
//
// Protocole : chaque message = [opcode int32 LE][taille int32 LE][JSON].
// 0 = poignée de main, 1 = commande/réponse, 2 = fermeture, 3 = ping, 4 = pong.

const net = require('net');
const path = require('path');

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

const RETRY_MS = 15000; // Discord fermé : on réessaie toutes les 15 s
const MIN_SEND_MS = 2500; // Discord limite à 5 changements de statut par 20 s
const PAUSE_CLEAR_MS = 10000; // en pause depuis 10 s : on retire le statut
const LOGO_URL = 'https://raw.githubusercontent.com/viraille/V-Music/main/renderer/neo/logo.jpg';

function pipePath(i) {
  return process.platform === 'win32'
    ? `\\\\?\\pipe\\discord-ipc-${i}`
    : path.join(process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || '/tmp', `discord-ipc-${i}`);
}

function encode(op, data) {
  const json = Buffer.from(JSON.stringify(data), 'utf8');
  const header = Buffer.alloc(8);
  header.writeInt32LE(op, 0);
  header.writeInt32LE(json.length, 4);
  return Buffer.concat([header, json]);
}

// Discord veut entre 2 et 128 caractères
function text(s, fallback) {
  let t = String(s || '').trim() || fallback;
  if (t.length < 2) t = t + ' ';
  return t.length > 128 ? t.slice(0, 127) + '…' : t;
}

// Pochette en grand format ; Discord refuse les adresses de plus de 256 caractères.
function artworkUrl(state) {
  const art = String(state.artwork || '')
    .replace(/=w\d+-h\d+[^&?]*$/, '=w512-h512-l90-rj')
    .replace(/=s\d+[^&?]*$/, '=s512');
  if (/^https:\/\//.test(art) && art.length <= 256) return art;
  if (state.videoId) return `https://i.ytimg.com/vi/${state.videoId}/hqdefault.jpg`;
  return LOGO_URL;
}

function createDiscordPresence(clientId) {
  let enabled = false;
  let sock = null;
  let ready = false;
  let connecting = false;
  let retryTimer = null;
  let buffer = Buffer.alloc(0);
  let nonce = 0;

  let wanted = null; // activité à afficher (null = rien)
  let sentKey = ''; // dernière activité envoyée (pour ne pas renvoyer la même)
  let lastSentAt = 0;
  let sendTimer = null;
  let pausedSince = 0;
  let lastTrack = null; // { key, start } pour repérer un saut dans le morceau

  function scheduleRetry() {
    clearTimeout(retryTimer);
    if (enabled) retryTimer = setTimeout(connect, RETRY_MS);
  }

  function cleanup() {
    ready = false;
    connecting = false;
    sentKey = '';
    buffer = Buffer.alloc(0);
    if (sock) {
      sock.removeAllListeners();
      sock.on('error', () => {});
      sock.destroy();
      sock = null;
    }
  }

  function tryPipe(i) {
    if (i > 9) {
      connecting = false;
      scheduleRetry();
      return;
    }
    const s = net.createConnection(pipePath(i));
    s.once('connect', () => {
      sock = s;
      s.removeAllListeners('error');
      s.on('error', () => {});
      s.on('close', () => {
        cleanup();
        scheduleRetry();
      });
      s.on('data', onData);
      s.write(encode(OP_HANDSHAKE, { v: 1, client_id: clientId }));
    });
    s.once('error', () => {
      s.destroy();
      tryPipe(i + 1);
    });
  }

  function connect() {
    clearTimeout(retryTimer);
    if (!enabled || !clientId || sock || connecting) return;
    connecting = true;
    tryPipe(0);
  }

  function onData(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 8) {
      const op = buffer.readInt32LE(0);
      const len = buffer.readInt32LE(4);
      if (buffer.length < 8 + len) return;
      let msg = null;
      try {
        msg = JSON.parse(buffer.subarray(8, 8 + len).toString('utf8'));
      } catch (e) {}
      buffer = buffer.subarray(8 + len);
      if (op === OP_PING && sock) sock.write(encode(OP_PONG, msg || {}));
      else if (op === OP_CLOSE) {
        // Identifiant d'appli refusé, Discord qui ferme... on laisse tomber et on réessaiera
        console.error('Discord : connexion fermée', msg && msg.message);
        cleanup();
        scheduleRetry();
        return;
      } else if (op === OP_FRAME && msg) {
        if (msg.evt === 'READY') {
          ready = true;
          connecting = false;
          flush(true);
        } else if (msg.evt === 'ERROR') {
          console.error('Discord : statut refusé', msg.data && msg.data.message);
        }
      }
    }
  }

  function send(activity) {
    if (!sock || !ready) return;
    nonce += 1;
    sock.write(
      encode(OP_FRAME, {
        cmd: 'SET_ACTIVITY',
        args: { pid: process.pid, ...(activity ? { activity } : {}) },
        nonce: String(nonce),
      })
    );
  }

  // Envoie l'activité voulue si elle a changé, en respectant la limite de Discord.
  function flush(force) {
    clearTimeout(sendTimer);
    if (!ready) return;
    const key = JSON.stringify(wanted);
    if (!force && key === sentKey) return;
    const wait = MIN_SEND_MS - (Date.now() - lastSentAt);
    if (wait > 0 && !force) {
      sendTimer = setTimeout(() => flush(false), wait);
      return;
    }
    lastSentAt = Date.now();
    sentKey = key;
    send(wanted);
  }

  // Appelé avec l'état de lecture (environ une fois par seconde).
  function update(state) {
    if (!enabled) return;
    const title = state && state.trackTitle;
    if (!title) {
      wanted = null;
      lastTrack = null;
      return flush(false);
    }
    if (!state.isPlaying) {
      if (!pausedSince) pausedSince = Date.now();
      // Petite pause (changement de titre, chargement) : on garde le statut
      if (Date.now() - pausedSince < PAUSE_CLEAR_MS) return;
      wanted = null;
      lastTrack = null;
      return flush(false);
    }
    pausedSince = 0;

    const key = (state.videoId || '') + '|' + title;
    const duration = Number(state.duration) || 0;
    const current = Number(state.currentTime) || 0;
    let start = Date.now() - current * 1000;
    // Même morceau et pas de saut (plus de 3 s d'écart) : on garde le même départ,
    // sinon la barre de progression bougerait à chaque seconde.
    if (lastTrack && lastTrack.key === key && Math.abs(lastTrack.start - start) < 3000) start = lastTrack.start;
    lastTrack = { key, start };

    const activity = {
      type: 2, // « Écoute »
      details: text(title, 'Titre inconnu'),
      state: text(state.artist || state.trackArtist, 'V Music'),
      assets: {
        large_image: artworkUrl(state),
        large_text: text(state.album || title, 'V Music'),
        small_image: LOGO_URL,
        small_text: 'V Music',
      },
    };
    if (duration > 0 && current <= duration) {
      activity.timestamps = { start: Math.round(start), end: Math.round(start + duration * 1000) };
    }
    if (state.videoId) {
      activity.buttons = [
        { label: 'Écouter sur YouTube Music', url: `https://music.youtube.com/watch?v=${state.videoId}` },
      ];
    }
    wanted = activity;
    flush(false);
  }

  function setEnabled(on) {
    on = !!on && !!clientId;
    if (on === enabled) return;
    enabled = on;
    if (enabled) {
      connect();
    } else {
      clearTimeout(retryTimer);
      clearTimeout(sendTimer);
      wanted = null;
      lastTrack = null;
      if (ready) send(null); // on retire le statut avant de partir
      cleanup();
    }
  }

  // À la fermeture de l'appli : on retire le statut tout de suite.
  function stop() {
    if (ready) send(null);
    enabled = false;
    clearTimeout(retryTimer);
    clearTimeout(sendTimer);
    cleanup();
  }

  return { setEnabled, update, stop };
}

module.exports = { createDiscordPresence };
