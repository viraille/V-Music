(() => {
  const $ = (s) => document.querySelector(s);
  const view = $('#view');
  const root = document.documentElement;

  // ---------- petits utilitaires ----------
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null) n.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(kid));
    return n;
  };
  // « -2:05 / 3:20 » : temps restant puis durée totale
  const timeLeft = (cur, dur) => (dur > 0 ? `-${fmt(Math.max(0, dur - cur))} / ${fmt(dur)}` : '0:00');
  const fmt = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const img = (src) => {
    const i = el('img', { alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    i.addEventListener('load', () => i.classList.add('ok'));
    i.addEventListener('error', () => i.remove());
    if (src) i.src = src;
    return i;
  };
  const PLAY_SVG = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';

  // Liste affichée en ce moment (pour savoir quel est le « morceau suivant ») et file en cours.
  let ctx = { playlistId: '', ids: [] };
  let queue = null; // { playlistId, ids, i }

  // ---------- navigation ----------
  let current = { name: 'home' };
  const stack = [];
  let token = 0;

  function go(next, push = true) {
    if (push && current) stack.push(current);
    current = next;
    $('#back').hidden = stack.length === 0;
    const active = next.name === 'detail' ? next.from || 'home' : next.name;
    document.querySelectorAll('.nav[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === active));
    render();
  }
  $('#back').addEventListener('click', () => {
    const prev = stack.pop();
    if (prev) go(prev, false);
  });
  document.querySelectorAll('.nav[data-view]').forEach((b) =>
    b.addEventListener('click', () => {
      stack.length = 0;
      go({ name: b.dataset.view }, false);
      if (b.dataset.view === 'search') $('#q').focus();
    })
  );
  $('#btn-settings').addEventListener('click', () => window.neo.openSettings());
  $('#login').addEventListener('click', () => window.neo.login());
  window.neo.onLogin(() => { refreshAccount(); render(); });
  const loginBanner = () => {
    const b = el('div', { class: 'banner' },
      el('div', {}, el('div', { class: 'bt' }, 'Connecte-toi à ton compte Google'),
        el('div', { class: 'bs' }, 'Pour retrouver tes playlists, tes titres aimés et tes recommandations.')),
      el('button', { class: 'btn', onclick: () => window.neo.login() }, 'Se connecter'));
    return b;
  };

  function setView(...nodes) {
    view.replaceChildren(...nodes.filter(Boolean));
    view.classList.remove('view-enter');
    void view.offsetWidth;
    view.classList.add('view-enter');
    view.scrollTop = 0;
  }
  const skeleton = () =>
    setView(el('div', { class: 'row-scroll', style: 'margin-top:30px' }, Array.from({ length: 8 }, () => el('div', { class: 'skel' }))));
  const message = (html) => {
    const d = el('div', { class: 'msg' });
    d.innerHTML = html;
    setView(d);
  };

  // ---------- éléments d'interface ----------
  function open(item) {
    if (item.kind === 'song') return playSong(item);
    let id = item.browseId;
    // Playlists automatiques (« Musique J'aime »...) : pas d'identifiant de page, on le déduit
    const pid = item.play && item.play.playlistId;
    if (!id && pid && !/^RD/.test(pid)) id = 'VL' + pid;
    if (id) return go({ name: 'detail', browseId: id, title: item.title, from: current.from || current.name });
    if (item.play) startPlay(item.play, item);
  }
  function playSong(item, playlistId) {
    const vid = item.videoId || item.play?.videoId;
    const pid = playlistId || item.play?.playlistId || '';
    queue = pid && ctx.playlistId === pid && ctx.ids.includes(vid)
      ? { playlistId: pid, ids: ctx.ids, i: ctx.ids.indexOf(vid) }
      : null;
    startPlay({ videoId: item.videoId || item.play?.videoId, playlistId: playlistId || item.play?.playlistId || '' }, item, { keepQueue: true });
  }

  function card(item) {
    const art = el('div', { class: 'art' }, img(item.thumb));
    if (item.play) {
      const fab = el('span', { class: 'playfab', title: 'Lire' });
      fab.innerHTML = PLAY_SVG;
      fab.addEventListener('click', (e) => { e.stopPropagation(); startPlay(item.play, item); });
      art.append(fab);
    }
    const c = el('div', { class: `card ${item.kind}`, role: 'button', tabindex: '0', onclick: () => open(item) }, art,
      el('div', { class: 't' }, item.title), el('div', { class: 's' }, item.subtitle));
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(item); });
    if (item.menu && item.menu.length) c.append(moreButton(item, null));
    return c;
  }

  const MORE_SVG = '<svg viewBox="0 0 24 24"><path d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>';
  function moreButton(item, row) {
    const b = el('button', { class: 'more', title: 'Plus d\'options' });
    b.innerHTML = MORE_SVG;
    b.addEventListener('click', (e) => { e.stopPropagation(); openMenu(item, b, row); });
    return b;
  }

  function songRow(item, playlistId) {
    const row = el('div', { class: 'song', role: 'button', tabindex: '0', 'data-vid': item.videoId || '', onclick: () => playSong(item, playlistId) },
      el('div', { class: 'thumb' }, img(item.thumb)),
      el('div', { class: 'meta' }, el('div', { class: 't' }, item.title), el('div', { class: 's' }, item.subtitle)),
      el('div', { class: 'd' }, item.duration || ''));
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter') playSong(item, playlistId); });
    if (item.menu && item.menu.length || item.videoId) row.append(moreButton(item, row));
    if (item.videoId && item.videoId === lastState.videoId) row.classList.add('now');
    return row;
  }

  function listRow(item, playlistId) {
    if (item.kind === 'song') return songRow(item, playlistId);
    const row = el('div', { class: 'song', role: 'button', tabindex: '0', onclick: () => open(item) },
      el('div', { class: 'thumb', style: item.kind === 'artist' ? 'border-radius:50%' : null }, img(item.thumb)),
      el('div', { class: 'meta' }, el('div', { class: 't' }, item.title), el('div', { class: 's' }, item.subtitle)),
      el('div', { class: 'd' }, ''));
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(item); });
    if (item.menu && item.menu.length) row.append(moreButton(item, row));
    return row;
  }

  function sectionNode(sec, playlistId) {
    const songs = sec.items.filter((i) => i.kind === 'song');
    const wrap = el('div');
    if (sec.title) wrap.append(el('h2', { class: 'sec' }, sec.title));
    if (sec.layout === 'list') {
      wrap.append(el('div', { class: 'cols2 list one' }, sec.items.map((i) => listRow(i, playlistId))));
    } else if (songs.length && songs.length >= sec.items.length / 2) {
      wrap.append(el('div', { class: 'cols2 list' }, sec.items.map((i) => listRow(i, playlistId))));
    } else if (sec.items.length > 8) {
      wrap.append(el('div', { class: 'grid' }, sec.items.map(card)));
    } else {
      wrap.append(el('div', { class: 'row-scroll' }, sec.items.map(card)));
    }
    return wrap;
  }

  // Chargement automatique de la suite d'une longue liste quand on arrive en bas
  function autoMore(token, playlistId, fallbackThumb, kind) {
    if (!token) return;
    const list = [...view.querySelectorAll('.cols2.list')].pop();
    if (!list) return;
    const sentinel = el('div', { style: 'height:60px' });
    list.after(sentinel);
    const my = token_();
    const c = ctx;
    let tok = token;
    let running = null;
    let obs = null;
    const finish = () => { tok = ''; if (obs) obs.disconnect(); sentinel.remove(); };

    // Charge la page suivante de la liste ; renvoie true s'il en reste.
    c.loadMore = () => {
      if (!tok) return Promise.resolve(false);
      if (running) return running;
      running = (async () => {
        try {
          const r = await window.neo.more(tok, kind);
          if (my !== token_()) { finish(); return false; }
          for (const it of r.items) {
            if (!it.thumb && fallbackThumb) it.thumb = fallbackThumb;
            list.append(listRow(it, playlistId));
            if (it.kind === 'song' && it.videoId && !c.ids.includes(it.videoId)) c.ids.push(it.videoId);
          }
          tok = r.token;
          if (!tok || !r.items.length) finish();
        } catch (e) { finish(); }
        running = null;
        return !!tok;
      })();
      return running;
    };

    obs = new IntersectionObserver((entries) => {
      if (my !== token_()) return finish();
      if (entries.some((e) => e.isIntersecting)) c.loadMore();
    }, { root: view, rootMargin: '600px' });
    obs.observe(sentinel);
  }
  const token_ = () => token;

  // Lecture aléatoire : on charge toute la liste, on la mélange, puis on la suit dans cet ordre.
  const SHUFFLE_SVG = '<svg viewBox="0 0 24 24"><path d="M10.6 9.2 5.4 4 4 5.4l5.2 5.2zM14.5 4l2 2L4 18.6 5.4 20 18 7.5l2 2V4zm.3 9.4-1.4 1.4 3.1 3.1-2 2H20v-5.5l-2 2z"/></svg>';
  function shuffleButton(getCtx, label = 'Aléatoire') {
    const b = el('button', { class: 'btn ghost' }, label);
    b.insertAdjacentHTML('afterbegin', SHUFFLE_SVG);
    b.addEventListener('click', async () => {
      const c = getCtx();
      if (!c || b.disabled) return;
      b.disabled = true;
      b.classList.add('busy');
      try {
        if (c.loadMore) { let guard = 0; while (guard++ < 60 && (await c.loadMore())) { /* on charge tout */ } }
      } catch (e) { /* on mélange ce qu'on a */ }
      b.disabled = false;
      b.classList.remove('busy');
      const ids = c.ids.slice();
      for (let i = ids.length - 1; i > 0; i--) {
        const k = Math.floor(Math.random() * (i + 1));
        [ids[i], ids[k]] = [ids[k], ids[i]];
      }
      if (!ids.length) return;
      queue = { playlistId: c.playlistId, ids, i: 0, shuffled: true };
      startPlay({ videoId: ids[0], playlistId: c.playlistId }, null, { keepQueue: true });
    });
    return b;
  }


  // ---------- J'aime ----------
  const likeOv = {}; // videoId -> statut choisi ici (pour l'affichage immédiat)
  const likeOf = (vid, base) => likeOv[vid] || base || 'INDIFFERENT';

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.remove('show'), 2600);
  }
  const errText = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': Error: /, '');

  function refreshHearts() {
    const vid = lastState.playerId || lastState.videoId;
    const on = !!vid && likeOf(vid, lastState.like) === 'LIKE';
    for (const id of ['p-like', 'f-like']) $('#' + id).classList.toggle('liked', on);
  }

  async function setLike(vid, status) {
    const before = likeOv[vid];
    likeOv[vid] = status;
    refreshHearts();
    try {
      await window.neo.service({ act: 'like', status, videoId: vid });
      toast(status === 'LIKE' ? 'Ajouté aux titres aimés' : 'Retiré des titres aimés');
    } catch (e) {
      if (before) likeOv[vid] = before; else delete likeOv[vid];
      refreshHearts();
      toast("Impossible de modifier le J'aime : " + errText(e));
    }
  }

  for (const id of ['p-like', 'f-like']) {
    $('#' + id).addEventListener('click', (e) => {
      e.stopPropagation();
      const vid = lastState.playerId || lastState.videoId;
      if (!vid) return;
      setLike(vid, likeOf(vid, lastState.like) === 'LIKE' ? 'INDIFFERENT' : 'LIKE');
    });
  }

  // ---------- File d'attente (lire ensuite / ajouter à la file) ----------
  function plFor(id) {
    return queue && queue.noList && queue.noList.has(id) ? '' : queue ? queue.playlistId : '';
  }
  function queueAdd(videoId, pos, item) {
    const cur = lastState.videoId;
    if (!queue) {
      if (!cur) { startPlay({ videoId }, item); return; }
      queue = { playlistId: '', ids: [cur], i: 0 };
    }
    if (!queue.custom) { queue.ids = queue.ids.slice(); queue.custom = true; }
    queue.noList = queue.noList || new Set();
    if (!queue.ids.includes(videoId) || pos === 'next') {
      if (queue.ids.includes(videoId)) queue.ids.splice(queue.ids.indexOf(videoId), 1);
      if (pos === 'next') queue.ids.splice(queue.i + 1, 0, videoId); else queue.ids.push(videoId);
    }
    if (videoId !== cur) queue.noList.add(videoId);
    toast(pos === 'next' ? 'Sera lu ensuite' : 'Ajouté à la file d\'attente');
  }

  function removeRow(row, item) {
    const vid = item.videoId;
    if (row) row.remove();
    const drop = (arr) => {
      const k = arr.indexOf(vid);
      if (k >= 0) arr.splice(k, 1);
      return k;
    };
    drop(ctx.ids);
    if (queue && queue.ids !== ctx.ids) { const k = drop(queue.ids); if (k >= 0 && k <= queue.i) queue.i = Math.max(0, queue.i - 1); }
  }

  // ---------- Menu « ⋮ » ----------
  function closeMenu() {
    const m = $('#menu');
    m.hidden = true;
    m.replaceChildren();
    document.querySelectorAll('.more.open').forEach((b) => b.classList.remove('open'));
  }

  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); toast('Lien copié'); }
    catch (e) { toast('Copie impossible'); }
  }

  async function runService(spec, okMsg) {
    try { await window.neo.service(spec); if (okMsg) toast(okMsg); return true; }
    catch (e) { toast('Échec : ' + errText(e)); return false; }
  }

  async function pickPlaylist(videoId) {
    const d = $('#dialog');
    d.hidden = false;
    const box = el('div', { class: 'box' }, el('h3', {}, 'Enregistrer dans une playlist'), el('div', { class: 'msg', style: 'padding:24px' }, 'Chargement…'));
    d.replaceChildren(box);
    d.onclick = (e) => { if (e.target === d) d.hidden = true; };
    try {
      const lists = await window.neo.playlistsFor(videoId);
      const rows = lists.length
        ? lists.map((p) => el('button', { class: 'mi', onclick: async () => {
            d.hidden = true;
            try { await window.neo.addToPlaylist(p.playlistId, videoId); toast(`Ajouté à « ${p.title} »`); }
            catch (e) { toast('Échec : ' + errText(e)); }
          } }, p.title + (p.has ? '  ✓' : '')))
        : [el('div', { class: 'msg', style: 'padding:24px' }, 'Aucune playlist trouvée.')];
      box.replaceChildren(el('h3', {}, 'Enregistrer dans une playlist'), ...rows);
    } catch (e) {
      box.replaceChildren(el('h3', {}, 'Enregistrer dans une playlist'), el('div', { class: 'msg', style: 'padding:24px' }, 'Impossible de charger tes playlists : ' + errText(e)));
    }
  }

  function openMenu(item, anchor, row) {
    const m = $('#menu');
    const vid = item.videoId || (item.play && item.play.videoId) || '';
    const entries = [];
    if (item.kind === 'song' && vid) {
      const st = likeOf(vid, item.like);
      entries.push({ label: st === 'LIKE' ? 'Retirer des titres aimés' : 'Ajouter aux titres aimés', run: () => setLike(vid, st === 'LIKE' ? 'INDIFFERENT' : 'LIKE') });
    }
    for (const e of item.menu || []) {
      if (e.act === 'browse') entries.push({ label: e.label, run: () => go({ name: 'detail', browseId: e.browseId, title: e.label, from: current.from || current.name }) });
      else if (e.act === 'play') entries.push({ label: e.label, run: () => startPlay({ videoId: e.videoId, playlistId: e.playlistId }, item) });
      else if (e.act === 'queue') entries.push({ label: e.label, run: () => queueAdd(e.videoId, e.pos, item) });
      else if (e.act === 'addToPlaylist') entries.push({ label: e.label, run: () => pickPlaylist(e.videoId) });
      else if (e.act === 'like' || e.act === 'edit') entries.push({ label: e.label, danger: !!e.removes, run: async () => {
        if (await runService(e)) {
          if (e.act === 'like') likeOv[e.videoId] = e.status;
          if (e.removes) { removeRow(row, item); toast('Supprimé de la playlist'); refreshHearts(); }
        }
      } });
      else if (e.act === 'feedback') entries.push({ label: e.label, run: () => runService(e, 'Fait') });
      else if (e.act === 'toggle') entries.push({ label: e.toggled ? e.labelOn : e.label, run: async () => {
        if (await runService(e.toggled ? e.off : e.on, 'Fait')) e.toggled = !e.toggled;
      } });
    }
    if (vid) entries.push({ label: 'Copier le lien', run: () => copyText(`https://music.youtube.com/watch?v=${vid}`) });
    else if (item.play && item.play.playlistId) entries.push({ label: 'Copier le lien', run: () => copyText(`https://music.youtube.com/playlist?list=${item.play.playlistId}`) });

    m.replaceChildren(...entries.map((en) => el('button', { class: `mi${en.danger ? ' danger' : ''}`, onclick: () => { closeMenu(); en.run(); } }, en.label)));
    m.hidden = false;
    anchor.classList.add('open');
    const r = anchor.getBoundingClientRect();
    const w = m.offsetWidth, h = m.offsetHeight;
    let left = Math.min(Math.max(8, r.right - w), innerWidth - w - 8);
    let top = r.bottom + 6;
    if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6);
    m.style.left = left + 'px';
    m.style.top = top + 'px';
  }
  document.addEventListener('mousedown', (e) => { if (!$('#menu').hidden && !e.target.closest('#menu') && !e.target.closest('.more') && !e.target.closest('#account')) closeMenu(); });
  view.addEventListener('scroll', closeMenu);
  window.addEventListener('resize', closeMenu);

  // ---------- Compte (photo de profil + connexion / déconnexion) ----------
  let account = { loggedIn: false };
  function paintAvatar() {
    const b = $('#account');
    b.querySelectorAll('img').forEach((n) => n.remove());
    b.querySelector('.av-none').style.display = 'block';
    if (account.loggedIn && account.photo) {
      const im = el('img', { alt: account.name || 'Compte', referrerpolicy: 'no-referrer' });
      im.addEventListener('load', () => { b.querySelector('.av-none').style.display = 'none'; });
      im.addEventListener('error', () => im.remove());
      im.src = account.photo;
      b.append(im);
    }
    b.title = account.loggedIn ? (account.name || 'Compte connecté') : 'Se connecter';
  }
  async function refreshAccount() {
    try { account = (await window.neo.account()) || { loggedIn: false }; } catch (e) { account = { loggedIn: false }; }
    paintAvatar();
    $('#login').hidden = account.loggedIn;
  }
  $('#account').addEventListener('click', (e) => {
    e.stopPropagation();
    const m = $('#menu');
    const rows = [];
    if (account.loggedIn) {
      rows.push(el('div', { class: 'mh' }, el('div', { class: 'n' }, account.name || 'Compte connecté'), account.handle ? el('div', { class: 's' }, account.handle) : null));
      rows.push(el('button', { class: 'mi danger', onclick: async () => {
        closeMenu();
        try { await window.neo.logout(); toast('Déconnecté'); } catch (err) { toast('Déconnexion impossible'); }
      } }, 'Se déconnecter'));
    } else {
      rows.push(el('button', { class: 'mi', onclick: () => { closeMenu(); window.neo.login(); } }, 'Se connecter'));
    }
    m.replaceChildren(...rows.filter(Boolean));
    m.hidden = false;
    const r = $('#account').getBoundingClientRect();
    m.style.left = Math.min(r.right + 10, innerWidth - m.offsetWidth - 8) + 'px';
    m.style.top = Math.max(8, r.top) + 'px';
  });

  // ---------- vues ----------
  async function render() {
    const my = ++token;
    const v = current;
    try {
      if (v.name === 'home') {
        skeleton();
        const data = await window.neo.home();
        if (my !== token) return;
        $('#login').hidden = !!data.loggedIn;
        if (!data.sections.length) return setView(...(data.loggedIn ? [] : [loginBanner()]), el('div', { class: 'msg' }, 'Rien à afficher pour le moment. Vérifie ta connexion internet.'));
        ctx = { playlistId: '', ids: [] };
        setView(...(data.loggedIn ? [] : [loginBanner()]), ...data.sections.map((s) => sectionNode(s)));
      } else if (v.name === 'search') {
        if (!v.q) return message('<b>Que veux-tu écouter ?</b><br>Tape un titre, un artiste ou un album dans la barre.');
        skeleton();
        const data = await window.neo.search(v.q, v.params || '');
        if (my !== token) return;
        const chips = data.chips && data.chips.length
          ? el('div', { class: 'chips' }, [{ label: 'Tout', params: '' }, ...data.chips].map((c) =>
              el('button', { class: `chip${(v.params || '') === c.params ? ' on' : ''}`, onclick: () => go({ name: 'search', q: v.q, params: c.params, chips: data.chips }, false) }, c.label)))
          : v.chips ? el('div', { class: 'chips' }, [{ label: 'Tout', params: '' }, ...v.chips].map((c) =>
              el('button', { class: `chip${(v.params || '') === c.params ? ' on' : ''}`, onclick: () => go({ name: 'search', q: v.q, params: c.params, chips: v.chips }, false) }, c.label))) : null;
        if (!data.sections.length) {
          setView(chips, el('div', { class: 'msg' }, `Aucun résultat pour « ${v.q} ».`));
          return;
        }
        ctx = { playlistId: '', ids: [] };
        setView(chips, ...data.sections.map((s) => sectionNode(s)));
        autoMore(data.continuation, '', '', 'search');
      } else if (v.name === 'library') {
        const tab = v.tab || 'playlists';
        const tabs = [['playlists', 'Playlists'], ['songs', 'Titres aimés'], ['albums', 'Albums'], ['artists', 'Artistes']];
        const bar = el('div', { class: 'chips' }, tabs.map(([k, label]) =>
          el('button', { class: `chip${k === tab ? ' on' : ''}`, onclick: () => go({ name: 'library', tab: k, from: 'library' }, false) }, label)));
        setView(bar, el('div', { class: 'row-scroll', style: 'margin-top:20px' }, Array.from({ length: 6 }, () => el('div', { class: 'skel' }))));
        const data = await window.neo.library(tab);
        if (my !== token) return;
        $('#login').hidden = !!data.loggedIn;
        if (!data.loggedIn) return setView(bar, loginBanner());
        const items = data.sections.flatMap((s) => s.items).filter((i) => i.browseId || i.play);
        if (!items.length) return setView(bar, el('div', { class: 'msg' }, 'Rien ici pour le moment.'));
        const isSongs = tab === 'songs';
        ctx = isSongs ? { playlistId: data.header?.playlistId || 'LM', ids: items.filter((i) => i.kind === 'song').map((i) => i.videoId) } : { playlistId: '', ids: [] };
        const lc = ctx;
        const tools = isSongs ? el('div', { style: 'margin:18px 0 6px' }, shuffleButton(() => lc)) : null;
        setView(bar, tools, isSongs
          ? el('div', { class: 'cols2 list', style: 'margin-top:18px' }, items.map((i) => songRow(i, data.header?.playlistId || 'LM')))
          : el('div', { class: 'grid', style: 'margin-top:20px' }, items.map(card)));
        if (isSongs) autoMore(data.continuation, data.header?.playlistId || 'LM', '');
      } else if (v.name === 'detail') {
        skeleton();
        const data = await window.neo.browse(v.browseId);
        if (my !== token) return;
        const h = data.header;
        const songs = data.sections.flatMap((s) => s.items).filter((i) => i.kind === 'song');
        const cover = el('div', { class: 'cover' }, img(h.thumb));
        const play = el('button', { class: 'btn', onclick: () => songs[0] ? playSong(songs[0], h.playlistId) : h.playlistId && startPlay({ playlistId: h.playlistId }) }, 'Lecture');
        play.insertAdjacentHTML('afterbegin', PLAY_SVG);
        const c = { playlistId: h.playlistId, ids: songs.map((i) => i.videoId) };
        const shuffle = songs.length ? shuffleButton(() => c) : null;
        const hero = el('div', { class: 'hero' }, cover, el('div', {}, el('h1', {}, h.title || v.title || ''), el('div', { class: 'sub' }, h.subtitle), el('div', { class: 'btns' }, play, shuffle)));
        ctx = c;
        setView(hero, ...data.sections.map((s) => sectionNode(s, h.playlistId)));
        autoMore(data.continuation, h.playlistId, h.thumb);
      }
    } catch (e) {
      if (my !== token) return;
      message(`<b>Impossible de charger cette page.</b><br>${String(e.message || e).replace(/^Error invoking remote method '[^']+': Error: /, '')}<br><br>Réessaie dans un instant.`);
      const box = $('#view .msg');
      if (box) box.append(el('div', { style: 'margin-top:14px' }, el('button', { class: 'btn ghost', onclick: () => window.neo.showEngine() }, 'Voir la page YouTube Music')));
    }
  }

  // Recherche (avec un petit délai pour ne pas lancer une requête à chaque lettre)
  let qTimer;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(qTimer);
    const q = e.target.value.trim();
    qTimer = setTimeout(() => {
      if (current.name === 'search' && current.q === q) return;
      if (current.name === 'search') go({ name: 'search', q }, false);
      else go({ name: 'search', q }, true);
    }, q ? 450 : 0);
  });
  $('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(qTimer); e.target.dispatchEvent(new Event('input')); } });

  // ---------- lecteur ----------
  let lastState = {};
  let seeking = false;
  let lastArt = '';

  const setRange = (inp, ratio) => inp.style.setProperty('--p', `${Math.min(1, Math.max(0, ratio)) * 100}%`);

  function applyAccent(url) {
    // Couleur dominante de la pochette -> couleur d'accent de l'interface
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 24;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(im, 0, 0, 24, 24);
        const d = x.getImageData(0, 0, 24, 24).data;
        let best = null, bestScore = -1;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          const sat = mx ? (mx - mn) / mx : 0;
          const score = sat * 2 + mx / 255;
          if (score > bestScore && mx > 60) { bestScore = score; best = [r, g, b]; }
        }
        if (!best) return;
        // On éclaircit pour garder un bon contraste avec le texte sombre
        const l = best.map((v) => Math.round(v + (255 - v) * 0.35));
        root.style.setProperty('--accent', `rgb(${l[0]},${l[1]},${l[2]})`);
        root.style.setProperty('--accent-ink', `rgb(${Math.round(best[0] * 0.18)},${Math.round(best[1] * 0.18)},${Math.round(best[2] * 0.18)})`);
      } catch (e) { /* image protégée : on garde l'accent actuel */ }
    };
    im.src = url;
  }

  function bigArt(url) {
    return url ? url.replace(/=w\d+-h\d+[^&?]*$/, '=w800-h800-l90-rj').replace(/=s\d+[^&?]*$/, '=s800') : '';
  }

  // Chargement : tant que le morceau demandé n'est pas en train de jouer, on affiche
  // un rond qui tourne à la place de lecture/pause.
  let pending = null; // { videoId, fromVideoId, timer }

  function syncButtons() {
    const loading = !!pending;
    const playing = !!lastState.isPlaying;
    for (const id of ['c-play', 'f-play']) $('#' + id).classList.toggle('loading', loading);
    for (const id of ['ico-play', 'f-ico-play']) $('#' + id).toggleAttribute('hidden', loading || playing);
    for (const id of ['ico-pause', 'f-ico-pause']) $('#' + id).toggleAttribute('hidden', loading || !playing);
  }

  function stopLoading() {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending = null;
    syncButtons();
  }

  async function startPlay(target, meta, opts = {}) {
    if (!opts.keepQueue) queue = null;
    if (queue) queue.endFor = '';
    clearTimeout(pending && pending.timer);
    const mine = {
      videoId: (target && target.videoId) || '',
      fromVideoId: lastState.videoId || '',
      timer: setTimeout(() => { if (pending === mine) stopLoading(); }, 15000), // jamais de rond infini
    };
    pending = mine;
    if (meta && meta.title) {
      $('#player').classList.remove('empty');
      $('#p-title').textContent = meta.title;
      $('#p-artist').textContent = meta.subtitle || '';
      if (meta.thumb) $('#p-img').src = meta.thumb;
    }
    syncButtons();
    // Playlist sans morceau précisé : on cherche son premier titre (lancer une playlist
    // « à vide » ne démarre pas toujours la lecture).
    if (target && !target.videoId && target.playlistId && !/^RD/.test(target.playlistId)) {
      try {
        const d = await window.neo.browse('VL' + target.playlistId);
        const first = d.sections.flatMap((s) => s.items).find((i) => i.kind === 'song' && i.videoId);
        if (first) {
          const ids = d.sections.flatMap((s) => s.items).filter((i) => i.kind === 'song' && i.videoId).map((i) => i.videoId);
          target = { videoId: first.videoId, playlistId: target.playlistId };
          mine.videoId = first.videoId;
          queue = { playlistId: target.playlistId, ids, i: 0 };
        }
      } catch (e) { /* on tente quand même avec la playlist seule */ }
      if (pending !== mine) return; // l'utilisateur a cliqué sur autre chose entre-temps
    }
    window.neo.play(target);
  }

  function isLoaded(s) {
    if (!s.isPlaying || !(s.duration > 0) || !(s.currentTime > 0)) return false;
    return pending.videoId ? (s.playerId || s.videoId) === pending.videoId : s.videoId !== pending.fromVideoId;
  }

  function onState(s) {
    const prevId = lastState.videoId;
    lastState = s;
    if (pending && isLoaded(s)) stopLoading();
    if (queue && !pending && s.videoId) {
      // On suit nous-mêmes la liste : l'engin fige la lecture juste avant la fin du morceau
      // (mode "hold") et c'est nous qui lançons le bon morceau suivant.
      if (!s.hold) window.neo.cmd('hold', true);
      if (s.ended && queue.endFor !== s.videoId) {
        queue.endFor = s.videoId;
        if (queue.i + 1 < queue.ids.length) nextTrack();
        else { queue = null; window.neo.cmd('hold', false); window.neo.cmd('play'); } // fin de liste : YouTube Music continue
      } else if (!s.ended) {
        const idx = queue.ids.indexOf(s.videoId);
        if (queue.shuffled) {
          if (s.videoId !== queue.ids[queue.i] && queue.i + 1 < queue.ids.length) {
            queue.i += 1;
            startPlay({ videoId: queue.ids[queue.i], playlistId: plFor(queue.ids[queue.i]) }, null, { keepQueue: true });
          }
        } else if (idx >= 0) {
          queue.i = idx;
        } else if (s.playlistId && s.playlistId !== queue.playlistId && queue.i + 1 < queue.ids.length) {
          // YouTube Music est sorti de la playlist : on revient dessus
          queue.i += 1;
          startPlay({ videoId: queue.ids[queue.i], playlistId: plFor(queue.ids[queue.i]) }, null, { keepQueue: true });
        }
      }
    } else if (!queue && s.hold) {
      window.neo.cmd('hold', false);
    }
    // Pendant le chargement, on garde l'affichage du morceau demandé (pas l'ancien)
    if (pending && !(pending.videoId && s.videoId === pending.videoId)) { syncButtons(); return; }
    const has = !!(s.title || s.videoId);
    $('#player').classList.toggle('empty', !has);
    { const k = s.playerId || s.videoId; if (k && likeOv[k] && s.like === likeOv[k]) delete likeOv[k]; }
    refreshHearts();
    $('#p-title').textContent = s.title || 'Rien en lecture';
    $('#p-artist').textContent = s.artist || '';
    $('#f-title').textContent = s.title || '';
    $('#f-artist').textContent = s.artist || '';
    syncButtons();

    const art = bigArt(s.artwork);
    if (art && art !== lastArt) {
      lastArt = art;
      $('#p-img').src = s.artwork;
      $('#f-img').src = art;
    }
    if (!seeking) {
      const r = s.duration > 0 ? s.currentTime / s.duration : 0;
      for (const id of ['seek', 'f-seekbar']) { $('#' + id).value = Math.round(r * 1000); setRange($('#' + id), r); }
      $('#t-cur').textContent = $('#f-cur').textContent = fmt(s.currentTime);
      $('#t-dur').textContent = $('#f-dur').textContent = timeLeft(s.currentTime, s.duration);
    }
    if (seeking) $('#t-dur').textContent = $('#f-dur').textContent = timeLeft(lastState.currentTime, s.duration);
    if (document.activeElement !== $('#vol')) { $('#vol').value = Math.round((s.volume ?? 1) * 100); setRange($('#vol'), s.volume ?? 1); }

    if (s.videoId !== prevId) {
      document.querySelectorAll('.song').forEach((r) => r.classList.toggle('now', !!s.videoId && r.dataset.vid === s.videoId));
    }
  }

  for (const id of ['seek', 'f-seekbar']) {
    const inp = $('#' + id);
    inp.addEventListener('pointerdown', () => (seeking = true));
    inp.addEventListener('input', () => {
      const r = inp.value / 1000;
      setRange(inp, r);
      $('#t-cur').textContent = $('#f-cur').textContent = fmt(r * (lastState.duration || 0));
      $('#t-dur').textContent = $('#f-dur').textContent = timeLeft(r * (lastState.duration || 0), lastState.duration);
    });
    inp.addEventListener('change', () => {
      window.neo.cmd('seek', (inp.value / 1000) * (lastState.duration || 0));
      setTimeout(() => (seeking = false), 300);
    });
  }
  $('#vol').addEventListener('input', (e) => { setRange(e.target, e.target.value / 100); window.neo.cmd('volume', e.target.value / 100); });

  // Suivant / précédent : on suit nous-mêmes la liste affichée, pour ne jamais sortir de la playlist.
  function nextTrack() {
    if (queue && queue.i + 1 < queue.ids.length) {
      queue.i += 1;
      return startPlay({ videoId: queue.ids[queue.i], playlistId: plFor(queue.ids[queue.i]) }, null, { keepQueue: true });
    }
    window.neo.cmd('next');
  }
  function prevTrack() {
    if (queue && !(lastState.currentTime > 3) && queue.i > 0) {
      queue.i -= 1;
      return startPlay({ videoId: queue.ids[queue.i], playlistId: plFor(queue.ids[queue.i]) }, null, { keepQueue: true });
    }
    if (queue) return window.neo.cmd('seek', 0);
    window.neo.cmd('prev');
  }

  const toggle = () => window.neo.cmd('toggle');
  for (const id of ['c-play', 'f-play']) $('#' + id).addEventListener('click', toggle);
  for (const id of ['c-prev', 'f-prev']) $('#' + id).addEventListener('click', prevTrack);
  for (const id of ['c-next', 'f-next']) $('#' + id).addEventListener('click', nextTrack);
  $('#p-open').addEventListener('click', () => { if (lastState.title) $('#full').hidden = false; });
  $('#f-close').addEventListener('click', () => ($('#full').hidden = true));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { $('#full').hidden = true; closeMenu(); $('#dialog').hidden = true; }
    if (e.code === 'Space' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); toggle(); }
  });

  window.addEventListener('focus', () => { if (!$('#login').hidden && current.name === 'home') render(); });
  refreshAccount();
  window.neo.onState(onState);
  window.neo.getState().then((s) => s && onState(s));
  render();
})();
