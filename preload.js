// Ce script tourne avant que la page YouTube Music ne charge ses propres
// scripts. contextIsolation étant désactivé (voir main.js), les patches
// ci-dessous s'appliquent directement dans le contexte de la page.

const { ipcRenderer } = require('electron');

// Exposé au contexte de la page pour que le bouton ⚙️ injecté par
// inject.js puisse ouvrir la fenêtre de paramètres.
window.__ytmcOpenSettings = () => ipcRenderer.send('open-settings');

// Progression de la musique -> barre de progression dans la barre des
// tâches (Windows) / le dock (macOS). ratio entre 0 et 1.
window.__ytmcSetProgress = (ratio, isPlaying) =>
  ipcRenderer.send('progress:update', ratio, isPlaying);

// Transmet titre/artiste/état au process principal, qui décide si ça doit
// partir vers le dashboard réseau (toggle désactivable dans les paramètres).
window.__ytmcSendReport = (state) => ipcRenderer.send('report:send', state);

// Reprise de lecture : on envoie régulièrement (videoId, position) au process
// principal, et au lancement on lui demande ce qu'il avait gardé.
window.__ytmcSavePlayback = (state) => ipcRenderer.send('playback:save', state);
window.__ytmcGetResume = () => ipcRenderer.invoke('playback:getResume');

(function () {
  // Clés connues utilisées par YouTube pour décrire les pubs à jouer dans
  // la réponse JSON du lecteur. On les supprime récursivement.
  const AD_KEYS = [
    'adPlacements',
    'adSlots',
    'playerAds',
    'adBreakHeartbeatParams',
    'adBreakParams',
  ];

  function stripAds(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 12) return;
    for (const key of AD_KEYS) {
      if (key in obj) delete obj[key];
    }
    for (const value of Object.values(obj)) {
      if (value && typeof value === 'object') stripAds(value, depth + 1);
    }
  }

  function isPlayerEndpoint(url) {
    return (
      typeof url === 'string' &&
      (url.includes('/youtubei/v1/player') || url.includes('/youtubei/v1/next'))
    );
  }

  // --- Patch fetch ---
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    const requestUrl =
      typeof args[0] === 'string' ? args[0] : args[0] && args[0].url;

    if (!isPlayerEndpoint(requestUrl)) return response;

    try {
      const data = await response.clone().json();
      stripAds(data);
      return new Response(JSON.stringify(data), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (e) {
      // Si le corps n'est pas du JSON exploitable, on renvoie la réponse
      // originale sans y toucher plutôt que de casser le lecteur.
      return response;
    }
  };

  // --- Patch XMLHttpRequest (au cas où YouTube l'utilise pour cet appel) ---
  const OriginalXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OriginalXHR();
    let targetUrl = '';

    const originalOpen = xhr.open;
    xhr.open = function (method, url, ...rest) {
      targetUrl = url;
      return originalOpen.call(xhr, method, url, ...rest);
    };

    xhr.addEventListener('readystatechange', function () {
      if (xhr.readyState === 4 && isPlayerEndpoint(targetUrl)) {
        try {
          const data = JSON.parse(xhr.responseText);
          stripAds(data);
          Object.defineProperty(xhr, 'responseText', {
            get: () => JSON.stringify(data),
          });
        } catch (e) {
          // rien à faire, on laisse la réponse originale
        }
      }
    });

    return xhr;
  }
  window.XMLHttpRequest = PatchedXHR;
})();
