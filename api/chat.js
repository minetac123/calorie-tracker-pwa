// AI coach with real Gemini function calling.
//
// This replaces the older [[ACTION]] text-marker approach: the model now gets
// actual tools that mutate the user's profile, targets, workout plan and meal
// plan. The endpoint is stateless — the client sends its current plan state,
// the tools are applied to it here, and the mutated state comes back for the
// client to persist.
//
// It lives at /api/chat rather than its own route because the Hobby plan caps
// a deployment at 12 Serverless Functions, and this endpoint is a strict
// superset of what the old chat handler did. Food-log edits still come back as
// an `action` in the same shape, so a client running stale cached JS keeps
// working. The Telegram bot has its own handler and is unaffected.
const { extractUsername } = require('./_lib/auth');
const { fmtFood } = require('./_lib/coach');
const {
  TOOL_DECLARATIONS, applyTool, emptyPlanState, fillMealWeek,
  fmtProfile, fmtTargets, fmtWorkoutPlan, fmtMealPlan, fmtExerciseHistory, fmtAppSnapshot,
  dayKeyForDate, normDayKey, scaleFoodItem, DAY_CZ
} = require('./_lib/plans');

const COACH_API_KEY = process.env.COACH_API_KEY || process.env.GEMINI_API_KEY || '';
const COACH_MODEL = process.env.COACH_MODEL || 'gemini-2.5-flash';

const MAX_TOOL_ROUNDS = 6;

// Food-log tools. The food log lives in the client's appState, so these are
// NOT applied here — they come back as a proposal and the app shows the same
// confirm card it already uses for [[ACTION]] blocks. Keeping the human in the
// loop matters: the coach must never silently rewrite what someone ate.
const FOOD_CATEGORIES = ['Snídaně', 'Dopolední svačina', 'Oběd', 'Odpolední svačina', 'Večeře', 'Druhá večeře'];

const FOOD_TOOL_NAMES = new Set(['log_food', 'delete_food', 'edit_food', 'log_planned_meal']);

const FOOD_TOOLS = [
  {
    name: 'log_food',
    description: 'Zapiš snědené jídlo do deníku. Volej POUZE když uživatel použije rozkaz („zapiš", „přidej", „dej tam"). NIKDY když jen popisuje co jedl, ptá se na radu, nebo když mu ty sám něco doporučuješ.',
    parameters: {
      type: 'OBJECT',
      properties: {
        category: { type: 'STRING', enum: FOOD_CATEGORIES },
        date: { type: 'STRING', description: 'YYYY-MM-DD. Vynech pro aktuálně zobrazený den.' },
        items: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              name: { type: 'STRING' },
              amount: { type: 'STRING', description: 'např. "150g"' },
              calories: { type: 'NUMBER' },
              protein: { type: 'NUMBER' },
              carbs: { type: 'NUMBER' },
              fat: { type: 'NUMBER' }
            },
            required: ['name', 'amount', 'calories', 'protein', 'carbs', 'fat']
          }
        }
      },
      required: ['category', 'items']
    }
  },
  {
    name: 'log_planned_meal',
    description: 'Zapíše do deníku naplánované jídlo v tom množství, které uživatel SKUTEČNĚ snědl. Použij, když řekne kolik toho snědl — „snědl jsem o 100 kcal míň", „dal jsem si jen půlku", „snědl jsem to celé", „nechal jsem třetinu". NEMĚNÍ jídelníček, jen zapisuje realitu. Zadej BUĎ actualCalories, NEBO portionPercent.',
    parameters: {
      type: 'OBJECT',
      properties: {
        day: { type: 'STRING', description: 'Den jídla v plánu (mon–sun)' },
        mealId: { type: 'STRING', description: 'ID jídla z kontextu' },
        actualCalories: { type: 'INTEGER', description: 'Kolik kcal reálně snědl' },
        portionPercent: { type: 'INTEGER', description: 'Kolik procent porce snědl (100 = všechno, 50 = půlka)' }
      },
      required: ['day', 'mealId']
    }
  },
  {
    name: 'delete_food',
    description: 'Smaž zapsané jídlo. Volej jen na výslovný rozkaz uživatele.',
    parameters: {
      type: 'OBJECT',
      properties: {
        ids: { type: 'ARRAY', items: { type: 'STRING' }, description: 'ID položek z kontextu dnešního jídla' },
        category: { type: 'STRING', enum: FOOD_CATEGORIES, description: 'Nebo smaž celou kategorii' },
        date: { type: 'STRING', description: 'YYYY-MM-DD' }
      }
    }
  },
  {
    name: 'edit_food',
    description: 'Uprav už zapsané jídlo (množství, makra, název). Volej jen na výslovný rozkaz uživatele.',
    parameters: {
      type: 'OBJECT',
      properties: {
        id: { type: 'STRING', description: 'ID položky z kontextu' },
        changes: {
          type: 'OBJECT',
          properties: {
            name: { type: 'STRING' },
            amount: { type: 'STRING' },
            calories: { type: 'NUMBER' },
            protein: { type: 'NUMBER' },
            carbs: { type: 'NUMBER' },
            fat: { type: 'NUMBER' }
          }
        }
      },
      required: ['id', 'changes']
    }
  }
];

// Translate a food tool call into the action shape the client already knows.
// `state` is needed by log_planned_meal, which reads the planned meal and
// scales it to whatever the user actually ate.
function foodActionFromCall(name, args, state) {
  const a = args || {};
  if (name === 'log_food') {
    return { type: 'add', category: a.category, date: a.date, items: a.items || [] };
  }
  if (name === 'delete_food') {
    return { type: 'delete', ids: a.ids, category: a.category, date: a.date };
  }
  if (name === 'edit_food') {
    return { type: 'edit', id: a.id, changes: a.changes || {} };
  }
  if (name === 'log_planned_meal') {
    const day = normDayKey(a.day);
    if (!day || !state.mealPlan || !state.mealPlan.days[day]) return null;
    const meal = state.mealPlan.days[day].meals.find((m) => m.id === a.mealId);
    if (!meal || !meal.calories) return null;

    // Work out the portion actually eaten. Explicit calories win over percent.
    let factor;
    if (a.actualCalories != null && Number(a.actualCalories) > 0) {
      factor = Number(a.actualCalories) / meal.calories;
    } else if (a.portionPercent != null && Number(a.portionPercent) > 0) {
      factor = Number(a.portionPercent) / 100;
    } else {
      factor = 1;
    }
    factor = Math.max(0.05, Math.min(3, factor));

    const items = (meal.items || []).map((i) => scaleFoodItem(i, factor));
    if (!items.length) return null;
    return {
      type: 'add',
      category: meal.category,
      items,
      replacesPlannedMeal: meal.id,
      _note: `${Math.round(meal.calories * factor)} kcal z plánovaných ${meal.calories}`
    };
  }
  return null;
}

// Shared voice rules — identical to the food coach so the app has one persona.
const STYLE = `STYL — DODRŽUJ PŘESNĚ:
- vždy začínej malým písmenem
- NIKDY nekonči zprávu tečkou
- žádné emoji (jedině když si o ně user vysloveně řekne)
- piš JAK ČLOVĚK V CHATU: krátce, jedna myšlenka na zprávu
- když máš dvě krátký myšlenky, rozděl je na DVĚ zprávy oddělený řádkem se třema svislejma čárama: |||  (max 3 zprávy)
- žádné generické AI fráze, nic formálního, nevysvětluj přehnaně
- slang v pohodě (bro, btw, easy, v pohodě, mazec, brutál)
- žádné vykřičníky pokud fakt nejsi hyped`;

function onboardingPrompt(ctx) {
  return `Jsi AI kouč v appce FitAI a právě vedeš PRVNÍ konverzaci s novým uživatelem. Píšeš jako kámoš z gen z, ne jako dotazník.

${STYLE}

TVŮJ ÚKOL — ONBOARDING:
Postupně, v přirozené konverzaci, zjisti tyhle věci. PTÁŠ SE VŽDY JEN NA JEDNU VĚC NAJEDNOU a čekáš na odpověď. Nikdy nevysyp všechny otázky naráz — tohle je chat, ne formulář.
1. cíl — chce zpevnit (recomp), zhubnout (cut) nebo nabrat (bulk)
2. pohlaví, věk, výška, váha (klidně se zeptej na víc těchhle naráz, patří k sobě)
3. kolikrát týdně trénuje a jak dlouho jeden trénink trvá
4. dietní omezení (vegetarián, bez laktózy…)
5. co nemá rád / na co má alergii
6. jaké má vybavení — posilovna, domácí činky, nebo jen vlastní váha
7. jak dlouho už cvičí — začátečník / pokročilý / zkušený

PRAVIDLA:
- Po KAŽDÉ odpovědi uživatele hned zavolej save_profile s tím, co ses právě dozvěděl. Neschovávej si to na konec.
- Když uživatel odpoví na víc věcí naráz, ulož všechny.
- Když už máš všechno (save_profile ti vrátí readyForTargets:true), postupuj v TOMHLE pořadí:
  a) zavolej compute_targets — dostaneš spočítané kalorie a makra
  b) zavolej set_workout_plan — vygeneruj celý týdenní split podle jeho vybavení, zkušenosti a počtu tréninků. Netréninkové dny dej rest:true
  c) zavolej set_meal_plan s PŘESNĚ 3 dny (mon, tue, wed) — tři různé dny jídla. Appka je sama rozkopíruje na zbytek týdne, takže víc dnů neposílej. KAŽDÝ den musí makry vyjít zhruba na cíle z compute_targets (±5 %). Respektuj alergie a co nemá rád
  d) až potom napiš krátkou zprávu, co jsi mu připravil
- Tyhle tři nástroje zavolej NARÁZ v jedné odpovědi, ať to netrvá věčnost.
- Drž se limitu 3 dnů u set_meal_plan. Když pošleš víc, odpověď se nevejde do limitu a celé to spadne.
- U jídelníčku piš reálné české jídlo, ne fitness katalog. Gramáž musí sedět na makra.
- NIKDY si čísla kalorií nevymýšlej — vždycky použij compute_targets.

ROZHODUJ ZA NĚJ — TOHLE JE DŮLEŽITÉ:
Když uživatel řekne cokoliv ve smyslu „nevím", „je mi to jedno", „dej mi libovolný", „vymysli to", „je to jedno", „cokoliv", „ty víš líp" — okamžitě PŘESTAŇ se ptát a ROZHODNI ZA NĚJ. Vyber rozumnou variantu sám a rovnou zavolej nástroje.
- NEnabízej mu další možnosti na výběr
- NEptej se „líbí se ti tenhle směr?" ani „mám ti to tam naházet?"
- Prostě to udělej a až POTOM krátce napiš, co jsi vybral, ať to může změnit
Ptej se jen na to, co fakt nemůžeš uhodnout (alergie, cíl). Zbytek si domysli podle profilu — na tom, jestli má v úterý rýži nebo brambory, nic nestojí.
Nikdy nedávej v jedné zprávě víc než JEDNU otázku.

=== CO UŽ VÍŠ O UŽIVATELI ===
${fmtProfile(ctx.profile)}

=== SPOČÍTANÉ CÍLE ===
${fmtTargets(ctx.targets)}

Dnes je ${ctx.todayDate} (${DAY_CZ[ctx.todayKey]}).`;
}

function coachPrompt(ctx) {
  return `Jsi AI kouč v appce FitAI. Píšeš jako kámoš z gen z, ne jako oficiální asistent. Máš přístup ke VŠEM datům uživatele v aplikaci.

${STYLE}

${ctx.focus ? `
!!! DOMLUVA U KONKRÉTNÍHO JÍDLA — TOHLE JE TEĎ NEJDŮLEŽITĚJŠÍ !!!
Uživatel otevřel okno u jednoho konkrétního jídla. VÍŠ PŘESNĚ, o které jde:
${ctx.focus.summary || ''}

- NIKDY se neptej „myslíš to a to jídlo?" ani na potvrzení, které jídlo myslí. Víš to. Ptát se je trapné.
- NEZDRAV ho. Je uprostřed řešení jídla, ne na začátku konverzace.
- Všechno, co napíše, se týká tohohle jídla.

CO UDĚLAT PODLE TOHO, CO ŘÍKÁ (day="${ctx.focus.day}", mealId="${ctx.focus.mealId}"):
- chce míň/víc kalorií, menší/větší porci, „ať to má 450 kcal" → scale_meal
- chce změnit gramáž suroviny („dej sekanou na 120 g", „míň brambor") → adjust_meal_items
- chce úplně jiné jídlo → replace_meal
- ŘÍKÁ, KOLIK TOHO SNĚDL („snědl jsem o 100 kcal míň", „dal jsem si jen půlku", „snědl jsem to celé") → log_planned_meal se skutečným množstvím. TOHLE NEMĚNÍ PLÁN, jen zapíše do deníku, co fakt snědl
- jídlo nesnědl vůbec → appka ho už odškrtla, ty jen poraď, čím to dohnat ve zbytku dne
- jen se ptá nebo si kecá → žádný nástroj, prostě odpověz

Odpovídej krátce a věcně k tomuhle jídlu.

` : ''}I tak buď fakt užitečný: propoj data a poraď na rovinu. Nediagnostikuj nemoci, u vážnejších věcí pošli k doktorovi.

MÁŠ VŠECHNA DATA — NEPTEJ SE NA NĚ:
Výš v tomhle promptu máš KOMPLETNÍ obsah aplikace: profil, cíle, tréninkový plán, jídelníček, co snědl dnes i posledních 14 dní, váhu a její vývoj, vodu, historii vah u cviků, oblíbená jídla, série a dodržování plánu.
- NIKDY se neptej na něco, co si můžeš přečíst. Žádné „kolik kalorií ti chybí do cíle?" — spočítej si to a rovnou řekni číslo
- Žádné „mrknu na to" nebo „pošli mi to" — TY TO UŽ MÁŠ
- Když se ptá „jak na tom jsem", odpověz konkrétními čísly z dat, ne obecně
- Když nějaký údaj v datech opravdu chybí, řekni rovnou že ho nemáš — nepředstírej

POSLOUCHEJ USERA — NEJDŮLEŽITĚJŠÍ:
- Vždycky reaguj na to, co user fakt napsal. Když se zeptá, odpověz na TO
- NEopakuj pořád dokola to samý (bílkoviny, cíle, váhu), když se ho to netýká
- Když tě jen pozdraví, pozdrav zpátky a zeptej se co je — žádná přednáška
- Když si jen kecá, kecej zpátky. Seš kámoš, ne motivační plakát

=== NÁSTROJE — MĚNÍŠ APPKU DOOPRAVDY ===
Máš nástroje, které SKUTEČNĚ mění data v appce. Když si uživatel řekne o změnu, NEPOPISUJ ji slovy — ZAVOLEJ nástroj. Příklady:
- „zapiš mi k obědu kuřecí prso 200g" → log_food (POZOR: jen na přímý rozkaz, viz níž)
- „dnes nemám čas na nohy, přehoď to na zítra" → swap_workout_days
- „nemám rád losos, dej mi něco jinýho" → replace_meal (nové jídlo s podobnými makry)
- „ať má oběd míň kalorií" → scale_meal (jen cílové kalorie, přepočet udělá appka)
- „dej brambory na 100 g" → adjust_meal_items
- „chci přidat víc bílkovin" → set_targets, a pak update_meal_plan_day / set_meal_plan aby to sedělo
- „byl jsem týden nemocnej, uprav mi plán" → set_workout_plan s lehčím rozjezdem
- „změň mi středu na push" → update_workout_day
- změna váhy / cíle → save_profile a potom compute_targets

PRAVIDLA PRO NÁSTROJE:
- NIKDY nepiš, že jsi něco upravil, dokud jsi doopravdy nezavolal nástroj a nedostal ok:true. Věta typu „upravil jsem ti oběd na 450 kcal" bez zavolání nástroje je LEŽ — uživatel pak v appce vidí pořád staré hodnoty. Radši nejdřív zavolej nástroj a teprve pak piš.
- Čísla, která hlásíš uživateli, ber Z VÝSLEDKU nástroje, ne z vlastní hlavy.
- Po zavolání nástroje dostaneš zpátky výsledek. Teprve pak napiš uživateli KONKRÉTNĚ co se změnilo (např. „nohy jsou teď ve středu, push se posunul na dnešek"), ne jen „jasně, mám to"
- Když si změnu nevyžádal a jen se ptá na radu, žádný nástroj nevolej — jen poraď
- Když měníš jídlo v plánu, drž makra blízko původním, ať sedí denní cíle
- Respektuj alergie a co nemá rád — nikdy je nenavrhuj

ROZHODUJ ZA NĚJ:
Když řekne „nevím", „je mi to jedno", „dej mi libovolný", „vymysli", „cokoliv" — NEptej se dál a rovnou to udělej. Vyber sám a zavolej nástroj. Až potom krátce napiš, co jsi vybral.
Žádné „líbí se ti tenhle směr?" ani nabídky variant na výběr. Max JEDNA otázka na zprávu, a jen když ji fakt potřebuješ.
Když ti řekne kontext (jede do Egypta, je u babičky, nemá lednici), zohledni ho v jídle sám a neptej se na detaily.

ZÁPIS SNĚDENÉHO JÍDLA (log_food / delete_food / edit_food) — PŘÍSNĚ:
Tyhle tři volej JEN když uživatel použije přímý rozkaz: „přidej", „zapiš", „dej tam", „smaž", „odstraň", „uprav", „změň".
NIKDY je nevolej když:
- ty sám navrhuješ, co by mohl sníst
- uživatel se jen ptá na radu ohledně stravy
- uživatel popisuje co jedl, ale neřekne „zapiš"
- uživatel říká že nestíhá cíle nebo se omlouvá
Při pochybnosti nevolej nic. Tyhle změny se uživateli ukážou k potvrzení, takže je jen navrhuješ — krátce popiš co jsi navrhl.
Mazání/úpravu navrhuj jen když jde o omyl nebo duplikát, NE aby si user vylepšil čísla.

=== PROFIL ===
${fmtProfile(ctx.profile)}

=== DENNÍ CÍLE ===
${fmtTargets(ctx.targets)}

=== TRÉNINKOVÝ PLÁN ===
${fmtWorkoutPlan(ctx.workoutPlan, ctx.todayKey)}

=== JÍDELNÍČEK ===
${fmtMealPlan(ctx.mealPlan, ctx.todayKey)}
${ctx.lockedMeals.length ? `\nZAMČENÁ JÍDLA (uživatel si je uzamkl — NIKDY je neměň ani nepřegeneruj): ${ctx.lockedMeals.join(', ')}` : ''}

=== DNEŠNÍ PROGRESS (co fakt snědl) ===
${fmtFood(ctx.foodContext)}

=== DNEŠNÍ TRÉNINK ===
${ctx.workoutStatus}

=== HISTORIE VAH (progressive overload) ===
${fmtExerciseHistory(ctx.exerciseHistory)}

Když se uživatel ptá na progres, opírej se o čísla výš — konkrétně, ne obecně.
Když je cvik označený [STAGNUJE], sám navrhni deload (−10 % váhy na týden) nebo výměnu cviku.
Když má na posledním tréninku splněný horní rozsah opakování, navrhni přidat 2,5 kg (u velkých cviků 5 kg).
Když ti nahlásí odcvičenou sérii („dal jsem bench 3x8 na 42,5"), zavolej log_set.


=== VŠECHNA OSTATNÍ DATA Z APPKY ===
${fmtAppSnapshot(ctx.appSnapshot)}

=== PAMĚŤ ===
${ctx.memBlock}

Dnes je ${ctx.todayDate} (${DAY_CZ[ctx.todayKey]}), čas ${ctx.nowTime || 'neznámý'}.`;
}

// Models tried in order. If the primary is overloaded, unavailable or just
// returns nothing usable, the next one takes over instead of failing the turn.
const MODEL_CHAIN = [...new Set([COACH_MODEL, 'gemini-flash-latest', 'gemini-2.5-flash-lite'])];

// One Gemini call. Returns the parsed response or null.
async function callGemini(model, payload, timeoutMs) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${COACH_API_KEY}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      console.error(`Gemini ${model}: ${resp.status} ${txt.slice(0, 200)}`);
      return null;
    }
    return await resp.json();
  } catch (e) {
    console.error(`Gemini ${model} failed:`, e.name === 'AbortError' ? 'timeout' : e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function partsOf(gData) {
  const cand = gData && gData.candidates && gData.candidates[0];
  return {
    cand,
    parts: (cand && cand.content && Array.isArray(cand.content.parts)) ? cand.content.parts : []
  };
}

// Walk the model chain until one returns something we can actually use (text
// or a function call). A response that came back 200 but empty counts as a
// failure too — that is what a MAX_TOKENS truncation looks like, and silently
// treating it as "the model had nothing to say" is how the coach used to die
// mid-onboarding.
async function callGeminiChain(payload, deadline, label) {
  let truncated = false;

  for (const model of MODEL_CHAIN) {
    const remaining = deadline - Date.now();
    if (remaining < 5000) break;

    const gData = await callGemini(model, payload, Math.min(28000, remaining));
    if (!gData) continue; // network/HTTP failure — already logged, try next

    const { cand, parts } = partsOf(gData);
    const usable = parts.some((p) => p && (p.functionCall || (p.text && p.text.trim())));
    if (usable) return { gData, model, truncated: false };

    const reason = cand && cand.finishReason;
    console.error(`Gemini ${model} [${label}]: empty response, finishReason=${reason}`);
    if (reason === 'MAX_TOKENS') truncated = true;
  }

  return { gData: null, model: null, truncated };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metoda není povolena' });

  const username = extractUsername(req.headers.authorization);
  if (!username) return res.status(401).json({ error: 'Nepřihlášen' });
  if (!COACH_API_KEY) {
    return res.status(500).json({ error: 'AI Kouč není nakonfigurován (chybí COACH_API_KEY / GEMINI_API_KEY).' });
  }

  try {
    const {
      message, history, mode, image,
      profile, targets, workoutPlan, mealPlan, lockedMeals, exerciseHistory, exerciseLogs,
      appSnapshot, focus, foodContext, workoutStatus, memories, today, nowTime
    } = req.body || {};

    if ((!message || !message.trim()) && !image) {
      return res.status(400).json({ error: 'Prázdná zpráva' });
    }

    const isOnboarding = mode === 'onboarding';
    const todayDate = (today && /^\d{4}-\d{2}-\d{2}$/.test(today)) ? today : null;
    const todayKey = dayKeyForDate(todayDate);

    // Plan state the tools operate on. Starts from whatever the client has.
    const state = Object.assign(emptyPlanState(), {
      profile: profile || {},
      targets: targets || null,
      workoutPlan: workoutPlan || null,
      mealPlan: mealPlan || null,
      exerciseLogs: (exerciseLogs && typeof exerciseLogs === 'object') ? exerciseLogs : {}
    });

    const memBlock = (Array.isArray(memories) && memories.length)
      ? memories.map((m) => `- ${String(m).trim()}`).join('\n')
      : 'Žádná uložená fakta.';

    const ctx = {
      profile: state.profile, targets: state.targets,
      workoutPlan: state.workoutPlan, mealPlan: state.mealPlan,
      foodContext, memBlock, todayDate: todayDate || 'dnes', todayKey,
      nowTime: (typeof nowTime === 'string' && /^\d{1,2}:\d{2}$/.test(nowTime)) ? nowTime : null,
      workoutStatus: workoutStatus || 'Dnešní trénink zatím nezačal.',
      lockedMeals: Array.isArray(lockedMeals) ? lockedMeals : [],
      exerciseHistory: Array.isArray(exerciseHistory) ? exerciseHistory : [],
      appSnapshot: (appSnapshot && typeof appSnapshot === 'object') ? appSnapshot : null,
      focus: (focus && typeof focus === 'object') ? focus : null
    };

    const systemInstruction = isOnboarding ? onboardingPrompt(ctx) : coachPrompt(ctx);

    // Build the conversation.
    const contents = [];
    if (Array.isArray(history)) {
      history.slice(-16).forEach((m) => {
        if (!m || !m.text) return;
        contents.push({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.text }]
        });
      });
    }
    const userParts = [];
    if (message && message.trim()) {
      userParts.push({ text: message });
    } else {
      userParts.push({ text: '(uživatel poslal fotku jídla)' });
    }
    if (image) {
      const im = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(image);
      if (im) userParts.push({ inlineData: { mimeType: im[1], data: im[2] } });
    }
    contents.push({ role: 'user', parts: userParts });

    // Onboarding has no food log to touch yet — only offer the plan tools.
    const activeTools = isOnboarding
      ? TOOL_DECLARATIONS
      : TOOL_DECLARATIONS.concat(FOOD_TOOLS);

    const basePayload = {
      systemInstruction: { parts: [{ text: systemInstruction }] },
      tools: [{ functionDeclarations: activeTools }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 24576,
        thinkingConfig: { thinkingBudget: 0 }
      }
    };

    // ---- Tool loop: model calls tools, we apply them and feed results back ----
    const deadline = Date.now() + 55000;
    const appliedTools = [];
    let reply = null;
    let planChanged = false;
    let foodAction = null;

    let hitTokenLimit = false;
    let shrinkRetries = 0;

    // The loop is a function so it can be re-entered once when the model
    // claims a change it never actually made (see below).
    async function runToolLoop() {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const remaining = deadline - Date.now();
      if (remaining < 5000) break;

      const attempt = await callGeminiChain(
        Object.assign({}, basePayload, { contents }),
        deadline,
        `round ${round}`
      );

      if (!attempt.gData) {
        // Every model came back unusable. If the reason was truncation, the
        // request itself was too big — tell the model to work in smaller
        // batches and give it another go rather than dropping the turn.
        if (attempt.truncated && shrinkRetries < 2) {
          shrinkRetries++;
          hitTokenLimit = true;
          contents.push({
            role: 'user',
            parts: [{ text: 'SYSTÉM: předchozí odpověď byla moc dlouhá a nevešla se do limitu. Rozděl práci na menší dávky — set_meal_plan volej vždy nanejvýš na 2 dny naráz (zbytek dogeneruješ dalším voláním) a piš stručněji.' }]
          });
          continue;
        }
        break;
      }

      const { parts } = partsOf(attempt.gData);
      const text = parts.map((p) => (p && p.text) ? p.text : '').join('').trim();
      const calls = parts.filter((p) => p && p.functionCall).map((p) => p.functionCall);

      if (!calls.length) {
        if (text) reply = text;
        break;
      }

      // Apply every requested tool and collect responses for the next turn.
      const responseParts = [];
      calls.forEach((fc) => {
        let result;
        if (FOOD_TOOL_NAMES.has(fc.name)) {
          // Food edits need the user's OK, so they are proposed, not applied.
          // Only the first proposal per turn survives — one card at a time.
          const proposed = foodActionFromCall(fc.name, fc.args, state);
          if (proposed && !foodAction) {
            foodAction = proposed;
            result = { ok: true, pending: true, note: 'Návrh byl poslán uživateli k potvrzení. Krátce mu popiš, co jsi navrhl — nepiš, že je to hotové.' };
          } else {
            result = { ok: false, error: 'Najednou lze navrhnout jen jednu změnu jídelního deníku.' };
          }
        } else {
          try {
            result = applyTool(fc.name, fc.args, state);
          } catch (e) {
            console.error(`Tool ${fc.name} threw:`, e.message);
            result = { ok: false, error: 'Nástroj selhal: ' + e.message };
          }
          if (result && result.ok) planChanged = true;
        }
        if (result && result.ok) appliedTools.push({ name: fc.name, result });
        console.log(`tool ${fc.name} -> ${result && result.ok ? 'ok' : 'FAIL: ' + (result && result.error)}`);
        responseParts.push({
          functionResponse: { name: fc.name, response: { result } }
        });
      });

      // Echo the model's own turn back, then hand it the tool results.
      contents.push({ role: 'model', parts: parts.filter((p) => p.functionCall || p.text) });
      contents.push({ role: 'user', parts: responseParts });

      // Keep any text the model produced alongside the calls as a fallback.
      if (text && !reply) reply = text;
    }
    }

    await runToolLoop();

    // The model sometimes NARRATES a change instead of calling the tool —
    // "upravil jsem ti oběd na 450 kcal" while the plan is untouched. That is
    // worse than refusing, because the user believes the app changed. Catch it
    // and give the model exactly one chance to actually do it.
    const CLAIMS_A_CHANGE = /\b(upravil|upravila|změnil|změnila|nastavil|nastavila|snížil|snížila|zvýšil|zvýšila|vyměnil|vyměnila|přehodil|zmenšil|zvětšil|dal jsem|přidal jsem|ubral jsem|je teď|máš teď|hotovo|udělal jsem|udělala jsem)\b/i;

    if (ctx.focus && reply && !planChanged && !foodAction && CLAIMS_A_CHANGE.test(reply)) {
      console.log('Model claimed a change without calling a tool — forcing a correction round');
      contents.push({ role: 'model', parts: [{ text: reply }] });
      contents.push({
        role: 'user',
        parts: [{ text: 'SYSTÉM: Právě jsi napsal, že jsi něco upravil, ale NEZAVOLAL jsi žádný nástroj, takže se v aplikaci NIC nezměnilo a uživatel vidí pořád původní hodnoty. Buď teď ZAVOLEJ správný nástroj (scale_meal na změnu kalorií, adjust_meal_items na změnu gramáže, replace_meal na výměnu jídla), nebo uživateli na rovinu napiš, že to udělat neumíš. Nikdy netvrď, že je něco hotové, když to hotové není.' }]
      });
      reply = null;
      await runToolLoop();

      // Still nothing applied? Then whatever it wants to say, the plan is
      // unchanged — so never let a "done!" through. An honest failure beats a
      // confident lie the user only discovers by looking at the card.
      if (!planChanged && !foodAction) {
        if (reply) console.log(`Suppressed false claim: ${reply.slice(0, 120)}`);
        reply = 'tohle se mi nepovedlo změnit ||| zkus to říct jinak, třeba „dej to na 450 kcal"';
      } else if (!reply) {
        reply = 'jo, teď už je to fakt upravený';
      }
    }

    // Onboarding promises a full week. The model only writes a few distinct
    // days (anything more truncates), so rotate them across the empty ones.
    if (isOnboarding && state.mealPlan) {
      const filled = fillMealWeek(state.mealPlan);
      if (filled.length) {
        planChanged = true;
        console.log(`Meal week rotated into: ${filled.join(', ')}`);
      }
    }

    if (!reply) {
      if (appliedTools.length) {
        reply = 'hotovo, mrkni na plán';
      } else if (hitTokenLimit) {
        // Be honest: this is not overload, it is us asking for too much at once.
        reply = 'ten plán mi vyšel moc velkej najednou ||| napiš „zkus to znovu" a udělám ho po částech';
      } else {
        reply = 'sorry, jsem teď dost cooked, zkus to za chvíli';
      }
    }

    return res.status(200).json({
      success: true,
      reply,
      planChanged,
      action: foodAction,
      appliedTools: appliedTools.map((t) => t.name),
      profile: state.profile,
      targets: state.targets,
      exerciseLogs: state.exerciseLogs,
      workoutPlan: state.workoutPlan,
      mealPlan: state.mealPlan,
    });
  } catch (error) {
    console.error('Coach error:', error);
    return res.status(500).json({ error: 'Chyba serveru: ' + error.message });
  }
};
