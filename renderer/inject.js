(function () {
  // Nettoyage périodique des bannières promo/pub qui peuvent réapparaître
  // dans le DOM après une navigation interne (SPA).
  const SELECTORS_TO_REMOVE = [
    'ytmusic-statement-banner-renderer',
    'ytmusic-mealbar-promo-renderer',
    '[class*="ad-container"]',
    '[id*="masthead-ad"]',
  ];

  function cleanup() {
    SELECTORS_TO_REMOVE.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => el.remove());
    });
  }

  cleanup();
  setInterval(cleanup, 2000);

  // ---------- Bouton ⚙️ Paramètres dans la barre du haut ----------
  function addSettingsButton() {
    if (document.getElementById('ytmc-settings-btn')) return;
    const nav =
      document.querySelector('ytmusic-nav-bar #right-content') ||
      document.querySelector('ytmusic-nav-bar');
    if (!nav) return;

    const btn = document.createElement('button');
    btn.id = 'ytmc-settings-btn';
    btn.title = "Paramètres de l'appli";
    btn.textContent = '⚙️';
    btn.addEventListener('click', () => {
      if (window.__ytmcOpenSettings) window.__ytmcOpenSettings();
    });
    nav.appendChild(btn);
  }

  addSettingsButton();
  setInterval(addSettingsButton, 2000);

  // ---------- État de lecture : classe CSS + taskbar + Discord ----------
  function getPlaybackInfo() {
    const video = document.querySelector('video');

    // État de lecture lu directement sur la balise <video> : plus fiable
    // que de lire le texte/titre d'un bouton de l'interface YouTube Music,
    // qui change de sélecteur à chaque refonte de leur UI.
    const isPlaying = !!video && !video.paused && !video.ended;

    const currentTime = video?.currentTime || 0;
    const duration = video?.duration || 0;
    const ratio = duration > 0 ? currentTime / duration : 0;

    const trackTitle =
      document.querySelector('ytmusic-player-bar .title')?.textContent?.trim() || '';
    const trackArtist =
      document.querySelector('ytmusic-player-bar .byline')?.textContent?.trim() || '';
    const artwork =
      document.querySelector('ytmusic-player-bar .image')?.src ||
      document.querySelector('ytmusic-player-bar img')?.src ||
      '';

    return { isPlaying, currentTime, duration, ratio, trackTitle, trackArtist, artwork };
  }

  function syncPlaybackState() {
    const info = getPlaybackInfo();

    document.body.classList.toggle('app-playing', info.isPlaying);

    if (window.__ytmcSetProgress) {
      window.__ytmcSetProgress(info.ratio, info.isPlaying);
    }

    if (window.__ytmcSendReport) {
      window.__ytmcSendReport({
        trackTitle: info.trackTitle,
        trackArtist: info.trackArtist,
        isPlaying: info.isPlaying,
        duration: info.duration,
        currentTime: info.currentTime,
        artwork: info.artwork,
      });
    }
  }

  syncPlaybackState();
  setInterval(syncPlaybackState, 1000);
})();
