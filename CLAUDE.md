# V Music — notes pour Claude Code

Client de bureau YouTube Music (Electron 31), en français. Dossier local : `S:\ytmusic-custom` (Windows).
GitHub (public) : `viraille/V-Music`, branche `main`.

## Avec l'utilisateur
- Il écrit en français familier, souvent en abrégé : réponds en français, simplement.
- Interface, messages et commentaires du code : en français.
- C'est lui qui publie les releases sur GitHub (tag + les deux .exe). Ne crée ni tag ni release.
- Couleurs : fond noir (`--bg:#0a0a0d`) et cyan du logo requin (`--accent:#5cd0f0`). Pas de violet.

## Commandes
- `npm install`, puis `npm start` pour lancer en dev.
- `npm run dist:win` lance `scripts/dist-win.js` : version `AA.MM.JJ.HH` à l'heure locale du build.
  `package.json` ne garde que la date (semver = 3 nombres). L'heure va dans les noms des .exe
  (`V Music Setup 26.10.08.11.exe`, `V Music 26.10.08.11.exe`) et dans la version Windows du fichier.
  Le script affiche le tag GitHub à utiliser (`v26.10.08.11`).
- Pas de suite de tests : `node --check <fichier>` pour la syntaxe. L'UI neo se teste dans un
  navigateur avec un faux `window.neo`.

## Architecture
- `main.js` : fenêtres, bloqueur de pub (`onBeforeRequest` + listes Ghostery), animation de lancement
  (WebContentsView), réglages (electron-store), serveur d'overlay OBS, rapport vers le dashboard Supabase.
  `uiMode` vaut `'neo'` (nouvelle interface, par défaut) ou `'classic'` (site YTM restylé).
- Nouvelle interface (neo) :
  - UI maison : `renderer/neo/` (`index.html`, `neo.css`, `neo.js`, `preload.js`), contextIsolation.
  - « Moteur » : BrowserWindow cachée sur music.youtube.com (`preload.js` + `renderer/inject.js` +
    `renderer/neo/engine.js`). Il publie son état toutes les 500 ms (IPC `engine:state`) et reçoit
    les commandes via `neo:cmd` → `window.__neo`. Scripts injectés seulement sur music.youtube.com.
  - `neo/api.js` : appels InnerTube exécutés DANS la page moteur (`executeJavaScript`), en-tête
    SAPISIDHASH, liste blanche d'endpoints `ALLOWED`.
  - `neo/parse.js` : lecture des réponses InnerTube (sections, pages, menus ⋮, likes, suites).
    YouTube change souvent ses formats : en dev, les réponses sont copiées dans `debug/` (ignoré par git).
  - File d'attente maison dans `neo.js` (`queue`, `nextTrack`/`prevTrack`). Mode « hold » : le moteur
    se met en pause 0,35 s avant la fin du titre pour que l'UI lance elle-même le bon suivant
    (sinon YTM enchaîne sur un autre morceau). Le moteur est muet pendant un chargement.
    Bouton répéter : off / liste / titre (`localStorage 'neo.repeat'`).
- Connexion Google : `neo/browser-login.js`. Google refuse les fenêtres Electron. On ouvre donc Edge ou
  Chrome (profil temporaire, `--app`), on attend le cookie SAPISID de `.youtube.com` et le retour
  sur music.youtube.com, puis on copie les cookies Google/YouTube dans la session
  `persist:ytmusic-custom`. Le port DevTools doit être FIXE : avec `--remote-debugging-port=0`,
  `navigator.webdriver` passe à true et Google refuse. En secours, une fenêtre intégrée.
- Page de consentement YouTube (consent.youtube.com) : la fenêtre moteur s'affiche pour que
  l'utilisateur réponde. Sur erreur de chargement, un bouton « Voir la page YouTube Music » l'affiche.

## Supabase (dashboard d'écoute)
- Projet `lzybmblhxsjsazcqpcsc`, table `public.listening_status` (une ligne par installation).
- L'app écrit via la fonction `public.report_listening(p_client_id, p_secret, p_username,
  p_track_title, p_track_artist, p_is_playing)`. Chaque installation a un secret (electron-store
  `reportingSecret`), dont seule l'empreinte est stockée dans `private.listening_clients`.
- À FAIRE plus tard (phase 2) : quand plus personne n'utilise une version d'avant cette fonction
  (26.10.08 et avant), supprimer les règles « Public update » et « Public upsert » de
  `listening_status` (garder « Public read »). Pas avant, sinon les anciennes versions ne
  remontent plus rien.
- Lignes de test à supprimer si l'utilisateur est d'accord : client_id
  `00000000-0000-4000-8000-0000000000aa` et `...0000000000bb` (pseudos TestClaude / TestOld).

## Limites connues
- Pas de lecture enchaînée sans coupure : 2 à 3 s de chargement entre deux titres.
- Pas de « Télécharger » ni de « Partager » dans le menu ⋮ (« Copier le lien » à la place).
