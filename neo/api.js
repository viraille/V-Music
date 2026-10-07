'use strict';
// Appels à l'API interne de YouTube Music. Ils sont exécutés DANS la page
// YouTube Music cachée (le "moteur") : elle a déjà la session connectée, le
// bon contexte et le bon domaine, donc pas besoin de gérer cookies/CORS nous-mêmes.
const { parseSections, parseDetail, parseContinuation } = require('./parse');

const fs = require('fs');
const path = require('path');

// En développement (appli non installée), on garde les dernières réponses brutes
// de YouTube Music dans ./debug pour pouvoir comprendre pourquoi une page est
// vide ou cassée. Ce dossier n'est jamais publié sur GitHub (.gitignore).
function dump(debugDir, name, data) {
  if (!debugDir) return;
  try {
    fs.mkdirSync(debugDir, { recursive: true });
    fs.writeFileSync(path.join(debugDir, name), typeof data === 'string' ? data : JSON.stringify(data, null, 1));
    const files = fs.readdirSync(debugDir).filter((f) => f.endsWith('.json')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 25))) fs.unlinkSync(path.join(debugDir, f));
  } catch (e) {
    /* le debug ne doit jamais gêner l'appli */
  }
}

function createApi(getEngine, waitLoaded, debugDir) {
  async function call(endpoint, body) {
    if (!['browse', 'search'].includes(endpoint)) throw new Error('endpoint refusé');
    for (let attempt = 0; attempt < 4; attempt++) {
      const wc = getEngine();
      if (!wc || wc.isDestroyed()) throw new Error('moteur indisponible');
      await waitLoaded();
      const script = `(async () => { try {
        const get = (k) => (window.ytcfg && window.ytcfg.get ? window.ytcfg.get(k) : undefined);
        if (!window.ytcfg) return { __error: 'page pas prête' };
        const ctx = get('INNERTUBE_CONTEXT') || { client: { clientName: 'WEB_REMIX', clientVersion: '1.20240101.01.00', hl: 'fr', gl: 'FR' } };
        const key = get('INNERTUBE_API_KEY');
        const m = document.cookie.match(/(?:^|; )SAPISID=([^;]+)/) || document.cookie.match(/(?:^|; )__Secure-3PAPISID=([^;]+)/);
        const headers = { 'Content-Type': 'application/json', 'X-Goog-AuthUser': '0', 'X-Origin': location.origin };
        if (m) {
          const ts = Math.floor(Date.now() / 1000);
          const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(ts + ' ' + m[1] + ' ' + location.origin));
          headers.Authorization = 'SAPISIDHASH ' + ts + '_' + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
        }
        const r = await fetch('/youtubei/v1/${endpoint}?prettyPrint=false' + (key ? '&key=' + key : ''), {
          method: 'POST', credentials: 'include', headers,
          body: JSON.stringify(Object.assign({ context: ctx }, ${JSON.stringify(body)})),
        });
        if (!r.ok) return { __error: 'HTTP ' + r.status };
        const json = await r.json();
        json.__loggedIn = !!get('LOGGED_IN');
        return json;
      } catch (e) { return { __error: String((e && e.message) || e) }; } })()`;
      let res;
      try {
        res = await wc.executeJavaScript(script);
      } catch (e) {
        res = { __error: e.message };
      }
      if (res && !res.__error) {
        dump(debugDir, `${Date.now()}-${endpoint}.json`, { request: body, response: res });
        return res;
      }
      if (attempt === 3) {
        dump(debugDir, `${Date.now()}-${endpoint}-ERROR.json`, { request: body, error: res && res.__error });
      }
      if (attempt === 3) throw new Error(res?.__error || 'réponse vide');
      await new Promise((r) => setTimeout(r, 1000)); // page en cours de rechargement : on réessaie
    }
  }

  return {
    async home() {
      const j = await call('browse', { browseId: 'FEmusic_home' });
      return { loggedIn: j.__loggedIn, sections: parseSections(j) };
    },
    async search(query) {
      const j = await call('search', { query });
      return { sections: parseSections(j) };
    },
    async browse(browseId) {
      if (!/^[\w-]{3,80}$/.test(browseId)) throw new Error('identifiant invalide');
      const j = await call('browse', { browseId });
      return parseDetail(j, browseId);
    },
    async more(token) {
      if (!/^[\w%=.~-]{10,4000}$/.test(token)) throw new Error('jeton invalide');
      const j = await call('browse', { continuation: token });
      return parseContinuation(j);
    },
    async library(kind) {
      const ids = {
        playlists: 'FEmusic_liked_playlists',
        songs: 'VLLM',
        albums: 'FEmusic_liked_albums',
        artists: 'FEmusic_library_corpus_artists',
      };
      if (!ids[kind]) throw new Error('catégorie inconnue');
      const j = await call('browse', { browseId: ids[kind] });
      const d = parseDetail(j, ids[kind]);
      return { loggedIn: j.__loggedIn, header: d.header, sections: d.sections, continuation: d.continuation };
    },
  };
}

module.exports = { createApi };
