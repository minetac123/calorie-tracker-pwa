# FitAI — kalorie, tréninky a AI kouč

Progresivní webová appka (PWA) na počítání kalorií a vedení tréninků, s AI koučem,
který vidí na tvoje data a umí je i sám měnit. Bez build kroku — čistý HTML, CSS
a JavaScript, serverless funkce na Vercelu.

Rozhraní i kouč mluví česky.

## Co to umí

**Jídlo**
- zápis jídla ručně, přes vyhledávání v Open Food Facts nebo čtečkou čárových kódů
- vyfoť talíř a kouč z fotky odhadne porci i makra
- denní cíle kalorií a maker, historie po dnech

**Trénink**
- týdenní plán, který ti kouč postaví na míru v onboardingu
- živá tréninková session — série, pauzy, progressive overload podle historie vah
- kouč u tréninku: radí mezi sériemi, umí sám měnit cviky, pauzy i zapisovat série

**AI kouč**
- vidí jídlo, tréninky, váhu i historii chatů a mluví v konkrétních číslech
- umí přidat/upravit/smazat jídlo, přestavět plán nebo postavit mini appku na situaci
  (večeře v restauraci, výlet, svátky)
- dlouhodobá paměť: co mu jednou řekneš, platí i příští měsíc
- dočasný kalorický režim na dovolenou nebo svátky, který sám vyprší

**Telegram bot** (volitelný)
- kouč dostupný přímo z Telegramu — text, fotka jídla i hlasovka
- rychlé příkazy `/dnes`, `/vaha`, `/verze`
- ranní check-in, který se ozve jen když je fakt co říct

**Offline**
- funguje bez signálu, data se drží lokálně a synchronizují, jakmile je připojení

## Jak to rozjet

Potřebuješ účet na [Vercelu](https://vercel.com) a klíč pro
[Google Gemini API](https://aistudio.google.com/apikey). Oboje má free tier,
který na osobní použití bohatě stačí.

```bash
git clone https://github.com/minetac123/calorie-tracker-pwa.git
cd calorie-tracker-pwa
npm install
```

**1. Nasaď na Vercel** — naimportuj repo ve Vercel dashboardu. Žádný build
   command ani output directory nenastavuj, projekt se nebuilduje.

**2. Přidej Redis** — v projektu *Storage → Create Database → Redis (Upstash)*.
   Vercel proměnné `KV_REST_API_URL` a `KV_REST_API_TOKEN` nastaví sám.

**3. Nastav proměnné prostředí** — v *Settings → Environment Variables* doplň
   aspoň `COACH_API_KEY`. Kompletní seznam s vysvětlením je v
   [`.env.example`](.env.example).

**4. Deploy.** Appku si pak v telefonu přidej na plochu, ať běží jako PWA.

### Telegram bot (nepovinné)

1. Napiš [@BotFather](https://t.me/BotFather), založ bota a vezmi si token
2. Nastav `TELEGRAM_BOT_TOKEN` a `TELEGRAM_BOT_USERNAME`
3. V appce *Více → Připojit Telegram* — webhook se zaregistruje sám

### Lokální vývoj

Statickou část otevřeš čímkoliv, co servíruje soubory:

```bash
npx serve .
```

Na `localhost` se cloud sync záměrně vypíná, appka běží jen nad localStorage.
Pro běh serverless funkcí lokálně použij `vercel dev`.

## Jak je to poskládané

```
index.html          celé UI (jedna stránka, přepínané obrazovky)
app.js              veškerá klientská logika a stav
styles.css          styly, light i dark
sw.js               service worker, offline cache
api/                serverless funkce
  chat.js             AI kouč — function calling, nástroje nad plánem
  overview.js         AI přehled dne na hlavní obrazovce
  sync.js             synchronizace stavu do cloudu
  login.js            přihlášení a registrace
  register.js
  telegram*.js        Telegram bot, mini app a ranní check-in
  search.js           vyhledávání jídel (Open Food Facts)
  barcode.js          čtečka čárových kódů
  _lib/               sdílené moduly
    coach.js            system prompt a formátování kontextu
    plans.js            nástroje kouče nad plánem a cíli
    session.js          nástroje kouče u živého tréninku
    signals.js          detekce toho, co v datech stojí za zmínku
    store.js            key-value vrstva nad Upstash Redis
```

Data jsou uložená jako JSON dokumenty v Redisu (`data/<uživatel>.json`),
lokálně v `localStorage` a fotky v IndexedDB.

## Bezpečnost

- **Session tokeny jsou podepsané** HMAC-SHA256. Payload je čitelný, ale bez
  platného podpisu server token odmítne, a podpis nejde vyrobit bez serverového
  tajemství. Platnost půl roku.
- **Hesla jedou na scrypt** s náhodnou solí pro každého uživatele. Účty založené
  za starého SHA-256 hashování se převedou samy při prvním přihlášení, uživatel
  o tom neví.
- **Telegram mini app ověřuje `initData`** podepsaná botím tokenem. Chat ID se
  bere odtud, ne z URL.
- Přihlašování nerozlišuje „účet neexistuje" a „špatné heslo", ať se nedá
  zjistit, která jména jsou zabraná.

Podepisovací tajemství se vezme z `AUTH_SECRET`, a když není nastavené,
vygeneruje se náhodné a uloží do Redisu. Nemusíš tedy nic nastavovat, aby to
bylo bezpečné — ale když chceš tajemství rotovat, stačí `AUTH_SECRET` nastavit
(všichni se pak jednou znovu přihlásí).

Co zůstává otevřené a pull requesty vítány:

- data uživatelů nejsou v úložišti šifrovaná
- není omezený počet pokusů o přihlášení (rate limiting)

## Přispívání

Issues i pull requesty jsou vítané. Kód nemá lint ani test runner — drž se
stylu okolo (komentáře vysvětlují *proč*, ne *co*) a popiš v PR, co se změnou
testuješ.

## Licence

MIT — viz [LICENSE](LICENSE).
