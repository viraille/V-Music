// Build Windows (installateur + portable) avec une version datée À L'HEURE PRÈS.
//
//   npm run dist:win
//
// Version = AA.MM.JJ.HH au moment du build (heure locale), par exemple 26.10.08.11
// pour le 8 octobre 2026 à 11 h. Plusieurs builds le même jour ont donc chacun la leur.
//
// package.json ne peut contenir que 3 nombres (règle "semver" de npm) : on y met la date
// (26.10.08), et l'heure est ajoutée là où elle se voit :
//   - les fichiers produits : "V Music Setup 26.10.08.11.exe", "V Music 26.10.08.11.exe"
//   - la version du .exe dans Windows (Propriétés > Détails) : 26.10.8.11

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const yy = pad(now.getFullYear() % 100);
const mm = pad(now.getMonth() + 1);
const dd = pad(now.getDate());
const hh = pad(now.getHours());

const dateVersion = `${yy}.${mm}.${dd}`; // package.json (même format qu'avant)
const label = `${dateVersion}.${hh}`; // ce que tu vois partout
const windowsVersion = [yy, mm, dd, hh].map(Number).join('.'); // 4 nombres, sans zéro devant

// Met la date dans package.json (et package-lock.json) pour que l'app et le build soient d'accord.
function setVersion(file, update) {
  const p = path.join(root, file);
  if (!fs.existsSync(p)) return;
  const json = JSON.parse(fs.readFileSync(p, 'utf8'));
  update(json);
  fs.writeFileSync(p, JSON.stringify(json, null, 2) + '\n');
}
setVersion('package.json', (j) => {
  j.version = dateVersion;
});
setVersion('package-lock.json', (j) => {
  j.version = dateVersion;
  if (j.packages && j.packages['']) j.packages[''].version = dateVersion;
});

console.log(`\nV Music ${label}  (tag GitHub conseillé : v${label})\n`);

const builder = require('electron-builder');
builder
  .build({
    targets: builder.Platform.WINDOWS.createTarget(['nsis', 'portable']),
    // Complète la section "build" de package.json (comme les options --config.xxx).
    config: {
      buildVersion: windowsVersion, // version du fichier .exe
      buildNumber: String(Number(hh)), // 4e nombre de la version produit / de l'installateur
      win: { icon: 'assets/icon.ico' },
      nsis: { artifactName: `\${productName} Setup ${label}.\${ext}` },
      portable: { artifactName: `\${productName} ${label}.\${ext}` },
    },
  })
  .then((files) => {
    console.log(`\nTerminé : V Music ${label}`);
    for (const f of files) if (/\.exe$/i.test(f)) console.log('  ' + path.relative(root, f));
    console.log(`\nTag GitHub : v${label}\n`);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
