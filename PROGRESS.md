# Progress / poznámky pro pokračování

Tenhle soubor je pro mě (Claude) i pro tebe, kdybys pokračoval v jiném
nástroji (Antigravity apod.) a nová session nebude mít kontext z chatu.
Aktualizuju ho průběžně, ne jen na konci.

Poslední update: **2026-10-26**, verze appky **3.1.2** (FitAI Coach MCP Server).

### Novinka (2026-10-26) — FitAI Coach MCP Server (Model Context Protocol)
- Do repozitáře přidán plnohodnotný standardní **MCP Server** (mcp/server.js, mcp/client.js, mcp/tools.js, mcp/README.md) pro externí AI kouče (Claude Desktop, Cursor, IronGains i jakéhokoliv MCP klienta).
- Poskytuje **48 trenérských nástrojů** s plným přístupem ke všem funkcím FitAI:
  1. **Dělání workoutů & tréninkové plány**: get_workout_plan, get_today_workout, set_workout_plan, update_workout_day, add_exercise_to_plan, remove_exercise_from_plan, substitute_exercise, reorder_plan_exercises, set_rest_day, copy_workout_day, swap_workout_days, progress_exercise, suggest_warmup_sets, deload_week, extend_or_shorten_workout, set_exercise_tempo_and_notes.
  2. **Historie vah, série & osobní rekordy**: get_exercise_history, list_all_known_exercises, log_set, log_workout_session, get_session_history.
  3. **Kalorie & výživa**: get_food_log, log_food_item, delete_food_item, get_targets, set_targets, set_calorie_mode, clear_calorie_mode.
  4. **Tělo, biometrika & regenerace (WHOOP ready)**: get_weight_history, log_weight, log_body_measurement, log_water, log_cardio, log_sleep, log_injury, resolve_injury.
  5. **Koučovací analytika**: estimate_1rm (Epley + Brzycki + zóny %1RM), get_volume_stats (tonáž v kg), get_progress_summary, detect_stagnation.
  6. **Paměť kouče & profil**: get_user_profile, update_user_profile, list_coach_memories, add_coach_memory, forget_coach_memory.
  7. **Spojení & cloud sync**: fitai_login, fitai_sync, fitai_status.
- **Architektura**:
  - Běží přes čistý stdio (JSON-RPC 2.0 protocol) s nulovými externími závislostmi.
  - Plně napojen na stávající doménovou logiku v api/_lib/ (validace cviků, přepočty, bezpečnost).
  - Podporuje jak cloud sync (/api/sync a /api/login), tak lokální/offline režim s persistencí do cache.
  - Přidán npm script "mcp" a "mcp:test" v package.json.
  - Kompletní automatizovaná testovací sada v mcp/test.js (všech 12 integračních testů ověřeno).


### Novinka ve 3.1.2 — iOS Widget & Live Activity: Rest Timer, Cvik & Kolik naložit
- Rozšířen ActivityKit Live Activity widget na zamykací obrazovce i v Dynamic Islandu (`FitAIWidgets`):
  1. **Rest timer (pauza mezi sériemi)**: Obří, čistý systémový odpočet (`Text(timerInterval:countsDown:)`, 38pt, design `.rounded`, weight `.black`, fitness neonově zelená barva), progress bar a tlačítko „Přeskočit“.
  2. **Jaký cvik**: Název aktuálně prováděného cviku velkým písmem spolu s počítadlem sérií (`2/4 sérií`).
  3. **Kolik naložit / zvednout**: Nová výrazná kartička s ikonou terče ukazující přesnou váhu a opakování pro nadcházející sérii (např. `🎯 Naložit: 85 kg × 6-8` nebo `Další série: 100 kg × 5 op.`), odvozenou z poslední odjeté série nebo z předchozího tréninku, s poznámkou `Minule: 80 kg × 8`.
  4. **Dynamic Island**: Expanded regiony zobrazují název cviku, `🎯 85 kg × 6-8`, sérii `2/4` a velký odpočet pauzy; v kompaktním režimu se zobrazuje odpočet nebo naložená váha.
- Změny v souborech: `ios/App/App/WorkoutActivityAttributes.swift`, `ios/App/App/LiveActivityPlugin.swift`, `ios/App/LiveActivity/WorkoutLiveActivity.swift`, `ios/App/LiveActivity/WorkoutDynamicIsland.swift`, `app.js`.

### Novinka ve 3.1.0 / 3.1.1 — Katalog všech workoutů a kompletní historie vah (`#workouts-modal`) + QA opravy
- Přidáno tlačítko **„🏋️ Workouty“** přímo do živého tréninku (`#session-view`), do obrazovky `Plán → Trénink` (`#plan-workout-view`) a nová karta **„🏋️ Moje workouty a váhy“** do `Moje historie → Váha a progres` (`#history-progress-view`).
- Nový modál `#workouts-modal` (s `z-index: 3600`, takže se otevírá i přímo nad běžícím tréninkem) zobrazuje:
  1. **Všechny workouty / cviky**, které uživatel kdy odjel nebo má v plánu (`getAllKnownExercises()`), s vyhledáváním, osobním rekordem (PR), poslední zvednutou váhou, počtem odjetých tréninků a rozbalitelnou kompletní historií všech sérií a vah (`kg × opakování`) od začátku používání appky.
  2. **Odjeté tréninky** (`getAllPastWorkouts()`) — chronologický seznam všech celých tréninků (ze `sessionHistory` i zrekonstruovaných dnů z `exerciseLogs`) s objemem a všemi sériemi.
- Přímo z katalogu Workouty lze jedním klepnutím **přidat jakýkoliv dříve odjetý cvik do právě běžícího tréninku** (nebo na něj v tréninku rovneu přepnout) a také ho přidat do tréninkového plánu.
- AI Kouč (v běžném chatu, v živém tréninku i v `extend_workout`) dostává rozšířený přehled všech uživatelových workoutů včetně osobáků a při přidávání či obměně cviků z něj předmostně vybírá.
- Cloud sync (`api/sync.js`):
  1. Odjedé série a váhy v `exerciseLogs` a `reconstructedSessions` se netrunkujoí na 45 dní, ale zmergují se s cloudem přes plný `COACH_HISTORY_DAYS` ( = 90 dní), aby modál Workouty měl kompletní data.
  2. Opravena chyba, kdy se při syncu potrthaly starsií série cviků vymazánímāv add-only klienského stavu.
- Dopklņněno 18 nových automatických testů v `exercise-logs-merge.test.js` (vsethny proszly).
- QA oprava eventu `žízeni plánu (`plan-day-order`) a zvyseni z-indexu
celého modálu aby nepřekryval live trénink.

### Novinka ve 2.39.5 — Rebranding na FitAI
- Nadale *FitAI* (předlístři pouze Calorie Tracker).
- Zyskano nové Porche Crest-style fitness logo (chest + dumbbell +
gear) a nové assety pro Capacitor (app file a icony).
- Starý FitAI na telefonu se přejmenuje a vymění ikonu při
novém sideloadu.

## Co je hotovo (shrnuté z chatu)

- [x] FitAI Coach MCP Server (vytvořeno, otestovéno, 48 trenérských tools, stdio, cloud sync)
- [x] Workouty modál (#workouts-modal)
- [x] Kihniva cviků s historií vah (kg × op. dohada)
- [x] Zpostranna analyza PR a poslední zvednuté váhy
- [x] Seznam všech celých odjetých tréninků
- [x] Rychlá obměna cviku v tréninku natvrtu to cool
- [x] Alternativa cviků pro modÁl a AI kouče
- [x] Auto-update logika pro SideStore / GitHub Releases
- [x] Build aktualizací precessu v GitHub Actions (build-ios.yml)
- [x] Kientská check-version-sync logika
- [x] Synchronizace dn úplných historií podly 90 dní v api/sync.js
- [x] Oprava Jerrys AI klejna vercel api gemini klíče

## Znamé zpñsoby polímání a guardy

- Package ios generatory jsou cuvkové a každý symlink máže
  způsobit páis CI.

- Release buildy badejuje na macOS runneru, odepisuje se
  pomocí gh cli.

## Pagěmování a data

Appka je plně logovana do Redisu (Upstash) a Vercel Blobu.
