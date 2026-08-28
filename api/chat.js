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
const { MINIAPP_TOOLS, MINIAPP_TOOL_NAMES, applyMiniAppTool, fmtMiniApps } = require('./_lib/miniapp');
const {
  SESSION_TOOLS, SESSION_TOOL_NAMES, applySessionTool, normSessionState, fmtSessionExercises
} = require('./_lib/session');

const COACH_API_KEY = process.env.COACH_API_KEY || process.env.GEMINI_API_KEY || '';
const COACH_MODEL = process.env.COACH_MODEL || 'gemini-2.5-flash';

const MAX_TOOL_ROUNDS = 6;

// Food-log tools. The food log lives in the client's appState, so these are
// NOT applied here — they come back as a proposal and the app shows the same
// confirm card it already uses for [[ACTION]] blocks. Keeping the human in the
// loop matters: the coach must never silently rewrite what someone ate.
const FOOD_CATEGORIES = ['Snídaně', 'Dopolední svačina', 'Oběd', 'Odpolední svačina', 'Večeře', 'Druhá večeře'];

// The coach could never write to its own memory — the user filled it by hand in
// settings — so a constraint stated mid-workout ("tady jsou jen desítky a
// patnáctky") lived only in the chat scrollback and was re-forgotten a few
// messages later. This lets the coach keep it for good.
// One shared conversation log across the main chat, meal chats and workouts.
// Only a recent slice goes into the prompt; anything older is reachable through
// search_history, which keeps the prompt small without losing the past.
// Today's real numbers, as one line. They exist further down in the full food
// dump, but at line ~90 of a 150-line prompt they were getting skimmed: the
// user typed "upss za dnesek" while 383 kcal over target and got back "čau, co
// se stalo" — a question whose answer was already on screen. This goes at the
// very top so it cannot be missed.
function fmtTodayLine(food, workoutStatus) {
  if (!food || !food.totals || !food.goals) return null;
  const t = food.totals;
  const g = food.goals;
  const diff = Math.round((t.calories || 0) - (g.calories || 0));
  const kcal = diff > 0
    ? `${t.calories}/${g.calories} kcal — o ${diff} PŘES cíl`
    : `${t.calories}/${g.calories} kcal — zbývá ${Math.abs(diff)}`;
  const bits = [kcal, `B ${t.protein}/${g.protein} g`];
  if (workoutStatus) {
    const m = String(workoutStatus).match(/hotovo (\d+\/\d+) cviků/);
    if (m) bits.push(`trénink ${m[1]}`);
    else if (/dokončen/i.test(workoutStatus)) bits.push('trénink hotový');
    else if (/volno/i.test(workoutStatus)) bits.push('dnes volno');
  }
  if (Array.isArray(food.items)) bits.push(`${food.items.length} zapsaných jídel`);
  return bits.join(' · ');
}

// The numbers come from the client, already computed. The model's job is to
// write the sentence around them — never to produce a figure of its own.
function fmtPeriodStats(st) {
  if (!st || typeof st !== 'object') return '';
  const l = [];
  if (st.from && st.to) l.push(`Období: ${st.from} až ${st.to} (${st.days || '?'} dní)`);
  if (st.workouts) l.push(`Tréninky: odcvičeno ${st.workouts.done} z ${st.workouts.planned} naplánovaných`);
  if (st.avgKcal != null) {
    l.push(`Kalorie: průměr ${st.avgKcal} kcal/den při cíli ${st.goalKcal || '?'} (zapsáno ${st.loggedDays} z ${st.days} dní)`);
  }
  if (st.avgProtein != null) l.push(`Bílkoviny: průměr ${st.avgProtein} g/den při cíli ${st.goalProtein || '?'} g`);
  if (st.weight && Number.isFinite(Number(st.weight.delta))) {
    const dir = st.weight.delta > 0 ? '+' : '';
    l.push(`Váha: ${st.weight.from} → ${st.weight.to} kg (${dir}${st.weight.delta})`);
  }
  const lifts = (Array.isArray(st.lifts) ? st.lifts : [])
    .filter((x) => x && x.name && Number.isFinite(Number(x.delta)));
  if (lifts.length) {
    l.push('Cviky, které se hnuly:');
    lifts.forEach((x) => {
      const dir = x.delta > 0 ? `+${x.delta}` : String(x.delta);
      l.push(`  • ${x.name}: ${x.from} → ${x.to} kg (${dir} kg, ${x.sessions || '?'} tréninků)`);
    });
  }
  return l.join('\n');
}

function fmtSummaries(list) {
  const ok = (Array.isArray(list) ? list : []).filter((s) => s && s.text);
  if (!ok.length) return null;
  return ok.map((s) => `[${s.from || '?'} → ${s.to || '?'}] ${s.text}`).join('\n');
}

function summaryPrompt(ctx) {
  return `Jsi AI kouč a píšeš si POZNÁMKU PRO SEBE — shrnutí posledního týdne uživatele.
Tuhle poznámku uvidíš i za půl roku, až už tenhle týden nebude v historii chatu.
Uživatel ji nečte, takže nemusíš být milý ani motivační. Buď věcný.

=== ČÍSLA ZA TENHLE TÝDEN (spočítala appka, jsou pravdivá) ===
${fmtPeriodStats(ctx.periodStats)}

=== O ČEM JSTE SI PSALI ===
${ctx.coachLog}

=== CO UŽ VÍŠ Z DŘÍVĚJŠKA ===
${ctx.memBlock}

NAPIŠ:
- 2 až 4 věty, max 400 znaků, česky
- co se za ten týden reálně stalo: tréninky, váhy, jídlo, váha
- co ho trápilo nebo co říkal, že mu nejde — tohle je nejcennější, čísla si dopočítám
- jestli něco drží, nebo se naopak rozjíždí
- POUŽÍVEJ JEN ČÍSLA VÝŠ. Ani jedno další si nevymýšlej
- žádné rady do budoucna, tohle je zápis toho, co bylo
- žádné oslovení, žádný pozdrav, prostě poznámka

Když se za ten týden nestalo nic, co by stálo za zapamatování, odpověz PŘESNĚ: [nic]`;
}

function fmtCoachLog(log, recentN) {
  if (!Array.isArray(log) || !log.length) return 'Zatím jste spolu nemluvili.';
  const slice = log.slice(-recentN);
  let lastDay = '';
  const lines = [];
  slice.forEach((m) => {
    if (!m || !m.text) return;
    // A junk timestamp used to throw straight out of toISOString and take the
    // whole request with it.
    const ts = Number(m.ts);
    const d = new Date(Number.isFinite(ts) && ts > 0 ? ts : Date.now());
    const day = (isNaN(d) ? new Date() : d).toISOString().slice(0, 10);
    if (day !== lastDay) { lines.push(`--- ${day} ---`); lastDay = day; }
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const who = m.role === 'user' ? 'ON' : 'TY';
    lines.push(`[${hhmm} ${m.where || 'chat'}] ${who}: ${String(m.text).slice(0, 220)}`);
  });
  return lines.join('\n') || 'Zatím jste spolu nemluvili.';
}

function searchCoachLog(log, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q || !Array.isArray(log)) return [];
  const words = q.split(/\s+/).filter((w) => w.length > 2);
  const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const nq = norm(q);
  const nwords = words.map(norm);
  return log
    .filter((m) => {
      const t = norm(m && m.text);
      return t.includes(nq) || (nwords.length > 0 && nwords.every((w) => t.includes(w)));
    })
    .slice(-25)
    .map((m) => {
      const d = new Date(m.ts || Date.now());
      return `${d.toISOString().slice(0, 10)} [${m.where || 'chat'}] ${m.role === 'user' ? 'ON' : 'TY'}: ${String(m.text).slice(0, 300)}`;
    });
}

const HISTORY_TOOL = {
  name: 'search_history',
  description: 'Prohledá VŠECHNY vaše starší konverzace (hlavní chat, chaty u jídel i u tréninků), i ty, které nevidíš v kontextu. Volej, když si nejsi jistý, jestli jste něco už řešili, když se uživatel odvolává na dřívějšek („jak jsem ti říkal", „minule jsme se bavili"), nebo než mu poradíš něco, co už jednou odmítl.',
  parameters: {
    type: 'OBJECT',
    properties: {
      query: { type: 'STRING', description: 'Klíčová slova, např. "jednoručky váhy" nebo "koleno bolest"' }
    },
    required: ['query']
  }
};

const MEMORY_TOOL = {
  name: 'remember_fact',
  description: 'Ulož si natrvalo fakt o uživateli nebo jeho posilovně, který má platit i příště. Volej VŽDY, když ti uživatel řekne nějaké omezení nebo trvalou informaci: jaké má k dispozici váhy a stroje, co ho bolí, co nejí, co nesnáší za cviky. Neukládej nálady ani jednorázové věci ("dnes jsem unavený").',
  parameters: {
    type: 'OBJECT',
    properties: {
      fact: { type: 'STRING', description: 'Krátká věta v češtině, např. "V posilovně má jednoručky jen po 10 a 15 kg."' }
    },
    required: ['fact']
  }
};

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

// Web lookup. Runs through groundedSearch(), which is a separate Gemini call
// with Google Search grounding — see that function for why it can't share a
// request with the function-calling tools.
const SEARCH_TOOL = {
  name: 'search_web',
  description: `Vyhledá na internetu aktuální informace. Máš k dispozici jen pár hledání na zprávu, tak ho použij, jen když ti data fakt chybí.

POUŽIJ VŽDY, než postavíš nebo upravíš mini appku o konkrétním REÁLNÉM místě — restaurace, podnik, hotel, obchod. Bez hledání bys jejich nabídku vymyslel a uživatel by dostal smyšlená čísla jako fakt.
Ptej se konkrétně, např. „Pizza Komín Zlín jídelní lístek ceny" nebo „McDonald's ČR nutriční hodnoty".
Nehledej obecné výživové věci, které víš sám (kolik má kuřecí prso bílkovin).`,
  parameters: {
    type: 'OBJECT',
    properties: {
      query: { type: 'STRING', description: 'Vyhledávací dotaz, klidně česky' }
    },
    required: ['query']
  }
};

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

KDYŽ CVIČIT NECHCE — TOHLE MUSÍŠ ZVLÁDNOUT:
Spousta lidí chce jen hlídat jídlo a hubnout přes stravu. Je to úplně legitimní.
Když řekne cokoliv jako „nechci cvičit", „na to nemám čas", „jen jídlo", „necvičím":
- ulož trainingDaysPerWeek: 0 a UŽ SE NA TRÉNINK NEPTEJ
- PŘESKOČ otázky 6 a 7 (vybavení a zkušenost) — nemá je k čemu odpovídat
- NEPŘEMLOUVEJ ho a nedávej nevyžádané kázání, že by cvičit měl
- set_workout_plan pak volej se VŠEMI dny rest:true (žádné cviky), nebo ho nevolej vůbec
- kalorie se spočítají úplně stejně, jen s nižším výdejem — compute_targets to řeší samo
- v závěrečné zprávě mu řekni, že hubnutí přes jídlo funguje taky a že trénink si může
  kdykoliv později zapnout, když bude chtít. Jednou větou, ne přednáška

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

// Live-workout mode. The coach is next to the user mid-set, so the bar for
// saying anything at all is high — silence is a valid answer.
function workoutPrompt(ctx) {
  const s = ctx.session || {};
  const ex = s.currentExercise;
  return `Jsi AI kouč a JSI PŘÍMO U TRÉNINKU s uživatelem. Sleduješ ho v reálném čase, vidíš každou sérii, kterou zapíše.

${STYLE}

JAK SE CHOVAT U TRÉNINKU:
- Piš JEŠTĚ KRATČEJI než jindy. Uživatel má telefon v ruce mezi sériemi, ne čas na čtení
- Ideál je jedna věta. Dvě jsou maximum
- Buď parťák u činky: povzbuď, upozorni na techniku, navrhni váhu na další sérii
- Když ti položí otázku, odpověz na ni věcně a stručně
- Nediktuj mu, co má dělat, u každé série. Otravný spotter je horší než žádný
- NEKONČI ZPRÁVU OTÁZKOU, pokud ji fakt nepotřebuješ zodpovědět. „co ty na to?" po každé radě
  je přesně to, proč lidi spottery nesnáší. Řekni svoje a nech ho cvičit
- Zrcadli délku. Napíše „ok" → neodpovídej vůbec, nebo jedním slovem
- Znáš jeho historii vah. Používej konkrétní čísla („minule 60×8, dneska 62,5 — sedí to"),
  ne obecné povzbuzování

CO TI UŽIVATEL ŘEKNE, TO PLATÍ — TOHLE JE NEJDŮLEŽITĚJŠÍ PRAVIDLO:
- Když ti řekne, jaké má k dispozici váhy nebo vybavení ("jsou tu jen desítky a patnáctky"),
  je to TVRDÉ OMEZENÍ. Nikdy mu pak nenavrhni váhu, která tam není. Ani "pro zajímavost",
  ani o dvě zprávy později
- Takové omezení si OKAMŽITĚ ulož přes remember_fact, ať ho víš i příští trénink
- Když ti řekne, že něco nedá nebo nechce, NEOPAKUJ to samé znovu jinými slovy.
  Přijmi to a pracuj s tím, co má. "Sorry" a hned nato stejný návrh je to nejhorší, co můžeš udělat
- Když ti odmítne návrh dvakrát, přestaň navrhovat váhy úplně. Zeptej se, co chce dělat,
  nebo mu prostě zapiš, co udělal
- Než navrhneš jakoukoliv váhu, projdi si PAMĚŤ a CO DNES ŘEKL níž. Když tam je omezení, drž se ho
- Neptej se u každé zprávy "co ty na to?". Uživatel stojí u činky, ne v konverzaci
- Když komentuje, jak mu to jde ("ups", "to bylo těžký", "nedal jsem to"), NEPTEJ SE "co se stalo".
  Máš před sebou každou jeho sérii — řekni mu, co v těch číslech vidíš
- Cvičení si může upravit i sám: klepnutím na název cviku, přes "Cviky & pořadí", nebo klepnutím na zapsanou sérii
- MŮŽE TI POSLAT FOTKU přímo z posilovny. Typicky štítek na stroji nebo kotouče (přečti váhu a řekni, kolik to je), neznámý stroj (řekni, co to je a jak se na tom cvičí), nastavení sedačky, nebo sám sebe při cviku (mrkni na techniku). Popiš jen to, co na fotce fakt vidíš — když je rozmazaná nebo z ní váhu nepřečteš, řekni to a nehádej. Pořád platí stručnost: dvě věty
${ctx.canEditSession ? `
=== MŮŽEŠ TRÉNINK MĚNIT SÁM ===
Máš nástroje, kterými do probíhajícího tréninku přímo saháš. Cviky adresuješ přes ID v hranatých závorkách níže.
- Chce vyměnit cvik ("dej mi místo benche jednoručky") → edit_exercise s novým name
- Chce jinou váhu/opakování/pauzu/míň sérií → edit_exercise
- Chce něco přidat nebo vyhodit → add_exercise / remove_exercise
- Chce prohodit pořadí nebo přeskočit na jiný cvik → move_exercise / goto_exercise
- Nadiktuje ti sérii, kterou UŽ UDĚLAL ("dal jsem 60 na osm") → log_session_set
- Přepsal se → edit_logged_set, zapsal omylem → delete_logged_set
- "dej mi delší pauzu" / "už jdu" → set_rest_timer

log_session_set NEVOLEJ, když se teprve domlouváte na váze pro DALŠÍ sérii — "zkusím zůstat
na 25", "jasně, tak 25 na 6" je dohoda o plánu, ne hlášení odvedené práce. I když to zní jako
potvrzení, sérii ještě neudělal. Zapíše se to sám, jakmile ji reálně odcvičí a naťuká,
nebo ti to sám nahlásí v minulém čase. Zapsat sérii dřív, než ji uživatel udělal, je horší
chyba než nezapsat vůbec nic — vytvoří to falešný záznam v jeho historii vah.

ŽELEZNÉ PRAVIDLO: co řekneš, to udělej NÁSTROJEM. Nikdy nenapiš "změnil jsem ti to",
"vyměnil jsem", "dal jsem ti tam" bez toho, že jsi zavolal nástroj — uživatel má telefon
v ruce a hned vidí, že se nic nestalo. Buď to zavolej, nebo řekni, že to neumíš.
Po zavolání nástroje odpověz jednou krátkou větou, co je teď jinak. Nevypisuj celý trénink.
` : ''}
${ctx.proactive ? `TEĎHLE ZPRÁVU POSÍLÁŠ SÁM OD SEBE, uživatel se tě na nic neptal.
Ozvi se JEN když máš fakt co říct — posun na osobák, znatelný propad výkonu, moc krátká pauza, poslední cvik.
Když není nic zajímavého, odpověz PŘESNĚ takhle a nic víc: [nic]
Radši mlč, než abys plácal. Nevyžádaná zpráva bez obsahu je horší než ticho —
[nic] je naprosto v pořádku a většinou správná odpověď.
A hlavně: sám od sebe se NIKDY neptej. Když nemáš co říct, mlčíš, ne že vymyslíš otázku.` : ''}

=== TRÉNINK PRÁVĚ TEĎ ===
Trénink: ${s.title || '—'}
Uběhlo: ${s.elapsed || '0:00'}
Postup: ${s.progress || '—'}
${s.resting ? 'Uživatel má právě pauzu mezi sériemi.' : 'Uživatel právě cvičí (nemá pauzu).'}
${ex ? `
AKTUÁLNÍ CVIK: ${ex.name}
Cíl: ${ex.target}, pauza ${ex.restSec}s
Série dnes: ${ex.setsDone && ex.setsDone.length ? ex.setsDone.join(', ') : 'zatím žádná'}
Minule: ${ex.lastTime || 'poprvé'}` : ''}
${s.remaining && s.remaining.length ? `Zbývá pak: ${s.remaining.join(', ')}` : 'Tohle je poslední cvik.'}
${ctx.sessionExercises ? `
=== CVIKY V TRÉNINKU (ID pro nástroje) ===
${ctx.sessionExercises}` : ''}

=== HISTORIE VAH ===
${fmtExerciseHistory(ctx.exerciseHistory)}

=== PROFIL ===
${fmtProfile(ctx.profile)}

=== PAMĚŤ (trvalá fakta, PLATÍ VŽDY) ===
${ctx.memBlock}

${ctx.summaries ? `=== JAK TO ŠLO PŘEDTÍM (tvoje týdenní poznámky) ===
${ctx.summaries}

` : ''}=== O ČEM JSTE UŽ MLUVILI (hlavní chat, jídla i tréninky) ===
${ctx.coachLog}
Tohle je společná historie všech vašich chatů. Když se odvolá na dřívějšek,
najdi si to tu. Když to tu není, zavolej search_history — sahá i dál do minulosti.
${ctx.saidToday ? `
=== CO TI UŽIVATEL DNES NAPSAL (doslova, od začátku tréninku) ===
Tohle je závazné. Když je tu omezení, drž se ho — i kdyby padlo před půl hodinou.
${ctx.saidToday}` : ''}

Dnes je ${ctx.todayDate}, čas ${ctx.nowTime || 'neznámý'}.`;
}

function coachPrompt(ctx) {
  return `Jsi AI kouč v appce FitAI. Píšeš jako kámoš z gen z, ne jako oficiální asistent. Máš přístup ke VŠEM datům uživatele v aplikaci.

${STYLE}
${ctx.todayLine ? `
>>> DNEŠEK, JAK HO VIDÍŠ TY: ${ctx.todayLine}
Tohle má uživatel právě teď na obrazovce. Ty to vidíš taky. Pracuj s tím.
` : ''}
KDYŽ KOMENTUJE SVŮJ DEN, NEPTEJ SE „CO SE STALO":
Když napíše něco jako „ups", „sorry", „dneska to nedopadlo", „přejedl jsem se",
„za dnešek", „mám toho dost", „cheat day" — NEODPOVÍDEJ otázkou. Odpověď máš nad sebou.
Řekni mu rovnou, jak dnešek vypadá v číslech, a co s tím. Ptát se „co se stalo",
když ti čísla koukají do očí, je to nejhorší, co můžeš udělat.
Špatně: „čau, co se stalo"
Dobře: „vidím, 2263 z 1880 ||| o 383 nahoře, ale trénink máš 5/5 — na recompu to není žádná tragédie"

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
- NIKDY se neptej uživatele na čísla, která máš: „kolik ti zbývá kcal, to už víš, že jo?" je přesně to, co dělat nesmíš

POSLOUCHEJ USERA — NEJDŮLEŽITĚJŠÍ:
- Vždycky reaguj na to, co user fakt napsal. Když se zeptá, odpověz na TO
- NEopakuj pořád dokola to samý (bílkoviny, cíle, váhu), když se ho to netýká
- Když tě POUZE pozdraví („čau", „ahoj", „yo") a nic víc, pozdrav zpátky a zeptej se co je — žádná přednáška. Tohle platí JEN na holý pozdrav, ne na cokoliv, co už něco říká o jeho dni
- Když si jen kecá, kecej zpátky. Seš kámoš, ne motivační plakát

CO TĚ DĚLÁ OTRAVNÝM — TOHLE NEDĚLEJ:
- NEKONČI KAŽDOU ZPRÁVU OTÁZKOU. Tohle je nejotravnější věc, kterou umíš.
  Většina odpovědí má prostě skončit. Otázku dej, jen když ji fakt potřebuješ zodpovědět,
  ne abys „udržel konverzaci". Tři zprávy po sobě zakončené otázkou = děláš to špatně
- ZRCADLI DÉLKU. Napíše dvě slova → odpovíš jednou větou. Nikdo nechce tři bubliny na „ok"
- NERAĎ, CO UŽ JSI PORADIL. Máš nad sebou historii všech vašich chatů. Když jsi mu tohle
  říkal minulý týden a on to neudělal, neopakuj to potřetí. Buď to řekni jinak, nebo mlč
- NECHVAL DO PRÁZDNA. „skvělá práce", „jen tak dál", „makáš" bez konkrétního důvodu
  je motivační plakát. Když chválíš, tak za konkrétní číslo
- NEVYSVĚTLUJ, NA CO SE NEPTAL. Nikoho nezajímá, proč je bílkovina důležitá, když se ptal,
  jestli si má dát rohlík
- NEOPAKUJ, CO UMÍŠ. Nikdy nepiš „můžu ti upravit plán, chceš?" — prostě to udělej, až o to řekne
- KDYŽ SI STĚŽUJE, NEOPRAVUJ HO HNED. Někdy chce jen říct, že ho to sere. Nech ho.
  Rada se hodí, až o ni řekne, nebo když je fakt potřeba

BUĎ OSOBNÍ — ZNÁŠ HO:
- Mluvíš s ním dlouhodobě, ne poprvé. Máš nad sebou PAMĚŤ a historii všech chatů — používej ji.
  Odkaž se na to, co říkal dřív, tak jak by to udělal kámoš: „ty ráno nesnídáš skoro nikdy",
  „minule jsi říkal, že tě sere bench"
- Konkrétní data místo obecných frází. Ne „drž se plánu", ale „na benchi jsi za měsíc přidal 7,5 kg"
- Když si všimneš něčeho zajímavého sám od sebe (osobák, série tréninků, propad), řekni to —
  ale MAXIMÁLNĚ JEDNU takovou věc za konverzaci. Ne u každé zprávy
- Když ti řekne něco osobního (škola, stres, zranění, že se na to vykašlal), zapamatuj si to
  přes remember_fact a příště se k tomu vrať — jednou, normálně, ne jako terapeut
- Když ti řekne, jak se jmenuje, ulož si to. Oslovovat jménem je fajn, ale ne v každé zprávě

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
${ctx.calorieMode ? `
>>> BĚŽÍ DOČASNÝ REŽIM: „${ctx.calorieMode.label}" do ${ctx.calorieMode.until}${ctx.calorieMode.reason ? ` (${ctx.calorieMode.reason})` : ''}
Cíle výš jsou dočasně zvednuté kvůli tomuhle. Po ${ctx.calorieMode.until} se samy vrátí na
${ctx.calorieMode.baseTargets ? ctx.calorieMode.baseTargets.calories + ' kcal' : 'původní hodnoty'} — appka to udělá sama, ty s tím nic dělat nemusíš.
Neřeš s uživatelem, že „je přes cíl", když je v tomhle režimu a drží se nových čísel — o to jde.
Když řekne, že je zpátky / skončilo to dřív, zavolej clear_calorie_mode.
` : `
Když uživatel řekne, že jede na dovolenou, blíží se svátky, je nemocný nebo cestuje,
NABÍDNI mu dočasné zvednutí kalorií přes set_calorie_mode — samo se to po pár dnech
vrátí zpátky, takže si tím nerozbije dlouhodobý cíl. Nevnucuj to, ale zmiň to.
`}
=== TRÉNINKOVÝ PLÁN ===
${fmtWorkoutPlan(ctx.workoutPlan, ctx.todayKey)}

=== JÍDELNÍČEK ===
${fmtMealPlan(ctx.mealPlan, ctx.todayKey)}
${ctx.lockedMeals.length ? `\nZAMČENÁ JÍDLA (uživatel si je uzamkl — NIKDY je neměň ani nepřegeneruj): ${ctx.lockedMeals.join(', ')}` : ''}

=== DNEŠNÍ PROGRESS (co fakt snědl) + PŘEDCHOZÍ DNY ===
${fmtFood(ctx.foodContext)}

Když se odvolá na dřívější jídlo („to samé co včera", „jako minule"), vezmi množství
i makra PŘESNĚ z PŘEDCHOZÍCH DNŮ výš. Nikdy si je nevymýšlej — když to tam není,
řekni to a zeptej se.

=== DNEŠNÍ TRÉNINK ===
${ctx.workoutStatus}

=== HISTORIE VAH (progressive overload) ===
${fmtExerciseHistory(ctx.exerciseHistory)}

Když se uživatel ptá na progres, opírej se o čísla výš — konkrétně, ne obecně.
Když je cvik označený [STAGNUJE], sám navrhni deload (−10 % váhy na týden) nebo výměnu cviku.
Když má na posledním tréninku splněný horní rozsah opakování, navrhni přidat 2,5 kg (u velkých cviků 5 kg).
Když ti nahlásí odcvičenou sérii („dal jsem bench 3x8 na 42,5"), zavolej log_set.


=== MINI APPKY, KTERÉ JSI MU UDĚLAL ===
${fmtMiniApps(ctx.miniApps)}

Umíš uživateli postavit malou appku na míru situaci, kterou plán neřeší — večeře v konkrétní restauraci, výlet, oslava, vaření dopředu, nákup. Nástroj create_mini_app.
- Když popíše takovou situaci, NABÍDNI mu to („mám ti na to udělat appku?") — a to je JEDINÁ otázka, kterou k appce položíš
- Jakmile jakkoliv souhlasí („jo", „udělej", „vytvoř to"), OKAMŽITĚ zavolej create_mini_app. Žádné další doptávání, žádné „je to takhle lepší?", žádné potvrzování obsahu
- NIKDY nevypisuj obsah appky do chatu. Od toho je ta appka. Když v chatu vyjmenuješ jídla a appku nezaložíš, uživatel čeká na něco, co neexistuje
- Makra a kalorie si doplň SÁM z dat, co máš. Neptej se „chceš k tomu kalorie?" ani „kolik ti zbývá kcal?" — to všechno víš
- Jde-li o KONKRÉTNÍ REÁLNÉ MÍSTO (restaurace, podnik, hotel), NEJDŘÍV zavolej search_web a nabídku si dohledej. Bez toho bys ji vymyslel a uživatel by dostal smyšlená čísla jako fakt. Totéž platí, když appku upravuješ
- Když se hledání nepovede nebo nic nenajdeš, appku klidně postav, ale uživateli MUSÍŠ říct, že jsou hodnoty jen odhad
- Nejdřív si zjisti, co potřebuješ vědět (jaká restaurace, kam jede) — na tohle se ptát MUSÍŠ, neuhádneš to
- U jídel vždy vyplň makra, ať si je může jedním ťuknutím zapsat
- Buď konkrétní: u restaurace vypiš skutečná jídla z její nabídky, ne obecné kategorie
- Zohledni, kolik mu dnes zbývá do cíle — u doporučené volby dej recommended:true
- Když chce něco jiného, uprav existující appku přes update_mini_app, nedělej duplikát

VLASTNÍ HTML V APPCE (blok type:"html"):
Když ti hotové bloky na něco nestačí — srovnávací tabulka, časová osa, netypické rozvržení — napiš si vlastní HTML. Píšeš POUZE značky a CSS: <script> ani onclick se zahodí, protože se to vykresluje v izolovaném rámci.
Design systém, který je uvnitř k dispozici (drž se ho, ať to ladí se zbytkem appky):
- třídy: card (i card hi pro zvýrazněnou), row (row between), col, grid (grid g3), title, name, muted, big, pill (pill dim), bar s vnitřním <i> pro postup, btn (btn primary)
- barvy ber z proměnných: var(--text-1), var(--text-2), var(--text-3), var(--bg-card), var(--sep), var(--red)
- nikdy nepiš barvy natvrdo a nepoužívej vlastní fonty
Zapsat jídlo do deníku jde tlačítkem s atributy:
<button class="btn primary" data-log-name="Pizza Diavola" data-log-amount="420g" data-log-calories="880" data-log-protein="42" data-log-carbs="98" data-log-fat="34">Zapsat do deníku</button>
Když stačí obyčejný seznam voleb, použij radši blok "options" — je na to dělaný.

=== VŠECHNA OSTATNÍ DATA Z APPKY ===
${fmtAppSnapshot(ctx.appSnapshot)}

${ctx.summaries ? `=== JAK TO ŠLO PŘEDTÍM (tvoje vlastní týdenní poznámky) ===
${ctx.summaries}
Tyhle poznámky sis psal sám vždycky po týdnu. Sahají dál než historie chatu —
díky nim víš, jak se to celé vyvíjelo, ne jen posledních pár dní.
Když mluví o delším období („zlepšuju se?", „jak mi to jde"), opři se o ně.

` : ''}=== O ČEM JSTE UŽ MLUVILI (hlavní chat, jídla i tréninky) ===
${ctx.coachLog}
Tohle je společná historie napříč VŠEMI chaty — i těmi u jídel a u tréninků.
Když se odvolá na dřívějšek („jak jsem ti říkal", „minule"), koukni sem.
Když to tu nenajdeš, zavolej search_history, ta sahá dál do minulosti.
Nikdy si nevymýšlej, že si na něco vzpomínáš — buď to tu je, nebo se zeptej.

=== PAMĚŤ (trvalá fakta, PLATÍ VŽDY) ===
${ctx.memBlock}
Když ti uživatel řekne trvalé omezení nebo fakt o sobě — jaké má doma či v posilovně
vybavení a váhy, co ho bolí, co nejí, na co má alergii, co nesnáší za cviky — ulož si
to přes remember_fact. Pak už mu nikdy nenavrhuj něco, co podle paměti nemůže.
Neukládej nálady ani jednorázovky ("dneska jsem unavený").

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

// Google Search grounding. Runs as its OWN request with no functionDeclarations:
// mixing search with function calling is not reliably supported across Gemini
// versions, and a separate call is guaranteed to work. Returns the answer text
// plus the sources, so the coach can build a mini app from real data instead of
// inventing a restaurant menu from training data.
const SEARCH_MODELS = [...new Set([COACH_MODEL, 'gemini-flash-latest'])];

async function groundedSearch(query, deadline) {
  const payload = {
    contents: [{ role: 'user', parts: [{ text: query }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 2048 }
  };

  for (const model of SEARCH_MODELS) {
    const remaining = deadline - Date.now();
    if (remaining < 6000) break;

    const gData = await callGemini(model, payload, Math.min(20000, remaining));
    if (!gData) continue;

    const cand = gData.candidates && gData.candidates[0];
    const parts = (cand && cand.content && Array.isArray(cand.content.parts)) ? cand.content.parts : [];
    const text = parts.map((p) => (p && p.text) ? p.text : '').join('').trim();
    if (!text) {
      console.error(`Search ${model}: empty, finishReason=${cand && cand.finishReason}`);
      continue;
    }

    const chunks = (cand.groundingMetadata && cand.groundingMetadata.groundingChunks) || [];
    const sources = chunks
      .map((c) => c && c.web ? { title: String(c.web.title || '').slice(0, 80), uri: String(c.web.uri || '').slice(0, 400) } : null)
      .filter((x) => x && x.uri)
      .slice(0, 6);

    return { ok: true, text: text.slice(0, 4000), sources, model };
  }
  return null;
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

  const username = await extractUsername(req.headers.authorization);
  if (!username) return res.status(401).json({ error: 'Nepřihlášen' });
  if (!COACH_API_KEY) {
    return res.status(500).json({ error: 'AI Kouč není nakonfigurován (chybí COACH_API_KEY / GEMINI_API_KEY).' });
  }

  try {
    const {
      message, history, mode, image,
      profile, targets, calorieMode, workoutPlan, mealPlan, lockedMeals, exerciseHistory, exerciseLogs,
      appSnapshot, focus, miniApps, session, sessionState, proactive, sessionHistory, coachLog,
      coachSummaries, periodStats,
      foodContext, workoutStatus, memories, today, nowTime
    } = req.body || {};

    if ((!message || !message.trim()) && !image) {
      return res.status(400).json({ error: 'Prázdná zpráva' });
    }

    const isOnboarding = mode === 'onboarding';
    const isWorkout = mode === 'workout';
    const isSummary = mode === 'summary';
    const todayDate = (today && /^\d{4}-\d{2}-\d{2}$/.test(today)) ? today : null;
    const todayKey = dayKeyForDate(todayDate);

    // Plan state the tools operate on. Starts from whatever the client has.
    const state = Object.assign(emptyPlanState(), {
      profile: profile || {},
      targets: targets || null,
      calorieMode: calorieMode || null,
      workoutPlan: workoutPlan || null,
      mealPlan: mealPlan || null,
      exerciseLogs: (exerciseLogs && typeof exerciseLogs === 'object') ? exerciseLogs : {}
    });

    // Mini apps live alongside the plan state and are mutated by their own tools.
    const apps = Array.isArray(miniApps) ? miniApps.slice(0, 20) : [];

    // Working copy of the live workout. Tools mutate this only so the model can
    // be told what its call did — the client replays sessionActions instead.
    const sess = isWorkout ? normSessionState(sessionState) : null;
    const sessionActions = [];
    const newMemories = [];

    const memBlock = (Array.isArray(memories) && memories.length)
      ? memories.map((m) => `- ${String(m).trim()}`).join('\n')
      : 'Žádná uložená fakta.';

    const ctx = {
      profile: state.profile, targets: state.targets, calorieMode: state.calorieMode,
      workoutPlan: state.workoutPlan, mealPlan: state.mealPlan,
      foodContext, memBlock, todayDate: todayDate || 'dnes', todayKey,
      nowTime: (typeof nowTime === 'string' && /^\d{1,2}:\d{2}$/.test(nowTime)) ? nowTime : null,
      workoutStatus: workoutStatus || 'Dnešní trénink zatím nezačal.',
      lockedMeals: Array.isArray(lockedMeals) ? lockedMeals : [],
      exerciseHistory: Array.isArray(exerciseHistory) ? exerciseHistory : [],
      appSnapshot: (appSnapshot && typeof appSnapshot === 'object') ? appSnapshot : null,
      focus: (focus && typeof focus === 'object') ? focus : null,
      miniApps: apps,
      session: (session && typeof session === 'object') ? session : null,
      coachLog: fmtCoachLog(coachLog, isSummary ? 120 : 45),
      summaries: fmtSummaries(coachSummaries),
      periodStats: periodStats || null,
      todayLine: fmtTodayLine(foodContext, workoutStatus),
      sessionExercises: (sess && sess.exercises.length) ? fmtSessionExercises(sess) : null,
      // Every word the user has said this workout, in full. The rolling history
      // window kept dropping constraints stated a few minutes earlier, and the
      // coach then cheerfully suggested the dumbbell that isn't in the gym.
      saidToday: (Array.isArray(history) ? history : [])
        .filter((m) => m && m.role === 'user' && m.text && !/^\(trénink běží/.test(m.text))
        .slice(-40)
        .map((m) => `- „${String(m.text).slice(0, 300)}"`)
        .join('\n') || null,
      canEditSession: !!(sess && sess.exercises.length && proactive !== true),
      proactive: proactive === true,
      sessionHistory: Array.isArray(sessionHistory) ? sessionHistory.slice(0, 5) : []
    };

    const systemInstruction = isSummary
      ? summaryPrompt(ctx)
      : isOnboarding
      ? onboardingPrompt(ctx)
      : (isWorkout ? workoutPrompt(ctx) : coachPrompt(ctx));

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
    // During a workout the coach can restructure the session — but only when
    // the user actually asked. A proactive nudge fires on its own schedule, and
    // a spotter that silently deletes an exercise mid-set is not a feature.
    const activeTools = isSummary
      ? []
      : isWorkout
      ? (ctx.canEditSession ? SESSION_TOOLS.concat([MEMORY_TOOL, HISTORY_TOOL]) : [])
      : isOnboarding
      ? TOOL_DECLARATIONS
      : TOOL_DECLARATIONS.concat(FOOD_TOOLS).concat(MINIAPP_TOOLS)
          .concat([SEARCH_TOOL, MEMORY_TOOL, HISTORY_TOOL]);

    const basePayload = {
      systemInstruction: { parts: [{ text: systemInstruction }] },
      ...(activeTools.length ? { tools: [{ functionDeclarations: activeTools }] } : {}),
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
    let appsChanged = false;
    let lastAppId = null;
    // Grounded search is billed per call and costs a round trip, so it is
    // capped. Sources collected here get attached to any app built afterwards,
    // which is what lets the UI say "ověřeno" instead of quietly guessing.
    let searchCount = 0;
    let searchSources = [];
    const MAX_SEARCHES = 3;

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

      // Web searches need awaiting, so they run before the synchronous tools.
      for (const fc of calls) {
        if (fc.name !== 'search_web') continue;
        let result;
        if (searchCount >= MAX_SEARCHES) {
          result = { ok: false, error: 'Vyčerpal jsi limit hledání pro tuhle zprávu. Postav appku z toho, co už víš, a uveď, že jsou to odhady.' };
        } else {
          searchCount++;
          const query = String((fc.args && fc.args.query) || '').slice(0, 300);
          console.log(`search_web: ${query}`);
          const found = await groundedSearch(query, deadline);
          if (found) {
            searchSources = searchSources.concat(found.sources);
            result = {
              ok: true,
              query,
              info: found.text,
              sources: found.sources.map((x) => x.title || x.uri),
              note: 'Tohle jsou reálná data z internetu. Postav appku z NICH, ne z paměti.'
            };
          } else {
            result = { ok: false, error: 'Hledání se nepovedlo. Když appku přesto postavíš, MUSÍŠ uživateli říct, že jsou hodnoty jen odhad.' };
          }
        }
        console.log(`tool search_web -> ${result.ok ? 'ok' : 'FAIL'}`);
        responseParts.push({ functionResponse: { name: fc.name, response: { result } } });
      }

      calls.filter((fc) => fc.name !== 'search_web').forEach((fc) => {
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
        } else if (fc.name === 'search_history') {
          const hits = searchCoachLog(coachLog, fc.args && fc.args.query);
          result = hits.length
            ? { ok: true, nalezeno: hits.length, zaznamy: hits }
            : { ok: true, nalezeno: 0, note: 'Nic takového jste spolu neřešili. Neříkej, že si vzpomínáš — zeptej se.' };
        } else if (fc.name === 'remember_fact') {
          const fact = String((fc.args && fc.args.fact) || '').trim().slice(0, 200);
          const known = (Array.isArray(memories) ? memories : []).map((m) => String(m).toLowerCase());
          if (!fact) {
            result = { ok: false, error: 'Prázdný fakt.' };
          } else if (known.includes(fact.toLowerCase()) || newMemories.some((m) => m.toLowerCase() === fact.toLowerCase())) {
            result = { ok: true, note: 'Tohle už si pamatuješ, znovu to ukládat nemusíš.' };
          } else if (newMemories.length >= 3) {
            result = { ok: false, error: 'Najednou si ukládej nanejvýš tři věci.' };
          } else {
            newMemories.push(fact);
            result = { ok: true, note: 'Uloženo do paměti natrvalo. Uživateli to zmiň jednou větou.' };
          }
        } else if (SESSION_TOOL_NAMES.has(fc.name)) {
          if (!sess) {
            result = { ok: false, error: 'Žádný trénink teď neběží.' };
          } else {
            try {
              result = applySessionTool(fc.name, fc.args, sess, sessionActions);
            } catch (e) {
              console.error(`Session tool ${fc.name} threw:`, e.message);
              result = { ok: false, error: 'Nástroj selhal: ' + e.message };
            }
          }
        } else if (MINIAPP_TOOL_NAMES.has(fc.name)) {
          try {
            result = applyMiniAppTool(fc.name, fc.args, apps);
          } catch (e) {
            console.error(`Mini app tool ${fc.name} threw:`, e.message);
            result = { ok: false, error: 'Nástroj selhal: ' + e.message };
          }
          if (result && result.ok) {
            appsChanged = true;
            lastAppId = result.id;
            const built = apps.find((x) => x.id === result.id);
            if (built) {
              built.sources = searchSources.slice(0, 4);
              built.estimated = searchSources.length === 0;
            }
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

    // Saying "dělám ti appku" and then listing its contents as chat text is the
    // same failure as claiming an edit that never happened — the user waits for
    // something that does not exist. Unlike the edit check this one applies
    // everywhere, not just inside a meal chat.
    const CLAIMS_AN_APP = /(vytvářím|vytvořím|tvořím|dělám ti (tu )?appku|udělám ti (tu )?appku|udělal jsem ti appku|připravuju appku|chystám appku|appka bude|appku máš|appka je hotová)/i;

    let correction = null;
    if (reply && !appsChanged && CLAIMS_AN_APP.test(reply)) {
      correction = {
        kind: 'app',
        note: 'SYSTÉM: Právě jsi napsal, že appku děláš nebo že bude něco obsahovat, ale NEZAVOLAL jsi create_mini_app, takže žádná appka neexistuje a uživatel čeká na něco, co nemá. Zavolej create_mini_app TEĎ. Obsah nevypisuj do chatu — od toho je ta appka. Makra si doplň sám z dat, která máš, a na nic se už neptej.',
        fallback: 'appku se mi nepovedlo postavit ||| zkus mi napsat znovu, co v ní chceš'
      };
    } else if (isWorkout && ctx.canEditSession && reply && !sessionActions.length && !newMemories.length && CLAIMS_A_CHANGE.test(reply)) {
      correction = {
        kind: 'session',
        note: 'SYSTÉM: Právě jsi napsal, že jsi v tréninku něco změnil, ale NEZAVOLAL jsi žádný nástroj, takže se nezměnilo vůbec nic a uživatel má na displeji pořád to původní. Zavolej TEĎ správný nástroj (edit_exercise na výměnu cviku nebo změnu sérií/opakování/pauzy, add_exercise, remove_exercise, move_exercise, goto_exercise, log_session_set, edit_logged_set, delete_logged_set, set_rest_timer). Když to udělat neumíš, řekni to na rovinu. Nikdy netvrď, že je něco hotové, když to hotové není.',
        fallback: 'tohle se mi nepovedlo změnit ||| zkus to říct jinak, nebo si to přepiš přes ✎ u cviku'
      };
    } else if (ctx.focus && reply && !planChanged && !foodAction && !appsChanged && CLAIMS_A_CHANGE.test(reply)) {
      correction = {
        kind: 'change',
        note: 'SYSTÉM: Právě jsi napsal, že jsi něco upravil, ale NEZAVOLAL jsi žádný nástroj, takže se v aplikaci NIC nezměnilo a uživatel vidí pořád původní hodnoty. Buď teď ZAVOLEJ správný nástroj (scale_meal na změnu kalorií, adjust_meal_items na změnu gramáže, replace_meal na výměnu jídla), nebo uživateli na rovinu napiš, že to udělat neumíš. Nikdy netvrď, že je něco hotové, když to hotové není.',
        fallback: 'tohle se mi nepovedlo změnit ||| zkus to říct jinak, třeba „dej to na 450 kcal"'
      };
    }

    if (correction) {
      console.log(`Model claimed a ${correction.kind} without calling a tool — forcing a correction round`);
      contents.push({ role: 'model', parts: [{ text: reply }] });
      contents.push({ role: 'user', parts: [{ text: correction.note }] });
      reply = null;
      await runToolLoop();

      // Still nothing applied? Then whatever it wants to say, nothing happened
      // — so never let a "done!" through. An honest failure beats a confident
      // lie the user only discovers by looking for the result.
      const didSomething = correction.kind === 'app'
        ? appsChanged
        : correction.kind === 'session'
        ? sessionActions.length > 0
        : (planChanged || foodAction || appsChanged);

      if (!didSomething) {
        if (reply) console.log(`Suppressed false claim: ${reply.slice(0, 120)}`);
        reply = correction.fallback;
      } else if (!reply) {
        reply = correction.kind === 'app'
          ? 'hotovo, appka je dole'
          : correction.kind === 'session' ? 'jo, hotovo' : 'jo, teď už je to fakt upravený';
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
      if (sessionActions.length) {
        reply = 'hotovo';
      } else if (appliedTools.length) {
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
      sessionActions: sessionActions.length ? sessionActions : undefined,
      newMemories: newMemories.length ? newMemories : undefined,
      profile: state.profile,
      targets: state.targets,
      calorieMode: state.calorieMode !== undefined ? state.calorieMode : undefined,
      exerciseLogs: state.exerciseLogs,
      miniApps: appsChanged ? apps : undefined,
      newMiniAppId: lastAppId || undefined,
      workoutPlan: state.workoutPlan,
      mealPlan: state.mealPlan,
    });
  } catch (error) {
    console.error('Coach error:', error);
    return res.status(500).json({ error: 'Chyba serveru: ' + error.message });
  }
};
