# FitAI Coach MCP Server 🏋️‍♂️🤖

Model Context Protocol (MCP) server pro aplikaci **FitAI** (`calorie-tracker-pwa`).

Umožňuje AI asistentům, trenérům (např. **IronGains**, Claude Desktop, Cursor, vlastní boti) plný přístup ke všem funkcím aplikace:
- **Tvorba a úprava tréninkových plánů** (7denní split, cviky, série, opakování, váhy, pauzy, deload, progresivní přetížení)
- **Zápis a historie workoutů** (odcvičené série, váhy, RPE, osobní rekordy PR, celé odjeté tréninky)
- **Kalorie a výživa** (zápis jídel, denní přehled maker, dočasné režimy na svátky/dovolenou)
- **Tělo a biometrika** (tělesná váha, obvody, kardio, spánek, monitoring zranění)
- **Trenérská analytika** (výpočet 1RM, tréninková tonáž a objem, detekce stagnace)
- **Dlouhodobá paměť kouče** (stálé preference, vybavení v posilovně, zdravotní omezení)

---

## 🚀 Rychlý start

Server běží přes standardní protokol **JSON-RPC 2.0 přes stdio** a nevyžaduje žádné externí závislosti.

```bash
# Spuštění serveru
node mcp/server.js
```

### Konfigurace prostředí (Environment Variables)

| Proměnná | Popis | Výchozí hodnota |
|---|---|---|
| `FITAI_API_URL` | URL backendu FitAI | `https://project-8rjn0.vercel.app` |
| `FITAI_USERNAME` | Uživatelské jméno v appce | Volitelné (lze zadat přes tool `fitai_login`) |
| `FITAI_PASSWORD` | Heslo k účtu | Volitelné |
| `FITAI_TOKEN` | Podepsaný session token | Volitelné (vygeneruje se při login) |
| `FITAI_CACHE_FILE` | Cesta k lokální cache | `.fitai_cache.json` |

*Poznámka: Server funguje i offline nebo v lokálním režimu – pokud není nastaven login, ukládá změny do lokální cache a po přihlášení je synchronizuje do cloudu.*

---

## 🛠️ Konfigurace pro Claude Desktop

Do souboru `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "fitai-coach": {
      "command": "node",
      "args": ["/cesta/k/repo/calorie-tracker-pwa/mcp/server.js"],
      "env": {
        "FITAI_API_URL": "https://project-8rjn0.vercel.app",
        "FITAI_USERNAME": "tve_jmeno",
        "FITAI_PASSWORD": "tve_heslo"
      }
    }
  }
}
```

---

## 📋 Přehled dostupných nástrojů (48 tools)

### 1. Tréninkové plány & Builder (Dělání workoutů)
- `get_workout_plan` – Zobrazí celý 7denní split (pondělí až neděle) nebo konkrétní den.
- `get_today_workout` – Vrátí trénink naplánovaný na dnešek nebo zadané datum.
- `set_workout_plan` – Vytvoří / přepíše kompletní týdenní rozpis (všech 7 dní).
- `update_workout_day` – Upraví konkrétní den (název, rest day, seznam cviků).
- `add_exercise_to_plan` – Přidá cvik do dne (série, opakování, cílová váha, pauza, poznámka, pozice).
- `remove_exercise_from_plan` – Odebere cvik ze dne.
- `substitute_exercise` – Vymění jeden cvik za jiný s odůvodněním.
- `reorder_plan_exercises` – Změní pořadí cviků v tréninku.
- `set_rest_day` – Nastaví den jako den volna nebo naopak tréninkový.
- `copy_workout_day` – Zkopíruje trénink z jednoho dne do druhého.
- `swap_workout_days` – Prohodí tréninky mezi dvěma dny.
- `progress_exercise` – Progresivní přetížení (+kg nebo +opakování).
- `suggest_warmup_sets` – Spočítá pyramidu rozcvičky podle pracovní váhy.
- `deload_week` – Automatické snížení objemu/intenzity na regenerační týden.
- `extend_or_shorten_workout` – Rychlé zkrácení nebo prodloužení tréninku podle času.
- `set_exercise_tempo_and_notes` – Nastavení tempa (např. 3-0-1-0) a trenérských instrukcí.

### 2. Historie vah & Zápis tréninků
- `get_exercise_history` – Kompletní historie vah a sérií pro daný cvik včetně osobáku (PR).
- `list_all_known_exercises` – Katalog všech cviků s PR a posledními vahami.
- `log_set` – Zápis odcvičené série (váha, opakování, RPE).
- `log_workout_session` – Uložení celého odjetého tréninku do historie.
- `get_session_history` – Seznam posledních dokončených tréninků.

### 3. Kalorie & Jídelníček
- `get_food_log` – Denní přehled kalorií, bílkovin, sacharidů, tuků a zbývajících hodnot.
- `log_food_item` – Zápis jídla s gramáží a makry.
- `delete_food_item` – Smazání jídla z denního záznamu.
- `get_targets` / `set_targets` – Zobrazení a úprava denních cílů.
- `set_calorie_mode` / `clear_calorie_mode` – Dočasný režim (dovolená, svátky, refeed).

### 4. Tělo, váha a biometrika
- `get_weight_history` / `log_weight` – Historie a zápis tělesné váhy.
- `log_body_measurement` – Zápis obvodů (pas, hrudník, paže, stehna, boky).
- `log_water` – Evidence vypité vody v ml.
- `log_cardio` – Zápis kardio aktivit (běh, chůze, plavání, rotoped).
- `log_sleep` – Evidence délky a kvality spánku (WHOOP kompatibilní).
- `log_injury` / `resolve_injury` – Evidence zranění a prevence rizikových cviků.

### 5. Analytika a koučování
- `estimate_1rm` – Výpočet 1RM maxima a procentních tréninkových zón.
- `get_volume_stats` – Tonáž a objem v kg.
- `get_progress_summary` – Celkový souhrn consistency a výsledků.
- `detect_stagnation` – Detekce stagnujících cviků.

### 6. Profil a paměť trenéra
- `get_user_profile` / `update_user_profile` – Zobrazení a úprava parametrů uživatele.
- `list_coach_memories` / `add_coach_memory` / `forget_coach_memory` – Dlouhodobá paměť kouče.

### 7. Připojení a synchronizace
- `fitai_login` – Přihlášení do FitAI účtu.
- `fitai_sync` – Synchronizace změn s cloudem.
- `fitai_status` – Stav spojení a diagnostika.

---

## 🧪 Spuštění testů

```bash
node mcp/test.js
```
Všechny testy ověřují JSON-RPC komunikaci, registraci nástrojů, tvorbu plánu, rozcvičku, výpočet 1RM, zápis jídla, váhy i deload.
