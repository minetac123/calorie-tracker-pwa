// Stages the static web assets into www/ for Capacitor.
//
// There is no bundler here — the app is plain HTML/CSS/JS served straight
// from the repo root on Vercel. Capacitor still needs a single directory that
// contains the web app and nothing else: pointing webDir at the repo root
// would copy api/, node_modules/ and the iOS project itself into the bundle.
//
// Run with `npm run build`.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'www');

// Everything the browser actually loads. index.html is the entry point; the
// rest is referenced from it or from the manifest.
const ASSETS = [
  'index.html',
  'app.js',
  'styles.css',
  'sw.js',
  'manifest.json',
  'icon.svg',
  'icon-192.png',
  'icon-512.png'
];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let copied = 0;
const missing = [];

for (const name of ASSETS) {
  const from = path.join(ROOT, name);
  if (!fs.existsSync(from)) { missing.push(name); continue; }
  fs.copyFileSync(from, path.join(OUT, name));
  copied++;
}

if (missing.length) {
  // A missing asset means a silently broken app (no icons, no styles), so it
  // fails the build rather than shipping something half-loaded.
  console.error(`build-www: chybí soubory: ${missing.join(', ')}`);
  process.exit(1);
}

console.log(`build-www: ${copied} souborů -> www/`);
