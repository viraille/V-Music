// Interface classique : barre de volume verticale en bas de la colonne de gauche,
// comme dans la nouvelle interface. Elle pilote le volume du lecteur YouTube Music et
// le garde dans les réglages de l'appli (le même réglage que la nouvelle interface).
(function () {
  if (window.__ytmcVolInstalled) return;
  window.__ytmcVolInstalled = true;

  const player = () => document.querySelector('#movie_player');

  // Construite élément par élément : YouTube Music interdit innerHTML (Trusted Types).
  const box = document.createElement('div');
  box.id = 'ytmc-vol';
  box.title = 'Volume';
  const track = document.createElement('div');
  track.className = 'track';
  const input = document.createElement('input');
  Object.assign(input, { type: 'range', min: '0', max: '100', value: '100' });
  input.setAttribute('aria-label', 'Volume');
  track.appendChild(input);
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const icon = document.createElementNS(NS, 'path');
  icon.setAttribute('d', 'M3 9v6h4l5 5V4L7 9zm13.5 3A4.500 4.500 0 0 0 14 8v8a4.500 4.500 0 0 0 2.500-4z');
  svg.appendChild(icon);
  box.append(track, svg);
  document.body.appendChild(box);
  const paint = (v) => {
    input.value = v;
    input.style.setProperty('--p', v + '%');
  };

  let saved = null; // volume enregistré (0 à 100), null = jamais réglé
  let last = null; // dernier volume lu dans le lecteur
  let restoreUntil = 0; // jusque-là, on impose le volume enregistré (YouTube remet le sien au chargement)
  let started = false;

  if (window.__ytmcGetVolume) {
    window.__ytmcGetVolume().then((v) => {
      if (typeof v === 'number' && v >= 0 && v <= 1) saved = Math.round(v * 100);
    }).catch(() => {});
  }

  input.addEventListener('input', () => {
    const v = Number(input.value);
    paint(v);
    restoreUntil = 0; // l'utilisateur a la main
    const mp = player();
    if (!mp || !mp.setVolume) return;
    if (mp.isMuted && mp.isMuted()) mp.unMute();
    mp.setVolume(v);
  });

  function tick() {
    // Affichée seulement avec la petite colonne de gauche (pas quand le grand menu est ouvert)
    const mini = document.querySelector('#mini-guide');
    const m = mini && mini.getBoundingClientRect();
    const guide = document.querySelector('#guide-wrapper');
    const g = guide && guide.getBoundingClientRect();
    const guideOpen = !!g && g.width > 100 && g.left >= 0;
    box.hidden = !(m && m.width > 0 && m.left >= 0) || guideOpen || innerHeight < 520;
    // Juste au-dessus de la barre de lecture
    const bar = document.querySelector('ytmusic-player-bar');
    const b = bar && bar.getBoundingClientRect();
    box.style.bottom = (b && b.height > 0 && b.top < innerHeight ? innerHeight - b.top : 0) + 20 + 'px';

    const mp = player();
    if (!mp || !mp.getVolume) return;
    let v = Math.round(mp.getVolume());
    if (!isFinite(v)) return;
    if (!started) {
      started = true;
      restoreUntil = Date.now() + 8000;
    }
    if (saved !== null && Date.now() < restoreUntil && v !== saved) {
      mp.setVolume(saved);
      v = saved;
    }
    box.classList.toggle('muted', !!(mp.isMuted && mp.isMuted()));
    if (document.activeElement !== input) paint(v);
    // Volume changé (notre barre ou celle de YouTube Music) : on l'enregistre
    if (v !== last) {
      if (last !== null && Date.now() >= restoreUntil && window.__ytmcSaveVolume) {
        saved = v;
        window.__ytmcSaveVolume(v / 100);
      }
      last = v;
    }
  }

  tick();
  setInterval(tick, 500);
})();
