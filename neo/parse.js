'use strict';
// Lecture des réponses de l'API interne de YouTube Music ("InnerTube") et
// transformation en objets simples pour la nouvelle interface. Ces réponses
// sont très imbriquées et changent parfois : tout est donc lu de façon
// défensive (jamais d'exception si un champ manque).

const text = (o) =>
  !o ? '' : o.runs ? o.runs.map((r) => r.text).join('') : o.simpleText || '';

function sized(url, size) {
  if (!url) return '';
  // Pochettes Google : ...=w60-h60-l90-rj -> on demande une taille correcte
  if (/=w\d+-h\d+/.test(url)) return url.replace(/=w\d+-h\d+[^&?]*$/, `=w${size}-h${size}-l90-rj`);
  if (/=s\d+/.test(url)) return url.replace(/=s\d+[^&?]*$/, `=s${size}`);
  return url;
}

function thumbOf(node, size = 400) {
  if (!node) return '';
  const t =
    node.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails ||
    node.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ||
    node.thumbnail?.croppedSquareThumbnailRenderer?.thumbnail?.thumbnails ||
    node.thumbnailRenderer?.croppedSquareThumbnailRenderer?.thumbnail?.thumbnails ||
    node.thumbnail?.thumbnails ||
    node.thumbnails;
  if (!Array.isArray(t) || !t.length) return '';
  return sized(t[t.length - 1].url, size);
}

function readEndpoint(ep, out) {
  if (!ep) return out;
  if (ep.watchEndpoint) {
    out.videoId = out.videoId || ep.watchEndpoint.videoId;
    out.playlistId = out.playlistId || ep.watchEndpoint.playlistId;
  }
  if (ep.watchPlaylistEndpoint) {
    out.playlistId = out.playlistId || ep.watchPlaylistEndpoint.playlistId;
  }
  if (ep.browseEndpoint) {
    out.browseId = out.browseId || ep.browseEndpoint.browseId;
    out.pageType =
      out.pageType ||
      ep.browseEndpoint.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig
        ?.pageType;
  }
  return out;
}

const WORD_KIND = {
  song: 'song', chanson: 'song', titre: 'song', video: 'song', 'vidéo': 'song',
  album: 'album', single: 'album', ep: 'album',
  artist: 'artist', artiste: 'artist',
  playlist: 'playlist', 'liste de lecture': 'playlist',
};

function kindOf(nav, play, firstWord) {
  if (nav.videoId) return 'song';
  const pt = nav.pageType || '';
  if (pt.endsWith('_ALBUM')) return 'album';
  if (pt.endsWith('_ARTIST') || pt.endsWith('USER_CHANNEL')) return 'artist';
  if (pt.endsWith('_PLAYLIST')) return 'playlist';
  const b = nav.browseId || '';
  if (b.startsWith('MPRE')) return 'album';
  if (b.startsWith('UC')) return 'artist';
  if (b.startsWith('VL')) return 'playlist';
  const w = WORD_KIND[(firstWord || '').trim().toLowerCase()];
  if (w) return w;
  if (play.playlistId) return 'playlist';
  return 'item';
}

function playOf(r) {
  const ep =
    r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer
      ?.playNavigationEndpoint ||
    r.thumbnailOverlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer
      ?.playNavigationEndpoint;
  return readEndpoint(ep, {});
}

function finish(item, nav, play) {
  item.browseId = nav.browseId || '';
  const videoId = play.videoId || nav.videoId || '';
  let playlistId = play.playlistId || nav.playlistId || '';
  if (!playlistId && item.browseId.startsWith('VL')) playlistId = item.browseId.slice(2);
  item.play = videoId || playlistId ? { videoId, playlistId } : null;
  item.videoId = item.kind === 'song' ? videoId : '';
  return item;
}

function parseTwoRow(r) {
  const nav = readEndpoint(r.navigationEndpoint, {});
  const play = playOf(r);
  const subtitle = text(r.subtitle);
  const kind = kindOf(nav, play, subtitle.split(/[•·]/)[0]);
  const title = text(r.title);
  if (!title) return null;
  return finish({ kind, title, subtitle, thumb: thumbOf(r), duration: '' }, nav, play);
}

function parseResponsive(r) {
  const cols = (r.flexColumns || []).map(
    (c) => c.musicResponsiveListItemFlexColumnRenderer?.text
  );
  const title = text(cols[0]);
  if (!title) return null;
  const nav = readEndpoint(r.navigationEndpoint, {});
  readEndpoint(cols[0]?.runs?.[0]?.navigationEndpoint, nav);
  const play = playOf(r);
  const pid = r.playlistItemData || {};
  if (pid.videoId) {
    nav.videoId = nav.videoId || pid.videoId;
    play.videoId = play.videoId || pid.videoId;
  }
  const rest = cols.slice(1).map(text).filter(Boolean);
  const subtitle = rest.join(' • ');
  const firstWord = (cols[1]?.runs?.[0]?.text || '').trim();
  const kind = kindOf(nav, play, firstWord);
  const duration =
    text(r.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text) ||
    (/^\d+:\d{2}(:\d{2})?$/.test((cols[1]?.runs || []).slice(-1)[0]?.text || '')
      ? cols[1].runs.slice(-1)[0].text
      : '');
  return finish({ kind, title, subtitle, thumb: thumbOf(r), duration }, nav, play);
}

function collect(list) {
  const out = [];
  for (const c of list || []) {
    let it = null;
    if (c.musicTwoRowItemRenderer) it = parseTwoRow(c.musicTwoRowItemRenderer);
    else if (c.musicResponsiveListItemRenderer) it = parseResponsive(c.musicResponsiveListItemRenderer);
    if (it) out.push(it);
  }
  return out;
}

function parseCard(c) {
  const nav = readEndpoint(c.title?.runs?.[0]?.navigationEndpoint, {});
  readEndpoint(c.onTap, nav);
  const play = playOf(c);
  const sub = text(c.subtitle);
  const kind = kindOf(nav, play, sub.split(/[•·]/)[0]);
  return finish(
    { kind, title: text(c.title), subtitle: sub, thumb: thumbOf(c), duration: '' },
    nav,
    play
  );
}

// Parcourt la réponse et en sort une liste de sections { title, items }.
function parseSections(json) {
  const sections = [];
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 30) return;
    if (Array.isArray(node)) return node.forEach((n) => visit(n, depth + 1));
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (!v || typeof v !== 'object') continue;
      if (key === 'musicCarouselShelfRenderer' || key === 'musicImmersiveCarouselShelfRenderer') {
        const h = v.header || {};
        const title = text(
          (h.musicCarouselShelfBasicHeaderRenderer || h.musicImmersiveCarouselShelfBasicHeaderRenderer || {}).title
        );
        const items = collect(v.contents);
        if (items.length) sections.push({ title, items });
      } else if (key === 'musicShelfRenderer' || key === 'musicPlaylistShelfRenderer') {
        const items = collect(v.contents);
        if (items.length) sections.push({ title: text(v.title), items });
      } else if (key === 'musicCardShelfRenderer') {
        const top = parseCard(v);
        const items = [top, ...collect(v.contents)].filter((i) => i && i.title);
        if (items.length) sections.push({ title: 'Meilleur résultat', items });
      } else if (key === 'gridRenderer') {
        const items = collect(v.items);
        if (items.length) sections.push({ title: '', items });
      } else {
        visit(v, depth + 1);
      }
    }
  };
  visit(json, 0);
  return sections;
}

function findHeader(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return null;
  for (const key of Object.keys(node)) {
    if (/^music.*HeaderRenderer$/.test(key) && !/Shelf|Carousel/.test(key)) return node[key];
  }
  for (const v of Object.values(node)) {
    const f = findHeader(v, depth + 1);
    if (f) return f;
  }
  return null;
}

// Page détail (album, playlist, artiste) : en-tête + sections.
function parseDetail(json, browseId) {
  const h = findHeader(json.header ? { header: json.header } : json) || {};
  const sections = parseSections(json);
  const raw = JSON.stringify(json);
  let playlistId = browseId && browseId.startsWith('VL') ? browseId.slice(2) : '';
  if (!playlistId) {
    const m = raw.match(/"playlistId":"(OLAK5uy_[\w-]+|PL[\w-]+|RDCLAK[\w-]+)"/);
    if (m) playlistId = m[1];
  }
  const header = {
    title: text(h.title),
    subtitle: [text(h.straplineTextOne), text(h.subtitle), text(h.secondSubtitle)]
      .filter(Boolean)
      .join(' • '),
    thumb: thumbOf(h, 600),
    playlistId,
  };
  // Les pistes d'un album n'ont pas de pochette : on met celle de l'en-tête.
  for (const s of sections) for (const it of s.items) if (!it.thumb) it.thumb = header.thumb;
  return { header, sections, continuation: findToken(json) };
}

// Jeton pour charger la suite d'une longue liste (au-delà des 100 premiers titres).
function findToken(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 40) return '';
  if (node.continuationCommand && node.continuationCommand.token) return node.continuationCommand.token;
  if (node.nextContinuationData && node.nextContinuationData.continuation) return node.nextContinuationData.continuation;
  for (const v of Object.values(node)) {
    const t = findToken(v, depth + 1);
    if (t) return t;
  }
  return '';
}

// Réponse "suite" : tous les titres/cartes trouvés + éventuel jeton suivant.
function parseContinuation(json) {
  const items = [];
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 40) return;
    if (Array.isArray(node)) {
      const found = collect(node);
      if (found.length) return void items.push(...found);
      return node.forEach((n) => visit(n, depth + 1));
    }
    for (const v of Object.values(node)) visit(v, depth + 1);
  };
  visit(json, 0);
  return { items, token: findToken(json) };
}

module.exports = { parseSections, parseDetail, parseContinuation, findToken, text, sized };
