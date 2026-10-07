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

  function readState() {
    const v = video();
    const md = navigator.mediaSession && navigator.mediaSession.metadata;
    const art = md && md.artwork && md.artwork.length ? md.artwork[md.artwork.length - 1].src : '';
    const bar = document.querySelector('ytmusic-player-bar');
    const url = new URL(location.href);
    return {
      videoId: url.searchParams.get('v') || '',
      playlistId: url.searchParams.get('list') || '',
      title: (md && md.title) || bar?.querySelector('.title')?.textContent?.trim() || '',
      artist: (md && md.artist) || bar?.querySelector('.byline')?.textContent?.trim() || '',
      album: (md && md.album) || '',
      artwork: art || bar?.querySelector('img')?.src || '',
      isPlaying: !!v && !v.paused && !v.ended,
      currentTime: v ? v.currentTime || 0 : 0,
      duration: v && isFinite(v.duration) ? v.duration : 0,
      volume: v ? v.volume : 1,
    };
  }

  setInterval(() => {
    try {
      if (window.__ytmcEngineState) window.__ytmcEngineState(readState());
    } catch (e) {}
  }, 500);

  window.__neo = {
    toggle() { const v = video(); if (v) (v.paused ? v.play() : v.pause()); },
    play() { const v = video(); if (v) v.play(); },
    pause() { const v = video(); if (v) v.pause(); },
    next() { return click('ytmusic-player-bar .next-button'); },
    prev() { return click('ytmusic-player-bar .previous-button'); },
    seek(t) { const v = video(); if (v && isFinite(t)) v.currentTime = Math.max(0, t); },
    volume(x) { const v = video(); if (v && isFinite(x)) v.volume = Math.min(1, Math.max(0, x)); },
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
