// Injecté dans la page YouTube Music cachée (le "moteur" audio) :
// publie l'état de lecture vers l'interface et reçoit ses commandes.
(function () {
  if (window.__neoInstalled) return;
  window.__neoInstalled = true;

  const video = () => document.querySelector('video');
  const click = (sel) => {
    const el = document.querySelector(sel);
    if (el) el.click();
    return !!el;
  };

  // Mode "hold" : quand l'interface suit sa propre file d'attente, on fige la lecture juste
  // avant la fin du morceau. Sans ça, YouTube Music enchaîne tout seul sur SON morceau
  // suivant (pas forcément le bon) avant que l'interface ait pu réagir.
  let hold = false;
  let heldAtEnd = false;

  setInterval(() => {
    const v = video();
    if (!hold || !v || heldAtEnd) return;
    if (isFinite(v.duration) && v.duration > 1 && !v.paused && v.duration - v.currentTime < 0.35) {
      v.pause();
      heldAtEnd = true;
      publish();
    }
  }, 60);

  function readState() {
    const v = video();
    const md = navigator.mediaSession && navigator.mediaSession.metadata;
    const art = md && md.artwork && md.artwork.length ? md.artwork[md.artwork.length - 1].src : '';
    const bar = document.querySelector('ytmusic-player-bar');
    const url = new URL(location.href);
    // Identifiant du morceau réellement chargé dans le lecteur (peut différer de l'adresse
    // de la page pendant quelques secondes au chargement)
    let playerId = '';
    try {
      const mp = document.querySelector('#movie_player');
      playerId = (mp && mp.getVideoData && mp.getVideoData().video_id) || '';
    } catch (e) {}
    return {
      playerId,
      like: (document.querySelector('ytmusic-player-bar ytmusic-like-button-renderer') || document.querySelector('ytmusic-like-button-renderer') || { getAttribute: () => '' }).getAttribute('like-status') || '',
      videoId: url.searchParams.get('v') || '',
      playlistId: url.searchParams.get('list') || '',
      title: (md && md.title) || bar?.querySelector('.title')?.textContent?.trim() || '',
      artist: (md && md.artist) || bar?.querySelector('.byline')?.textContent?.trim() || '',
      album: (md && md.album) || '',
      artwork: art || bar?.querySelector('img')?.src || '',
      isPlaying: !!v && !v.paused && !v.ended,
      currentTime: v ? v.currentTime || 0 : 0,
      duration: v && isFinite(v.duration) ? v.duration : 0,
      volume: playerVolume(v),
      hold,
      ended: heldAtEnd || (!!v && v.ended),
    };
  }

  // Volume réglé dans le lecteur YouTube Music (0 à 1). On ne lit pas celui de la balise vidéo :
  // YouTube peut le baisser pour égaliser le son des titres, et l'interface croirait à un changement.
  function playerVolume(v) {
    try {
      const mp = document.querySelector('#movie_player');
      const n = mp && mp.getVolume ? mp.getVolume() : NaN;
      if (isFinite(n)) return Math.min(1, Math.max(0, n / 100));
    } catch (e) {}
    return v ? v.volume : 1;
  }

  function publish() {
    try {
      if (window.__ytmcEngineState) window.__ytmcEngineState(readState());
    } catch (e) {}
  }
  setInterval(publish, 500);

  window.__neo = {
    toggle() { const v = video(); if (!v) return; if (v.paused) { heldAtEnd = false; v.play(); } else v.pause(); },
    play() { const v = video(); if (v) { heldAtEnd = false; v.play(); } },
    pause() { const v = video(); if (v) v.pause(); },
    next() { return click('ytmusic-player-bar .next-button'); },
    prev() { return click('ytmusic-player-bar .previous-button'); },
    seek(t) { const v = video(); if (v && isFinite(t)) v.currentTime = Math.max(0, t); },
    hold(on) { hold = !!on; if (!hold) heldAtEnd = false; },
    volume(x) {
      if (!isFinite(x)) return;
      x = Math.min(1, Math.max(0, x));
      // Volume du lecteur YouTube Music aussi : sinon il remet le sien au titre suivant.
      try { const mp = document.querySelector('#movie_player'); if (mp && mp.setVolume) mp.setVolume(Math.round(x * 100)); } catch (e) {}
      const v = video();
      if (v) v.volume = x;
    },
    // Changement de morceau sans recharger la page, si YouTube Music le permet
    open(videoId, playlistId) {
      const app = document.querySelector('ytmusic-app');
      if (app && typeof app.navigate === 'function') {
        app.navigate({ watchEndpoint: { videoId, playlistId: playlistId || undefined } });
        return true;
      }
      return false;
    },
  };
})();
