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

// Nouvelle interface : le moteur caché publie son état de lecture.
window.__ytmcEngineState = (state) => ipcRenderer.send('engine:state', state);

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

  // --- Patch JSON.parse ---
  // Filet de sécurité : YouTube peut aussi recevoir ses infos de pub par un
  // autre chemin que les appels fetch/XHR ci-dessous (données déjà dans la
  // page au chargement, autre endpoint...). Comme elles passent presque
  // toujours par JSON.parse, on nettoie là aussi, mais seulement quand
  // l'objet décodé ressemble à une réponse de lecteur, pour ne pas ralentir
  // tout le reste.
  const originalParse = JSON.parse;
  JSON.parse = function (...args) {
    const result = originalParse.apply(this, args);
    try {
      if (
        result &&
        typeof result === 'object' &&
        (result.adPlacements ||
          result.playerAds ||
          result.adSlots ||
          result.playerResponse ||
          result.streamingData)
      ) {
        stripAds(result);
      }
    } catch (e) {
      // on ne casse jamais le parsing à cause du nettoyage
    }
    return result;
  };

  // Réponse de lecteur injectée directement dans le HTML de la page
  // (cas du chargement direct d'une page de morceau) : on nettoie au moment
  // où la page l'assigne.
  let initialPlayerResponse;
  try {
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true,
      get: () => initialPlayerResponse,
      set: (value) => {
        stripAds(value);
        initialPlayerResponse = value;
      },
    });
  } catch (e) {
    // propriété déjà verrouillée : pas grave
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
          // Réponse déjà décodée en objet : on la nettoie sur place.
          if (xhr.responseType === 'json') {
            stripAds(xhr.response);
            return;
          }
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
