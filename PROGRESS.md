# Progress / poznámky pro pokračování

Tenhle soubor je pro mě (Claude) i pro tebe, kdybys pokračoval v jiném
nástroji (Antigravity apod.) a nová session nebude mít kontext z chatu.
Aktualizuju ho průběžně, ne jen na konci.

Poslední update: **2026-09-01**, verze appky **3.0.0**.

Uživatel požádal o "oficiální" bump na 3.0 poté, co byla nalezena a
opravena skutečná příčina toho, proč se vlastní nativní pluginy
(update checker, Live Activity) nikdy neregistrovaly (viz 2.40.2 níž).
Čistě verzový skok, žádná nová funkce navíc — `package.json` (dřív
zaseklé na 2.39.1, mimo `check-version-sync.js`) bylo při té
příležitosti taky dorovnané.

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

## Live Activity tréninku (2.40.0) — nové

Widget extension target **FitAIWidgets** (`ios/App/LiveActivity/`,
bundle id `com.pruzz.calorieapp.LiveActivity`, min iOS 17.0):

- `WorkoutLiveActivity.swift` — zamykačka: cvik, "minule", odpočet pauzy,
  tlačítko Přeskočit pauzu, postup sérií
- `WorkoutDynamicIsland.swift` — compact / minimal / expanded prezentace
- `SkipRestIntent.swift` — `LiveActivityIntent` za tím tlačítkem
- `WorkoutActivityAttributes.swift` (v `App/`, kompiluje se do OBOU targetů)
- `LiveActivityPlugin.swift`/`.m` — JS most (`WorkoutLiveActivity`:
  start/update/end/consumeSkipRequest)
- `RestCountdownAudio.swift` + `RestAudioPlugin.swift`/`.m` — pípání v
  posledních 5 s pauzy, `duckOthers` (hudbu ztlumí, nezastaví)

**Ověřeno rozbalením hotové `.ipa`** (ne jen "build prošel"):
`PlugIns/FitAIWidgets.appex` je uvnitř, binárka 151 kB,
`NSSupportsLiveActivities = true`, `UIBackgroundModes = [audio]`,
extension point `com.apple.widgetkit-extension`, a `SkipRestIntent` je
zaregistrovaný v `Metadata.appintents`.

**Co ověřené NENÍ**: jak to vypadá a jestli to reálně funguje na
telefonu. Žádný iPhone ani simulátor tu není. Zvuk při **odswipované**
appce zásadně fungovat nebude (iOS jí nedá procesor) — to není bug.

Pozor při další práci: `restTotalSec` se zatím nikde nepoužívá (bylo
zamýšlené na progress ring). `RestCountdownAudio` neřeší přerušení
hovorem/Siri — po přerušení zbylá pípnutí nepřijdou.

## Co se právě testuje (NEDOKONČENO)

**Update 2026-09-01 pozdní večer — nalezena SKUTEČNÁ příčina (2.40.2):
vlastní nativní pluginy se nikdy neregistrovaly.** 2.40.1 udělala jen
diagnostickou náplast (tlačítko viditelné, alert s důvodem) a ten alert
skutečně ukázal: "Plugin pro kontrolu aktualizací se v tomhle buildu
nenačetl." Skutečný root cause:

Capacitor na iOS nehledá pluginy skenem runtime, ale podle explicitního
seznamu tříd v `ios/App/App/capacitor.config.json` →
`packageClassList`. Ten seznam generuje `npx cap sync ios` (běží v CI
při každém buildu, viz `node_modules/@capacitor/cli/dist/util/iosplugin.js`
→ `getPluginFiles`/`writePluginJSON`) **jen z nainstalovaných npm
balíčků** s Capacitor manifestem. Naše vlastní pluginy
(`UpdateCheckerPlugin`, `LiveActivityPlugin`, `RestAudioPlugin`) jsou
ale ručně psané `.swift`/`.m` soubory přímo v Xcode projektu, žádný npm
balíček nemají — `cap sync` je proto nikdy nenajde a seznam zůstává
`[]`. Plugin se pak na JS straně (`Capacitor.Plugins.X`) nikdy
neobjeví, tiše, bez chyby v buildu. **To platí od 2.39.4** (kdy vznikl
první z těchhle pluginů) — nemá to nic společného s Live Activity ani s
`project.pbxproj` úpravami, jak jsem si dřív myslel. Tlačítko "Zkontrolovat
aktualizace" tedy nefungovalo od svého vzniku, ne jen teď.

Oprava (2.40.2): nový `scripts/register-native-plugins.js`, spouští se
v `build-ios.yml` hned PO `npx cap sync ios` (protože sync ten soubor
přepisuje) — sesbírá třídy ze všech `CAP_PLUGIN(...)` maker v
`ios/App/App/*.m` a doplní je do `packageClassList`. Budoucí nové
pluginy (stejná konvence: `.m` soubor s `CAP_PLUGIN(...)` makrem) se
tak zaregistrují samy, není potřeba na nic pamatovat ručně. Ověřeno
lokálně (`node scripts/register-native-plugins.js` na kopii souboru
vrátilo správně všechny tři třídy).

Historie 2.40.1 (jen diagnostika, ne skutečná oprava): tlačítko se dřív
zobrazilo, jen když `window.Capacitor.Plugins.UpdateChecker` existoval v
době `initCoachHandlers()` — jinak řádek zůstal `display:none` beze
stopy. 2.40.1 ho udělala viditelným vždycky + alert při chybě, což
přesně tohle odhalilo.

**Čeká se na potvrzení od uživatele**, že 2.40.2 tlačítko doopravdy
opravila (a mělo by to zprovoznit i Live Activity pluginy, i když ty
ještě nikdo nezkoušel — jsou ve stejné situaci).

**Update na Update: 2026-09-01 odpoledne — auto-update dialog konečně
naskočil sám** (2.39.2 → 2.39.5, bez tlačítka, čistě automatickou
kontrolou po 6 h). To je první úspěšný důkaz, že `UpdateChecker`
detekuje novou verzi správně. ALE klepnutí na "Aktualizovat" neotevřelo
SideStore, skončilo na stránce GitHub Release — `canOpenURL` pro
`sidestore://` vrátilo false, i když appka má `LSApplicationQueriesSchemes`
správně a schéma `sidestore://install?url=...` je přesně podle oficiální
dokumentace SideStore (ověřeno přes `docs.sidestore.io/docs/advanced/url-schema`,
zdrojový soubor `SideStore/SideStore-Docs` na GitHubu). Nejspíš konkrétní
build SideStore na telefonu uživatele to schéma (zatím) neregistruje —
nejde to odsud ověřit, žádný fyzický iPhone k dispozici není.

**Oprava v 2.39.6**: `startInstall()` teď místo stránky releasu otevírá
rovnou přímý odkaz na `.ipa` v Safari (stejná cesta, jakou se appka
dosud instalovala ručně pokaždé — Safari stažení zachytí a nabídne
SideStore samo). Deep link `sidestore://` se pořád zkouší jako první
(rychlejší 1-tap zážitek, kdyby fungoval), ale fallback je teď o krok
kratší a spolehlivější než dřív. **Čeká se na potvrzení od uživatele,
že 2.39.6 tohle doopravdy vyřešila** — nejde to ověřit jinak než na
jeho telefonu.

1. Uživatel má na telefonu 2.39.2 (bez tlačítka na kontrolu aktualizací).
2. Potřebuje **jeden poslední ruční sideload** na **2.39.6**
   (https://github.com/minetac123/calorie-tracker-pwa/releases — zkontroluj
   že tag v2.39.6 existuje a má `.ipa` asset), protože appka s tlačítkem
   i s tou opravou tam ještě fyzicky není.
3. Po instalaci: Nastavení → "Zkontrolovat aktualizace" → mělo by hned
   (bez čekání) ukázat "Máš nejnovější verzi" (protože 2.39.6 je
   nejnovější release). To ověří, že plugin/tlačítko funguje.
4. **Skutečný test auto-update dialogu (že vyskočí nabídka na novější
   verzi A instalace se sama otevře) ještě neproběhl úspěšně
   end-to-end.** Historie:
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
100k+ znaků a spadne na token limitu. Cesty kolem toho:
- **`workflow_runs_filter: {"branch": "<feature větev>"}`** — funguje
  hezky u čerstvé větve, která má jeden dva běhy. Pozor: **na `main` to
  nepomůže**, tam je běhů spousta a payload je stejně obří (i s
  `status: completed`). Nespoléhej na to jako na obecné řešení.
- `mcp__github__get_latest_release` (kompaktní) pro zjištění, jestli
  build doběhl — pokud existuje release s očekávaným tagem a `.ipa`
  assetem, build prošel. Tohle je nejspolehlivější u `main`.
- Když se payload přesto uloží do souboru, vytáhni z něj jen to
  podstatné: `python3 -c "import json; d=json.load(open('<soubor>'));
  [print(r['id'], r['status'], r['conclusion']) for r in
  d['workflow_runs'][:3]]"`

Pro debug failed buildu pak `get_job_logs` s `failed_only: true`.

### Testovat build PŘED mergem do main

Workflow má `workflow_dispatch`, takže jde spustit na libovolné větvi:
`mcp__github__actions_run_trigger` s `method: run_workflow` a
`ref: <větev>`. U rizikových nativních změn (nový target, Swift kód)
tohle používej vždycky — ušetří to rozbitý `main`.

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
- [ ] Soubor v releasu se pořád jmenuje `CalorieTracker-unsigned.ipa`,
      i když se appka jmenuje FitAI. Kosmetika, ale nekonzistentní —
      pozor, přejmenování je v `build-ios.yml` na několika místech
      (zip, upload-artifact path, `gh release upload`) a **rozbilo by
      přímý odkaz na .ipa, na který se spoléhá fallback aktualizace**
      u appek, které mají starší verzi. Měnit jen s rozmyslem.
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
