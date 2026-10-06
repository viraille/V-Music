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

    const videoId = new URL(location.href).searchParams.get('v') || '';

    return { isPlaying, currentTime, duration, ratio, trackTitle, trackArtist, artwork, videoId };
  }

  // ---------- Reprise de lecture au lancement ----------
  // Tant que la reprise n'est pas terminée, on n'enregistre rien : sinon la
  // position 0 du morceau fraîchement rechargé écraserait celle qu'on veut
  // restaurer.
  let canSavePlayback = false;

  async function restorePlayback() {
    try {
      const resume = window.__ytmcGetResume ? await window.__ytmcGetResume() : null;
      const currentId = new URL(location.href).searchParams.get('v');
      if (!resume || !resume.videoId || resume.videoId !== currentId || !(resume.position > 3)) {
        return;
      }
      // Attend que la balise <video> soit prête (métadonnées chargées),
      // puis se place à la position sauvegardée, en pause.
      await new Promise((resolve) => {
        let tries = 0;
        const timer = setInterval(() => {
          const video = document.querySelector('video');
          tries++;
          if (video && video.readyState >= 1 && isFinite(video.duration) && video.duration > 0) {
            clearInterval(timer);
            video.currentTime = Math.min(resume.position, video.duration - 1);
            video.pause();
            resolve();
          } else if (tries > 60) {
            clearInterval(timer);
            resolve();
          }
        }, 500);
      });
    } catch (e) {
      // pas grave, on lance juste sans reprise
    } finally {
      canSavePlayback = true;
    }
  }

  function syncPlaybackState() {
    const info = getPlaybackInfo();

    document.body.classList.toggle('app-playing', info.isPlaying);

    if (window.__ytmcSetProgress) {
      window.__ytmcSetProgress(info.ratio, info.isPlaying);
    }

    if (canSavePlayback && window.__ytmcSavePlayback && info.videoId && info.duration > 0) {
      window.__ytmcSavePlayback({ videoId: info.videoId, position: info.currentTime });
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

  restorePlayback();
  syncPlaybackState();
  setInterval(syncPlaybackState, 1000);
})();
