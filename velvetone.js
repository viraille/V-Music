// Extension Chrome « Velvetone » (thème + lecteur pour le site YouTube Music), pour
// l'interface classique uniquement.
//
// Elle n'est PAS incluse dans V Music : on reprend celle installée dans le Chrome (ou Edge,
// Brave) de ce PC. On la copie dans le dossier de l'appli, avec deux retouches pour Electron :
//   - on retire « minimum_chrome_version » (elle demande Chrome 137, Electron 31 = Chrome 126) ;
//   - ses réglages passent du stockage « sync » (absent d'Electron) au stockage local.

const fs = require('fs');
const os = require('os');
const path = require('path');

const VELVETONE_ID = 'iafbjgekblbohkemnlkaiofgbcddlbbd';
const PATCH_MARK = '.vmusic-patched';

// « 1.0.1_0 » -> [1, 0, 1, 0] pour comparer les versions
const versionParts = (dir) => dir.split(/[._]/).map((n) => parseInt(n, 10) || 0);
function newer(a, b) {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

// Dossier de la version la plus récente installée dans un navigateur de ce PC, ou null.
function findInstalled() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const roots = [
    path.join(local, 'Google', 'Chrome', 'User Data'),
    path.join(local, 'Microsoft', 'Edge', 'User Data'),
    path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data'),
  ];
  let best = null;
  for (const root of roots) {
    let profiles = [];
    try {
      profiles = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch (e) {
      continue; // navigateur absent
    }
    for (const profile of profiles) {
      const base = path.join(root, profile, 'Extensions', VELVETONE_ID);
      let versions = [];
      try {
        versions = fs.readdirSync(base);
      } catch (e) {
        continue;
      }
      for (const v of versions) {
        if (!fs.existsSync(path.join(base, v, 'manifest.json'))) continue;
        if (!best || newer(v, best.version)) best = { dir: path.join(base, v), version: v };
      }
    }
  }
  return best;
}

function patchCopy(dir) {
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  delete manifest.minimum_chrome_version;
  delete manifest.update_url;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) {
        const src = fs.readFileSync(p, 'utf8');
        const out = src.replace(/([`"'])sync:/g, '$1local:');
        if (out !== src) fs.writeFileSync(p, out);
      }
    }
  };
  walk(dir);
  fs.writeFileSync(path.join(dir, PATCH_MARK), 'ok');
}

// Copie retouchée prête à charger (refaite seulement quand la version installée change).
function prepare(userDataDir) {
  const installed = findInstalled();
  if (!installed) return null;
  const root = path.join(userDataDir, 'extensions', 'velvetone');
  const dest = path.join(root, installed.version);
  if (!fs.existsSync(path.join(dest, PATCH_MARK))) {
    fs.rmSync(root, { recursive: true, force: true }); // anciennes versions
    fs.mkdirSync(root, { recursive: true });
    fs.cpSync(installed.dir, dest, { recursive: true });
    patchCopy(dest);
  }
  return { dir: dest, version: installed.version.replace(/_\d+$/, '') };
}

module.exports = { VELVETONE_ID, findInstalled, prepare };
