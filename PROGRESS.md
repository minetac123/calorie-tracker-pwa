# Progress / poznámky pro pokračování

Tenhle soubor je pro mě (Claude) i pro tebe, kdybys pokračoval v jiném
nástroji (Antigravity apod.) a nová session nebude mít kontext z chatu.
Aktualizuju ho průběžně, ne jen na konci.

Poslední update: **2026-09-01**, verze appky **2.39.5**.

## Kde to teď je

- Repo je **veřejné**: https://github.com/minetac123/calorie-tracker-pwa
- Web/backend běží na Vercelu, auto-deploy z `main`:
  https://project-8rjn0.vercel.app
- iOS appka se sideloaduje (žádný App Store, žádný podepsaný build) přes
  SideStore. Nepodepsaná `.ipa` se builduje v GitHub Actions
  (`.github/workflows/build-ios.yml`) při každém pushi do `main` a
  publikuje se jako GitHub Release s tagem `vX.Y.Z`.
- Appka má vlastní **auto-update mechanismus** (`ios/App/App/UpdateChecker.swift`):
  při každém přepnutí appky do popředí zkontroluje nejnovější GitHub
  Release a nabídne instalaci přes SideStore. Kontrola se smí spustit
  nejvýš jednou za 6 hodin (`checkInterval`), aby to nespamovalo dialogem.
- Nově (2.39.4) je v Nastavení appky (dole pod "Verze: ...") tlačítko
  **"Zkontrolovat aktualizace"** — obchází těch 6 hodin
  (`UpdateChecker.checkAndPrompt(force: true)` přes nový Capacitor plugin
  `UpdateCheckerPlugin.swift` + `.m`).
- iOS appka je od 2.39.5 přejmenovaná z generického "Calorie Tracker" na
  **FitAI** (`CFBundleDisplayName`, `capacitor.config.json`, title
  GitHub release) a má ikonu vyrenderovanou z `icon.svg` — stejné logo,
  jaké má web (`icon-192.png`/`icon-512.png`). Render: `@resvg/resvg-js`
  (`npx`/`node -e`, viz git historie commitu), 1024×1024, do
  `ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png`.
  Pozn.: výsledný PNG má technicky alfa kanál (colorType 6, i když
  vizuálně neprůhledný) — pro App Store validaci by to vadilo, ale appka
  se nikdy nepodepisuje ani neuploaduje do App Store (jen unsigned
  sideload), takže to nevadí. Kdyby se to někdy řešilo, potřeba by byl
  nástroj co umí zapsat RGB PNG bez alfa kanálu (ImageMagick/Pillow —
  ani jedno tu není nainstalované).

## Co se právě testuje (NEDOKONČENO)

1. Uživatel má na telefonu 2.39.2 (bez tlačítka na kontrolu aktualizací).
2. Potřebuje **jeden poslední ruční sideload** na **2.39.4**
   (https://github.com/minetac123/calorie-tracker-pwa/releases/download/v2.39.4/CalorieTracker-unsigned.ipa),
   protože appka s tlačítkem tam ještě fyzicky není.
3. Po instalaci: Nastavení → "Zkontrolovat aktualizace" → mělo by hned
   (bez čekání) ukázat "Máš nejnovější verzi" (protože 2.39.4 je
   nejnovější release). To ověří, že plugin/tlačítko funguje.
4. **Skutečný test auto-update dialogu (že vyskočí nabídka na novější
   verzi) ještě neproběhl úspěšně end-to-end.** Historie:
   - 2.39.1 → 2.39.2: nevyskočilo nic, protože appka na telefonu (2.39.1)
     byla vybuildovaná ještě PŘED přidáním `UpdateChecker.swift` — ten
     kód tam fyzicky nebyl.
   - 2.39.2 → 2.39.3: appka UpdateChecker měla, ale 6hodinová pojistka
     bránila druhé kontrole (appka se už jednou tiše zeptala krátce po
     instalaci 2.39.2, kdy 2.39.2 byla ještě nejnovější, a nastavila si
     časovač).
   - Proto tlačítko force-check — až bude v appce (po sideloadu 2.39.4),
     příští verze (2.39.5+) by se měla dát otestovat okamžitě bez čekání.

**Až uživatel potvrdí, že tlačítko funguje**, udělej ještě jeden bump verze
(2.39.5) a nech uživatele stisknout tlačítko — to bude první opravdový
důkaz, že se dialog s nabídkou nové verze zobrazí a že `startInstall()`
(otevření SideStore přes `sidestore://install?url=...`) funguje.

## Známé pasti / postupy

### Git: rozjíždějící se historie po squash merge (recidivující problém)

Pracovní branch je `claude/calendar-nav-favorites-clbbfy`. GitHub PR se
mergují přes **squash merge**, což na `main` vytvoří nový commit s jiným
hashem než měl branch. Když se pak pokračuje ve stejné lokální branch a
pushne, GitHub to odmítne jako non-fast-forward, a force-push je
**blokovaný Claude Code permission classifierem** (nejde obejít).

Funkční postup:
```bash
git fetch origin main
git checkout -B claude/calendar-nav-favorites-clbbfy origin/main
# aplikuj/cherry-pickni nové změny na čerstvý main
git merge -s ours origin/claude/calendar-nav-favorites-clbbfy -m "merge: stará větev je už v mainu"
git push -u origin claude/calendar-nav-favorites-clbbfy
```
`merge -s ours` zachová nový obsah, ale formálně "spojí" starou historii,
takže push je fast-forward a nepotřebuje force.

### Verze appky — tři místa, ručně synchronizovaná

`api/_lib/version.js` (`APP_VERSION`, `CACHE_VERSION`) je zdroj pravdy.
Ručně se musí shodovat s:
- `index.html` — řádek `Verze: X (Cache vN)`
- `sw.js` — `CACHE_NAME = 'fitai-cache-vN'`

`scripts/check-version-sync.js` to hlídá a shodí CI build, když se rozejde.
Spustit ručně: `node scripts/check-version-sync.js`.

**Vždy při bumpu verze bump i CACHE_VERSION** (jinak service worker
neuvidí nový build a web zůstane na starém cache).

### GitHub Actions `list_workflow_runs` vrací obří payload

`mcp__github__actions_list` s `method: list_workflow_runs` umí vrátit
100k+ znaků a spadne na token limitu. Radši `mcp__github__get_latest_release`
(kompaktní) pro zjištění, jestli build doběhl — pokud existuje release s
očekávaným tagem a `.ipa` assetem, build prošel. Pro debug failed buildu
až pak `get_job_logs` s `failed_only: true`.

### Xcode project.pbxproj — ruční registrace nových souborů

Nový `.swift`/`.m` soubor v `ios/App/App/` se musí ručně zaregistrovat
na 4 místech v `ios/App/App.xcodeproj/project.pbxproj`:
1. `PBXBuildFile` sekce (`... in Sources` řádek)
2. `PBXFileReference` sekce (`isa = PBXFileReference`)
3. `PBXGroup` children (aby byl vidět ve stromu)
4. `PBXSourcesBuildPhase` files (aby se vůbec kompiloval)

Postup: vygeneruj unikátní 24hex ID (python `secrets.token_hex(12).upper()`,
ověř proti existujícím ID v souboru), vlož na všechna 4 místa, pak ověř
`grep -c` že se jméno souboru objevuje přesně 4× a že `{`/`}` v souboru
sedí (`grep -o '{' | wc -l` == `grep -o '}' | wc -l`). `plistlib` v Pythonu
tenhle formát (OpenStep plist, ne XML/binary) neumí parsovat — nezkoušet.

Žádný lokální Xcode/simulator tady není — jediná validace je počkat na
CI build (~5-10 min, včetně fronty na macOS runner).

## Co zbývá / nápady na příště

- [ ] Potvrdit od uživatele, že tlačítko "Zkontrolovat aktualizace" (2.39.4+)
      funguje (viz sekce výš)
- [ ] Jakmile potvrzeno, otestovat end-to-end, že force-check ukáže
      nabídku novější verze a že se SideStore opravdu otevře
- [ ] Uživatel bude muset udělat ještě jeden ruční sideload na **2.39.5**
      (https://github.com/minetac123/calorie-tracker-pwa/releases — zkontroluj
      že tag v2.39.5 existuje a má `.ipa` asset), aby dostal nové jméno
      "FitAI" a logo na plochu — appka na telefonu teď ukazuje staré
      "Calorie Tracker" se starou ikonou, dokud se ručně nepřeinstaluje
- [ ] `package.json` má `"version": "2.39.1"` — zaostává za skutečnou
      verzí, ale `check-version-sync.js` ho nekontroluje (není to jedno
      z hlídaných míst). Neškodí, ale je to nekonzistentní — zvážit buď
      smazat pole, nebo ho přidat do sync scriptu.
- [ ] 75 nových coach tools (5 sub-agentů, `api/_lib/tools_*.js`) je
      napsaných a otestovaných (~721 testů), ale nikdy nebyly
      vyzkoušené naživo s reálným uživatelem přes chat/Telegram.
- [ ] Z původních 100 nápadů na Telegram coach features zbývá ~25
      nerealizovaných — potřebují UI/infra (grafy, reminders/habits,
      export dat, přepínání theme). Seznam nápadů nebyl uložen do repa,
      jen v historii chatu — pokud budou znovu potřeba, je třeba je
      buď najít v `.claude` historii, nebo vygenerovat znovu.
- [ ] Starý uniklý Gemini klíč (`AQ.Ab8RN6JH...`) byl v `app.js` (tedy
      veřejně viditelný komukoliv už předtím) — uživatel potvrdil, že ho
      revokoval. Nový klíč je jen ve Vercel env vars, nikdy v kódu.

## Rychlá orientace v kódu

- `app.js` — celá klientská logika (žádný framework, žádný bundler)
- `api/` — Vercel serverless funkce (Node), `api/_lib/` sdílené moduly
- `api/_lib/version.js` — zdroj pravdy pro verzi appky
- `api/_lib/auth.js` — HMAC signed tokeny, scrypt hashování hesel
- `api/_lib/tools_*.js` — Gemini function-calling nástroje pro AI kouče
  (108 celkem: 33 původních + 75 nových)
- `api/sync.js` — server-side merge logiky (merge-not-overwrite, ne
  přepisování; 90denní okno historie přes `COACH_HISTORY_DAYS`)
- `ios/App/App/UpdateChecker.swift` — auto-update logika (GitHub
  Releases + SideStore)
- `ios/App/App/UpdateCheckerPlugin.swift` + `.m` — JS↔Swift most pro
  ruční tlačítko kontroly aktualizací
- `scripts/check-version-sync.js` — CI guard na 3 místa s verzí
- `.github/workflows/build-ios.yml` — build nepodepsané `.ipa` + release
