#!/usr/bin/env node
// Ověří, že verze sedí na všech místech, kde se udržuje ručně.
//
// Od chvíle, kdy iOS appka porovnává svou CFBundleShortVersionString s tagem
// GitHub Releasu, není rozejití verzí kosmetická chyba: appka by buď hlásila
// aktualizaci pořád dokola, nebo nikdy. Tenhle skript proto shodí build dřív,
// než se taková .ipa vůbec vyrobí.
//
// Spouští se v CI (viz .github/workflows/build-ios.yml) i ručně:
//   node scripts/check-version-sync.js

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const { APP_VERSION, CACHE_VERSION } = require(path.join(root, 'api/_lib/version.js'));

const problems = [];

if (!/^\d+\.\d+\.\d+$/.test(APP_VERSION)) {
  problems.push(`APP_VERSION "${APP_VERSION}" není ve tvaru X.Y.Z — release tag a porovnání verzí na to spoléhají.`);
}
if (!/^v\d+$/.test(CACHE_VERSION)) {
  problems.push(`CACHE_VERSION "${CACHE_VERSION}" není ve tvaru vN.`);
}

// index.html: "Verze: 2.39.2 (Cache v73)"
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const shown = indexHtml.match(/Verze:\s*([\d.]+)\s*\(Cache\s*(v\d+)\)/);
if (!shown) {
  problems.push('V index.html nejde najít řádek "Verze: X (Cache vN)" — změnil se formát?');
} else {
  if (shown[1] !== APP_VERSION) {
    problems.push(`index.html ukazuje verzi ${shown[1]}, ale APP_VERSION je ${APP_VERSION}.`);
  }
  if (shown[2] !== CACHE_VERSION) {
    problems.push(`index.html ukazuje cache ${shown[2]}, ale CACHE_VERSION je ${CACHE_VERSION}.`);
  }
}

// sw.js: const CACHE_NAME = 'fitai-cache-v73';
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const cacheName = sw.match(/CACHE_NAME\s*=\s*['"]fitai-cache-(v\d+)['"]/);
if (!cacheName) {
  problems.push('V sw.js nejde najít CACHE_NAME ve tvaru fitai-cache-vN.');
} else if (cacheName[1] !== CACHE_VERSION) {
  problems.push(`sw.js má cache ${cacheName[1]}, ale CACHE_VERSION je ${CACHE_VERSION}.`);
}

if (problems.length) {
  console.error('Verze se rozešly:\n');
  problems.forEach((p) => console.error('  - ' + p));
  console.error('\nSrovnej api/_lib/version.js, index.html a sw.js na stejnou hodnotu.');
  process.exit(1);
}

console.log(`Verze sedí: ${APP_VERSION} (cache ${CACHE_VERSION})`);
