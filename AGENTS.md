# Pokyny pro AI agenty (Antigravity, Claude Code, Codex, ...)

Tohle si přečti první, než začneš cokoliv dělat v tomhle repu. Uživatel
mluví česky, mluv na něj jednoduše (viz jeho standing instrukce v historii
chatu — nekomplikuj vysvětlení).

**Průběžný stav projektu, rozdělaná práce a známé pasti jsou v
[`PROGRESS.md`](./PROGRESS.md) — přečti si ho hned po tomhle souboru.**
Aktualizuj ho po každé větší dokončené věci (nový release, opravený bug,
nová feature), ne jen na konci session — další agent/session na něj
spoléhá.

## Co je tenhle projekt

FitAI — česká PWA na sledování kalorií a tréninků s AI koučem (Gemini
function calling). Čistý HTML/CSS/JS bez frameworku a bez bundleru,
Vercel serverless backend, Upstash Redis storage. Má i Telegram bota a
sideloadovanou iOS appku (Capacitor), postavenou přes GitHub Actions.

## Základní pravidla

- **Verze appky**: jediný zdroj pravdy je `api/_lib/version.js`. Tři
  místa se musí ručně shodovat (`index.html`, `sw.js`, `version.js`) —
  hlídá to `scripts/check-version-sync.js`, spusť ho po každé změně
  verze: `node scripts/check-version-sync.js`.
- **Git**: pracovní branch se po každém squash merge PR rozejde od
  `main` (jiný hash commitu). Force-push je v tomhle nástroji blokovaný.
  Postup je popsaný v `PROGRESS.md` pod "Git: rozjíždějící se historie".
- **iOS build**: žádný lokální Xcode/simulátor není k dispozici. Jediná
  validace nového Swift/ObjC souboru je čekat na CI build
  (`.github/workflows/build-ios.yml`, ~5-10 min). Registrace nového
  souboru do `ios/App/App.xcodeproj/project.pbxproj` se dělá ručně —
  postup a kontrola v `PROGRESS.md`.
- **Nepiš komentáře co kód dělá** — jen proč, když to není zjevné z kódu
  samotného. Kodebase tenhle styl důsledně dodržuje (komentáře v
  češtině, vysvětlují WHY, ne WHAT).
- **Nikdy neukládej API klíče do kódu.** GEMINI_API_KEY a další žijí jen
  ve Vercel env vars. Repo je veřejné (open source).

## Kde co je

Viz sekci "Rychlá orientace v kódu" na konci `PROGRESS.md`.
