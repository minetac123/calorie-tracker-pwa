// Coach food-operations layer: everything that copies, moves, splits, merges
// or deletes items in `state.logs`, plus the favorites shelf in
// `state.favorites`.
//
// Deliberately independent of plans.js: that file owns the *plan* (targets,
// workout split, meal plan), this one owns what the user actually ate. Nothing
// is imported across the two, so both can change without breaking each other.
//
// Everything here is synchronous and mutates `state` in place; the returned
// object is fed straight back to the model, so `note` / `error` are Czech and
// carry concrete numbers.

// Canonical category keys as stored in the app (app.js renders by these).
const CATEGORIES = ['Breakfast', 'Morning snack', 'Lunch', 'Afternoon snack', 'Dinner', 'Second dinner'];

const CATEGORY_CZ = {
  'Breakfast': 'Snídaně',
  'Morning snack': 'Dopolední svačina',
  'Lunch': 'Oběd',
  'Afternoon snack': 'Odpolední svačina',
  'Dinner': 'Večeře',
  'Second dinner': 'Druhá večeře'
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Small helpers (kept local — this module imports nothing from plans.js)
// ---------------------------------------------------------------------------

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

// Calories are whole numbers, macros one decimal — same rounding the app uses,
// so a coach edit never makes a row look different from a hand-made one.
function r0(v) { return Math.round(num(v)); }
function r1(v) { return Math.round(num(v) * 10) / 10; }

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Lowercase, strip diacritics, squash punctuation — used for every fuzzy match
// (category names, food names, favorite names) so "Odpolední svačina",
// "odpoledni svacina" and "ODPOLEDNI  SVACINA" are one thing.
function normText(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// The model writes categories in Czech, the app stores English keys. Both
// directions have to work, plus the usual sloppy variants.
const CATEGORY_ALIASES = (() => {
  const m = {};
  const put = (cat, names) => names.forEach((n) => { m[normText(n)] = cat; });
  put('Breakfast', ['Breakfast', 'snídaně', 'snidane', 'snidani', 'ranní jídlo', 'rano', 'ráno']);
  put('Morning snack', ['Morning snack', 'dopolední svačina', 'dopoledni svacina', 'dopolední svačinka', 'dopoledne', 'první svačina', 'prvni svacina']);
  put('Lunch', ['Lunch', 'oběd', 'obed', 'obid']);
  put('Afternoon snack', ['Afternoon snack', 'odpolední svačina', 'odpoledni svacina', 'odpoledni svacinka', 'odpoledne', 'svačina', 'svacina', 'snack', 'druhá svačina', 'druha svacina']);
  put('Dinner', ['Dinner', 'večeře', 'vecere', 'vecere hlavni']);
  put('Second dinner', ['Second dinner', 'druhá večeře', 'druha vecere', 'pozdní večeře', 'pozdni vecere', 'noční jídlo', 'nocni jidlo']);
  return m;
})();

function normCategory(v) {
  const k = normText(v);
  if (!k) return null;
  return CATEGORY_ALIASES[k] || null;
}

function czCat(cat) {
  return CATEGORY_CZ[cat] || cat;
}

// Noon UTC survives any timezone shift, so day arithmetic never slips a day.
function shiftDate(date, delta) {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

const RELATIVE_DATES = {
  'dnes': 0, 'today': 0, 'dneska': 0,
  'zitra': 1, 'zejtra': 1, 'tomorrow': 1,
  'pozitri': 2,
  'vcera': -1, 'yesterday': -1, 'vcerejsek': -1,
  'predevcirem': -2
};

// Accepts YYYY-MM-DD or a handful of Czech relative words, always resolved
// against state.today (never against the server clock — it runs in UTC).
function normDate(v, state) {
  const raw = String(v == null ? '' : v).trim();
  if (DATE_RE.test(raw)) {
    // Reject impossible dates like 2026-02-31 that still match the shape.
    const d = new Date(raw + 'T12:00:00Z');
    return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw ? null : raw;
  }
  const today = state && DATE_RE.test(String(state.today)) ? state.today : null;
  if (!raw || !today) return null;
  const k = normText(raw);
  return k in RELATIVE_DATES ? shiftDate(today, RELATIVE_DATES[k]) : null;
}

function todayOf(state) {
  return state && DATE_RE.test(String(state.today)) ? state.today : new Date().toISOString().slice(0, 10);
}

function normTime(v) {
  const m = String(v == null ? '' : v).trim().match(/^(\d{1,2})\s*[:.h]?\s*(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

// Same thresholds as getFoodCategory() in app.js — if these drift apart, an
// item moved by the coach lands in a different row than the app would put it.
function categoryForTime(time) {
  const t = normTime(time);
  if (!t) return 'Breakfast';
  const h = Number(t.slice(0, 2));
  if (h >= 5 && h < 10) return 'Breakfast';
  if (h >= 10 && h < 11) return 'Morning snack';
  if (h >= 11 && h < 15) return 'Lunch';
  if (h >= 15 && h < 18) return 'Afternoon snack';
  if (h >= 18 && h < 22) return 'Dinner';
  return 'Second dinner';
}

// A representative clock time for a category, used when something is logged
// without one (favorites carry no time of their own).
const CATEGORY_TIME = {
  'Breakfast': '08:00',
  'Morning snack': '10:30',
  'Lunch': '12:30',
  'Afternoon snack': '16:00',
  'Dinner': '19:00',
  'Second dinner': '22:00'
};

function parseAmount(str) {
  const s = String(str || '');
  // A value in parentheses ("2 plátky (40g)") is the real weight.
  const paren = s.match(/\((\d+(?:[.,]\d+)?)\s*(g|ml|kg|l)\)/i);
  const m = paren || s.match(/(\d+(?:[.,]\d+)?)\s*(g|ml|kg|l)\b/i);
  if (!m) return null;
  return { value: parseFloat(m[1].replace(',', '.')), unit: m[2].toLowerCase() };
}

function scaleAmount(amount, factor) {
  const a = parseAmount(amount);
  if (!a || !a.value) return amount;
  const v = Math.round(a.value * factor * 10) / 10;
  return `${v}${a.unit}`;
}

function ensureLogs(state) {
  if (!state.logs || typeof state.logs !== 'object') state.logs = {};
  return state.logs;
}

function dayItems(state, date) {
  const logs = ensureLogs(state);
  return Array.isArray(logs[date]) ? logs[date] : [];
}

function ensureDay(state, date) {
  const logs = ensureLogs(state);
  if (!Array.isArray(logs[date])) logs[date] = [];
  return logs[date];
}

// Empty days are dropped so the day strip in the app does not show a date with
// zero items (the app does the same on manual delete).
function pruneDay(state, date) {
  const logs = ensureLogs(state);
  if (Array.isArray(logs[date]) && logs[date].length === 0) delete logs[date];
}

function sortDay(list) {
  list.sort((x, y) => {
    const c = CATEGORIES.indexOf(itemCategory(x)) - CATEGORIES.indexOf(itemCategory(y));
    if (c !== 0) return c;
    return String(x.time || '').localeCompare(String(y.time || ''));
  });
  return list;
}

function itemCategory(item) {
  return normCategory(item && item.category) || categoryForTime(item && item.time);
}

// Shapes anything (model input, a clone, a favorite) into a stored food item.
function shapeItem(src, over) {
  const i = Object.assign({}, src || {}, over || {});
  const time = normTime(i.time) || '12:00';
  return {
    id: i.id || genId(),
    time,
    name: String(i.name || 'Jídlo').slice(0, 80),
    amount: String(i.amount || '100g').slice(0, 30),
    calories: r0(i.calories),
    protein: r1(i.protein),
    carbs: r1(i.carbs),
    fat: r1(i.fat),
    category: normCategory(i.category) || categoryForTime(time)
  };
}

function sumItems(list) {
  return (list || []).reduce((s, i) => ({
    calories: s.calories + num(i.calories),
    protein: s.protein + num(i.protein),
    carbs: s.carbs + num(i.carbs),
    fat: s.fat + num(i.fat)
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
}

function totals(list) {
  const t = sumItems(list);
  return { calories: r0(t.calories), protein: r1(t.protein), carbs: r1(t.carbs), fat: r1(t.fat) };
}

// An id lookup MUST scan every logged day: the model happily passes an id it
// saw in yesterday's context while the user is looking at today.
function findFood(state, id) {
  const wanted = String(id == null ? '' : id).trim();
  if (!wanted) return null;
  const logs = ensureLogs(state);
  const dates = Object.keys(logs);
  for (let d = 0; d < dates.length; d++) {
    const list = logs[dates[d]];
    if (!Array.isArray(list)) continue;
    const idx = list.findIndex((i) => i && String(i.id) === wanted);
    if (idx !== -1) return { date: dates[d], list, idx, item: list[idx] };
  }
  return null;
}

function describeItem(i) {
  return `${i.name} ${i.amount} (${r0(i.calories)} kcal, ${r1(i.protein)} g B)`;
}

function ensureFavorites(state) {
  if (!Array.isArray(state.favorites)) state.favorites = [];
  return state.favorites;
}

// Exact normalized name first, substring second — the model rarely repeats a
// favorite's name character for character.
function matchFavorites(state, name) {
  const favs = ensureFavorites(state);
  const q = normText(name);
  if (!q) return [];
  const exact = favs.filter((f) => normText(f && f.name) === q);
  if (exact.length) return exact;
  return favs.filter((f) => normText(f && f.name).includes(q));
}

// Known foods = favorites (curated) + everything logged in the last 90 days,
// deduped by name. Used only by the read-only suggestion tools.
function knownFoods(state) {
  const out = new Map();
  ensureFavorites(state).forEach((f) => {
    if (!f || !f.name) return;
    const key = normText(f.name);
    if (!key) return;
    out.set(key, {
      name: String(f.name), amount: String(f.amount || '100g'),
      calories: r0(f.calories), protein: r1(f.protein), carbs: r1(f.carbs), fat: r1(f.fat),
      source: 'oblíbené', count: 0, lastDate: null
    });
  });

  const logs = ensureLogs(state);
  Object.keys(logs).sort().forEach((date) => {
    (Array.isArray(logs[date]) ? logs[date] : []).forEach((i) => {
      if (!i || !i.name) return;
      const key = normText(i.name);
      if (!key) return;
      const prev = out.get(key);
      if (prev) {
        prev.count += 1;
        prev.lastDate = date;
        return;
      }
      out.set(key, {
        name: String(i.name), amount: String(i.amount || '100g'),
        calories: r0(i.calories), protein: r1(i.protein), carbs: r1(i.carbs), fat: r1(i.fat),
        source: 'historie', count: 1, lastDate: date
      });
    });
  });

  return Array.from(out.values()).filter((f) => f.calories > 0 || f.protein > 0);
}

// ---------------------------------------------------------------------------
// Gemini tool declarations
// ---------------------------------------------------------------------------

const CATEGORY_PARAM = {
  type: 'STRING',
  description: 'Kategorie jídla. Můžeš psát česky (snídaně, dopolední svačina, oběd, odpolední svačina, večeře, druhá večeře) i anglickým klíčem (Breakfast, Morning snack, Lunch, Afternoon snack, Dinner, Second dinner).'
};

const DATE_PARAM = {
  type: 'STRING',
  description: 'Datum ve formátu YYYY-MM-DD. Bere i "dnes", "včera", "zítra".'
};

const FOODOPS_TOOLS = [
  {
    name: 'copy_food_day',
    description: 'Zkopíruje CELÝ zapsaný den jídla na jiný den (např. "dej mi dneska to samý co včera"). Cílový den se PŘEPÍŠE — co v něm bylo, zmizí; kolik toho bylo, se vrátí v odpovědi, tak to uživateli řekni. Zdrojový den zůstává. Pro jedno konkrétní jídlo použij repeat_meal, pro prohození dvou jídel swap_meal_between_days.',
    parameters: {
      type: 'OBJECT',
      properties: { fromDate: DATE_PARAM, toDate: DATE_PARAM },
      required: ['fromDate', 'toDate']
    }
  },
  {
    name: 'repeat_meal',
    description: 'Zkopíruje jedno jídlo (jednu kategorii) z jiného dne a PŘIDÁ ho do cílového dne. Na rozdíl od copy_food_day nemaže, co v cílovém dni už je, a řeší jen jednu kategorii.',
    parameters: {
      type: 'OBJECT',
      properties: { fromDate: DATE_PARAM, category: CATEGORY_PARAM, toDate: DATE_PARAM },
      required: ['fromDate', 'category', 'toDate']
    }
  },
  {
    name: 'swap_meal_between_days',
    description: 'Prohodí dvě jídla mezi dny — jídlo z dateA/categoryA se PŘESUNE na dateB/categoryB a naopak. Nic se nekopíruje, obě jídla si vymění místo. Když chceš jen zkopírovat, použij repeat_meal.',
    parameters: {
      type: 'OBJECT',
      properties: { dateA: DATE_PARAM, categoryA: CATEGORY_PARAM, dateB: DATE_PARAM, categoryB: CATEGORY_PARAM },
      required: ['dateA', 'categoryA', 'dateB', 'categoryB']
    }
  },
  {
    name: 'split_food',
    description: 'Rozdělí jednu zapsanou položku na N stejných porcí (makra i gramáž se podělí). Použij, když uživatel řekne, že snědl jen část, nebo že se to jídlo jedlo nadvakrát. Pro jinou než rovnoměrnou změnu použij scale_food.',
    parameters: {
      type: 'OBJECT',
      properties: {
        id: { type: 'STRING', description: 'id zapsané položky' },
        parts: { type: 'INTEGER', description: 'Na kolik stejných porcí rozdělit (2-10)' }
      },
      required: ['id', 'parts']
    }
  },
  {
    name: 'merge_foods',
    description: 'Sloučí několik zapsaných položek ze STEJNÉHO dne do jedné (makra i gramáž se sečtou), např. tři suroviny jednoho jídla pod jeden název. Původní položky zmizí.',
    parameters: {
      type: 'OBJECT',
      properties: {
        ids: { type: 'ARRAY', items: { type: 'STRING' }, description: 'id položek ke sloučení (aspoň dvě, ze stejného dne)' },
        newName: { type: 'STRING', description: 'Název výsledné položky' }
      },
      required: ['ids', 'newName']
    }
  },
  {
    name: 'move_food_to_category',
    description: 'Přesune zapsanou položku do jiné kategorie ve stejný den (např. ze snídaně do oběda). Datum ani makra se nemění. Na přesun na jiný den je move_food_to_day.',
    parameters: {
      type: 'OBJECT',
      properties: { id: { type: 'STRING' }, category: CATEGORY_PARAM },
      required: ['id', 'category']
    }
  },
  {
    name: 'move_food_to_day',
    description: 'Přesune zapsanou položku na jiný den (kategorie i makra zůstávají). Používej, když uživatel zapsal jídlo ke špatnému dni. Kopii dělá duplicate_food, ne tohle.',
    parameters: {
      type: 'OBJECT',
      properties: { id: { type: 'STRING' }, date: DATE_PARAM },
      required: ['id', 'date']
    }
  },
  {
    name: 'duplicate_food',
    description: 'Zdvojí zapsanou položku ve stejný den (např. "dal jsem si to dvakrát"). Kopie dostane nové id, originál zůstává.',
    parameters: {
      type: 'OBJECT',
      properties: { id: { type: 'STRING' } },
      required: ['id']
    }
  },
  {
    name: 'set_food_time',
    description: 'Změní čas zapsané položky (HH:MM). Kategorie se dopočítá podle nového času, pokud odpovídala původnímu času; když si ji uživatel nastavil ručně (neodpovídá času), zůstane.',
    parameters: {
      type: 'OBJECT',
      properties: {
        id: { type: 'STRING' },
        time: { type: 'STRING', description: 'Nový čas ve formátu HH:MM, např. "07:30"' }
      },
      required: ['id', 'time']
    }
  },
  {
    name: 'scale_food',
    description: 'Přenásobí makra i gramáž jedné zapsané položky (1.5 = jedenapůlkrát tolik, 0.5 = půlka). Použij při opravě odhadu porce. Na rozdělení na stejné porce je split_food.',
    parameters: {
      type: 'OBJECT',
      properties: {
        id: { type: 'STRING' },
        factor: { type: 'NUMBER', description: 'Násobek 0.1 až 10, jiný než 1' }
      },
      required: ['id', 'factor']
    }
  },
  {
    name: 'save_favorite',
    description: 'Uloží potravinu mezi oblíbené, aby ji šlo příště zapsat jedním klepnutím. Když už oblíbená se stejným názvem existuje, přepíše se (vrátí se to v odpovědi, řekni to uživateli). Nezapisuje nic do deníku — na to je log_favorite.',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING', description: 'Název potraviny' },
        amount: { type: 'STRING', description: 'Množství, ke kterému platí makra, např. "100g"' },
        calories: { type: 'NUMBER' },
        protein: { type: 'NUMBER' },
        carbs: { type: 'NUMBER' },
        fat: { type: 'NUMBER' }
      },
      required: ['name', 'calories', 'protein', 'carbs', 'fat']
    }
  },
  {
    name: 'log_favorite',
    description: 'Zapíše oblíbenou potravinu do deníku. Název stačí částečný; když sedí víc oblíbených, nic se nezapíše a vrátí se seznam, ze kterého si nech vybrat.',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING', description: 'Název oblíbené potraviny (stačí část)' },
        date: DATE_PARAM,
        category: CATEGORY_PARAM,
        portions: { type: 'NUMBER', description: 'Kolik porcí (výchozí 1, rozsah 0.1-10)' }
      },
      required: ['name']
    }
  },
  {
    name: 'delete_favorite',
    description: 'Smaže potravinu z oblíbených. Zapsaná jídla v deníku se nemažou. Při víc shodách se nesmaže nic a vrátí se seznam.',
    parameters: {
      type: 'OBJECT',
      properties: { name: { type: 'STRING', description: 'Název oblíbené potraviny (stačí část)' } },
      required: ['name']
    }
  },
  {
    name: 'list_favorites',
    description: 'Vypíše uložené oblíbené potraviny i s makry. Jen čte, nic nemění. Volej, než začneš hádat, co uživatel běžně jí.',
    parameters: { type: 'OBJECT', properties: {} }
  },
  {
    name: 'suggest_meal_for_remaining',
    description: 'Spočítá, kolik kalorií a bílkovin dni zbývá do cíle, a NAVRHNE z oblíbených a z historie jídel, co se do toho vejde. Nic nezapisuje — návrh musí potvrdit uživatel, teprve pak zapisuj (log_favorite nebo nástroj na zápis jídla).',
    parameters: {
      type: 'OBJECT',
      properties: { date: DATE_PARAM },
      required: []
    }
  },
  {
    name: 'find_protein_source',
    description: 'Najde konkrétní potraviny z oblíbených a z historie, kterými se dá dohnat chybějící gramáž bílkovin, i s cenou v kaloriích. Jen čte, nic nezapisuje. Na celkový přehled zbytku dne je suggest_meal_for_remaining.',
    parameters: {
      type: 'OBJECT',
      properties: { gramsNeeded: { type: 'NUMBER', description: 'Kolik gramů bílkovin je potřeba dohnat (1-300)' } },
      required: ['gramsNeeded']
    }
  },
  {
    name: 'reset_day',
    description: 'DESTRUKTIVNÍ: smaže všechna zapsaná jídla daného dne. Volej jen tehdy, když si to uživatel jasně vyžádal ("smaž celý dnešek", "zapsal jsem to špatně, začnu znovu"). V odpovědi je přesně, co se smazalo — vypiš mu to.',
    parameters: {
      type: 'OBJECT',
      properties: { date: DATE_PARAM },
      required: ['date']
    }
  }
];

const FOODOPS_TOOL_NAMES = new Set(FOODOPS_TOOLS.map((t) => t.name));

// ---------------------------------------------------------------------------
// Tool application
// ---------------------------------------------------------------------------

// Applies one food tool call. Mutates `state.logs` / `state.favorites` and
// returns the object fed back to the model.
function applyFoodOpsTool(name, args, state) {
  const a = args || {};
  if (!state || typeof state !== 'object') return { ok: false, error: 'Chybí stav aplikace.' };
  ensureLogs(state);
  ensureFavorites(state);

  switch (name) {
    // A copy, not a move: the source day survives. Items are cloned with fresh
    // ids — two rows sharing an id would make editing or deleting one silently
    // hit the other.
    case 'copy_food_day': {
      const from = normDate(a.fromDate, state);
      const to = normDate(a.toDate, state);
      if (!from) return { ok: false, error: `Neplatné zdrojové datum: ${a.fromDate}. Použij formát YYYY-MM-DD.` };
      if (!to) return { ok: false, error: `Neplatné cílové datum: ${a.toDate}. Použij formát YYYY-MM-DD.` };
      if (from === to) return { ok: false, error: 'Zdrojový a cílový den jsou stejné, kopírovat není co.' };

      const src = dayItems(state, from);
      if (!src.length) return { ok: false, error: `V den ${from} není zapsané žádné jídlo, není co kopírovat.` };

      const old = dayItems(state, to).slice();
      const oldT = totals(old);
      const copied = src.map((i) => shapeItem(i, { id: genId() }));
      state.logs[to] = sortDay(copied);
      const newT = totals(copied);

      const overwritten = old.length
        ? `Přepsal jsem ${old.length} položek (${oldT.calories} kcal), které v ${to} byly. `
        : `V ${to} předtím nic zapsané nebylo. `;

      return {
        ok: true,
        from, to,
        copiedCount: copied.length,
        overwrittenCount: old.length,
        overwrittenCalories: oldT.calories,
        totals: newT,
        items: copied.map(describeItem),
        note: `${overwritten}Zkopíroval jsem ${copied.length} položek z ${from} do ${to} — ${newT.calories} kcal, ${newT.protein} g bílkovin. Den ${from} zůstal beze změny.`
      };
    }

    case 'repeat_meal': {
      const from = normDate(a.fromDate, state);
      const to = normDate(a.toDate, state);
      const cat = normCategory(a.category);
      if (!from || !to) return { ok: false, error: 'Neplatné datum, použij formát YYYY-MM-DD.' };
      if (!cat) return { ok: false, error: `Neznámá kategorie: ${a.category}. Použij snídaně, dopolední svačina, oběd, odpolední svačina, večeře nebo druhá večeře.` };
      if (from === to) return { ok: false, error: 'Zdrojový a cílový den jsou stejné — na zdvojení jídla v jednom dni je duplicate_food.' };

      const src = dayItems(state, from).filter((i) => itemCategory(i) === cat);
      if (!src.length) return { ok: false, error: `V den ${from} není v kategorii ${czCat(cat)} nic zapsaného.` };

      const copies = src.map((i) => shapeItem(i, { id: genId(), category: cat }));
      const target = ensureDay(state, to);
      copies.forEach((c) => target.push(c));
      sortDay(target);

      const t = totals(copies);
      return {
        ok: true,
        from, to, category: cat,
        copiedCount: copies.length,
        totals: t,
        items: copies.map(describeItem),
        note: `${czCat(cat)} z ${from} (${copies.length} položek, ${t.calories} kcal, ${t.protein} g B) jsem přidal do ${to}. Ostatní jídla v ${to} zůstala.`
      };
    }

    // Move, not copy: ids stay the same, only the day and category change.
    case 'swap_meal_between_days': {
      const dA = normDate(a.dateA, state);
      const dB = normDate(a.dateB, state);
      const cA = normCategory(a.categoryA);
      const cB = normCategory(a.categoryB);
      if (!dA || !dB) return { ok: false, error: 'Neplatné datum, použij formát YYYY-MM-DD.' };
      if (!cA || !cB) return { ok: false, error: 'Neznámá kategorie. Použij snídaně, dopolední svačina, oběd, odpolední svačina, večeře nebo druhá večeře.' };
      if (dA === dB && cA === cB) return { ok: false, error: 'Obě jídla jsou to samé — prohazovat není co.' };

      const listA = dayItems(state, dA);
      const listB = dayItems(state, dB);
      const takeA = listA.filter((i) => itemCategory(i) === cA);
      const takeB = listB.filter((i) => itemCategory(i) === cB);
      if (!takeA.length && !takeB.length) {
        return { ok: false, error: `Ani ${czCat(cA)} v ${dA}, ani ${czCat(cB)} v ${dB} nic neobsahuje — není co prohodit.` };
      }

      const restA = listA.filter((i) => itemCategory(i) !== cA);
      const restB = listB.filter((i) => itemCategory(i) !== cB);
      const movedToB = takeA.map((i) => shapeItem(i, { category: cB }));
      const movedToA = takeB.map((i) => shapeItem(i, { category: cA }));

      state.logs[dA] = sortDay(restA.concat(movedToA));
      state.logs[dB] = sortDay(restB.concat(movedToB));
      pruneDay(state, dA);
      pruneDay(state, dB);

      const tA = totals(takeA);
      const tB = totals(takeB);
      return {
        ok: true,
        swapped: `${dA} ${czCat(cA)} ↔ ${dB} ${czCat(cB)}`,
        movedFromA: takeA.length,
        movedFromB: takeB.length,
        note: `Prohodil jsem ${czCat(cA)} z ${dA} (${takeA.length} položek, ${tA.calories} kcal) s ${czCat(cB)} z ${dB} (${takeB.length} položek, ${tB.calories} kcal).`
      };
    }

    case 'split_food': {
      const found = findFood(state, a.id);
      if (!found) return { ok: false, error: `Položku s id ${a.id} jsem v žádném dni nenašel — nic jsem nerozdělil.` };
      const parts = Math.round(num(a.parts, 0));
      if (parts < 2 || parts > 10) return { ok: false, error: 'Počet porcí musí být mezi 2 a 10.' };

      const src = found.item;
      const f = 1 / parts;
      const pieces = [];
      for (let n = 0; n < parts; n++) {
        pieces.push(shapeItem(src, {
          id: n === 0 ? src.id : genId(), // keep the first id so references survive
          name: `${String(src.name || 'Jídlo').slice(0, 60)} (${n + 1}/${parts})`,
          amount: scaleAmount(src.amount, f),
          calories: num(src.calories) * f,
          protein: num(src.protein) * f,
          carbs: num(src.carbs) * f,
          fat: num(src.fat) * f
        }));
      }
      // Rounding each part down can lose a few kcal; the remainder goes to the
      // first piece so the day total does not silently drop.
      const diff = r0(src.calories) - pieces.reduce((s, p) => s + p.calories, 0);
      if (diff !== 0) pieces[0].calories = Math.max(0, pieces[0].calories + diff);

      found.list.splice(found.idx, 1, ...pieces);
      sortDay(found.list);
      return {
        ok: true,
        date: found.date,
        parts,
        items: pieces.map(describeItem),
        note: `"${src.name}" (${r0(src.calories)} kcal) jsem v ${found.date} rozdělil na ${parts} porcí po ${pieces[parts - 1].calories} kcal a ${pieces[parts - 1].protein} g bílkovin.`
      };
    }

    case 'merge_foods': {
      const ids = Array.isArray(a.ids) ? a.ids.map((x) => String(x)) : [];
      if (ids.length < 2) return { ok: false, error: 'Ke sloučení potřebuju aspoň dvě id.' };
      const newName = String(a.newName || '').trim();
      if (!newName) return { ok: false, error: 'Chybí název výsledné položky (newName).' };

      const found = [];
      const missing = [];
      ids.forEach((id) => {
        const f = findFood(state, id);
        if (f) found.push(f); else missing.push(id);
      });
      if (missing.length) return { ok: false, error: `Tyhle položky jsem nenašel: ${missing.join(', ')}. Nic jsem neslučoval.` };

      const dates = Array.from(new Set(found.map((f) => f.date)));
      if (dates.length > 1) return { ok: false, error: `Položky jsou z různých dnů (${dates.join(', ')}). Slučovat jde jen jídlo z jednoho dne — nejdřív je přesuň přes move_food_to_day.` };

      const uniq = new Map();
      found.forEach((f) => uniq.set(String(f.item.id), f.item));
      const items = Array.from(uniq.values());
      if (items.length < 2) return { ok: false, error: 'Zadal jsi dvakrát tutéž položku — slučovat není co.' };

      const date = dates[0];
      const list = state.logs[date];
      const t = sumItems(items);
      const first = items[0];

      // Sum the weights only when every part uses the same unit — mixing g and
      // ml into one number would be a made-up amount.
      const parsed = items.map((i) => parseAmount(i.amount));
      const unit = parsed[0] && parsed[0].unit;
      const sameUnit = parsed.every((p) => p && p.unit === unit);
      const amount = sameUnit ? `${Math.round(parsed.reduce((s, p) => s + p.value, 0) * 10) / 10}${unit}` : '';

      const time = items.map((i) => normTime(i.time)).filter(Boolean).sort()[0] || first.time;
      const merged = shapeItem({
        id: genId(),
        time,
        name: newName,
        amount: amount || `${items.length} položky`,
        calories: t.calories, protein: t.protein, carbs: t.carbs, fat: t.fat,
        category: itemCategory(first)
      });

      const keep = list.filter((i) => !uniq.has(String(i.id)));
      keep.push(merged);
      state.logs[date] = sortDay(keep);

      return {
        ok: true,
        date,
        mergedCount: items.length,
        merged: describeItem(merged),
        note: `Sloučil jsem ${items.length} položek (${items.map((i) => i.name).join(', ')}) v ${date} do "${merged.name}" — ${merged.amount}, ${merged.calories} kcal, ${merged.protein} g B, ${merged.carbs} g S, ${merged.fat} g T.`
      };
    }

    case 'move_food_to_category': {
      const found = findFood(state, a.id);
      if (!found) return { ok: false, error: `Položku s id ${a.id} jsem v žádném dni nenašel — nic jsem nepřesouval.` };
      const cat = normCategory(a.category);
      if (!cat) return { ok: false, error: `Neznámá kategorie: ${a.category}. Použij snídaně, dopolední svačina, oběd, odpolední svačina, večeře nebo druhá večeře.` };
      const oldCat = itemCategory(found.item);
      if (oldCat === cat) return { ok: false, error: `"${found.item.name}" už v kategorii ${czCat(cat)} je, neměnil jsem nic.` };

      found.item.category = cat;
      sortDay(found.list);
      return {
        ok: true,
        date: found.date,
        from: oldCat, to: cat,
        item: describeItem(found.item),
        note: `"${found.item.name}" (${r0(found.item.calories)} kcal) jsem v ${found.date} přesunul z ${czCat(oldCat)} do ${czCat(cat)}.`
      };
    }

    case 'move_food_to_day': {
      const found = findFood(state, a.id);
      if (!found) return { ok: false, error: `Položku s id ${a.id} jsem v žádném dni nenašel — nic jsem nepřesouval.` };
      const to = normDate(a.date, state);
      if (!to) return { ok: false, error: `Neplatné datum: ${a.date}. Použij formát YYYY-MM-DD.` };
      if (to === found.date) return { ok: false, error: `"${found.item.name}" už v ${to} je, neměnil jsem nic.` };

      const item = found.item;
      found.list.splice(found.idx, 1);
      const fromDate = found.date;
      pruneDay(state, fromDate);
      const target = ensureDay(state, to);
      target.push(item);
      sortDay(target);

      return {
        ok: true,
        from: fromDate, to,
        item: describeItem(item),
        note: `"${item.name}" (${r0(item.calories)} kcal, ${czCat(itemCategory(item))}) jsem přesunul z ${fromDate} na ${to}.`
      };
    }

    case 'duplicate_food': {
      const found = findFood(state, a.id);
      if (!found) return { ok: false, error: `Položku s id ${a.id} jsem v žádném dni nenašel — nic jsem nezdvojoval.` };
      const copy = shapeItem(found.item, { id: genId() });
      found.list.push(copy);
      sortDay(found.list);
      const t = totals(dayItems(state, found.date));
      return {
        ok: true,
        date: found.date,
        newId: copy.id,
        item: describeItem(copy),
        dayTotals: t,
        note: `"${copy.name}" (${copy.calories} kcal) jsem v ${found.date} zapsal ještě jednou. Den je teď na ${t.calories} kcal a ${t.protein} g bílkovin.`
      };
    }

    // The category follows the clock only when it already matched the old time.
    // If it did not, the user picked it by hand and moving it would undo that.
    case 'set_food_time': {
      const found = findFood(state, a.id);
      if (!found) return { ok: false, error: `Položku s id ${a.id} jsem v žádném dni nenašel — čas jsem neměnil.` };
      const time = normTime(a.time);
      if (!time) return { ok: false, error: `Neplatný čas: ${a.time}. Použij formát HH:MM, např. "07:30".` };

      const item = found.item;
      const oldTime = item.time;
      const oldCat = itemCategory(item);
      const wasAuto = !item.category || oldCat === categoryForTime(oldTime);
      item.time = time;
      let catNote = `Kategorii ${czCat(oldCat)} jsem nechal — nastavil sis ji ručně.`;
      if (wasAuto) {
        const newCat = categoryForTime(time);
        item.category = newCat;
        catNote = newCat === oldCat
          ? `Kategorie zůstává ${czCat(newCat)}.`
          : `Kategorii jsem podle času přepnul z ${czCat(oldCat)} na ${czCat(newCat)}.`;
      }
      sortDay(found.list);

      return {
        ok: true,
        date: found.date,
        from: oldTime, to: time,
        category: itemCategory(item),
        categoryFollowedTime: wasAuto,
        note: `"${item.name}" v ${found.date} má nově čas ${time} (bylo ${oldTime}). ${catNote}`
      };
    }

    case 'scale_food': {
      const found = findFood(state, a.id);
      if (!found) return { ok: false, error: `Položku s id ${a.id} jsem v žádném dni nenašel — makra jsem neměnil.` };
      const factor = num(a.factor, 0);
      if (!(factor > 0)) return { ok: false, error: 'Násobek musí být kladné číslo (např. 1.5 nebo 0.5).' };
      if (factor < 0.1 || factor > 10) return { ok: false, error: 'Násobek musí být mezi 0.1 a 10.' };
      if (factor === 1) return { ok: false, error: 'Násobek 1 nic nezmění.' };

      const item = found.item;
      const before = { calories: r0(item.calories), protein: r1(item.protein), amount: item.amount };
      item.amount = scaleAmount(item.amount, factor);
      item.calories = r0(num(item.calories) * factor);
      item.protein = r1(num(item.protein) * factor);
      item.carbs = r1(num(item.carbs) * factor);
      item.fat = r1(num(item.fat) * factor);

      const t = totals(dayItems(state, found.date));
      return {
        ok: true,
        date: found.date,
        factor,
        before, after: { calories: item.calories, protein: item.protein, amount: item.amount },
        dayTotals: t,
        note: `"${item.name}" jsem v ${found.date} přenásobil ${factor}× — z ${before.calories} kcal na ${item.calories} kcal a z ${before.protein} na ${item.protein} g bílkovin. Den je teď na ${t.calories} kcal.`
      };
    }

    case 'save_favorite': {
      const nm = String(a.name || '').trim().slice(0, 80);
      if (!nm) return { ok: false, error: 'Chybí název potraviny.' };
      const calories = r0(a.calories);
      const protein = r1(a.protein);
      const carbs = r1(a.carbs);
      const fat = r1(a.fat);
      if (calories <= 0 && protein <= 0 && carbs <= 0 && fat <= 0) {
        return { ok: false, error: 'Oblíbená potravina musí mít aspoň nějaká makra — doplň kalorie a bílkoviny.' };
      }
      if (calories > 5000) return { ok: false, error: 'Kalorie nad 5000 na porci nedávají smysl, zkontroluj číslo.' };

      const favs = ensureFavorites(state);
      const fav = {
        name: nm,
        amount: String(a.amount || '100g').slice(0, 30),
        calories, protein, carbs, fat
      };
      const idx = favs.findIndex((f) => normText(f && f.name) === normText(nm));
      const replaced = idx !== -1 ? favs[idx] : null;
      if (idx !== -1) favs[idx] = fav;
      else favs.push(fav);
      if (favs.length > 200) favs.length = 200;

      return {
        ok: true,
        favorite: fav,
        replaced: !!replaced,
        count: favs.length,
        note: replaced
          ? `Oblíbenou "${nm}" jsem přepsal: bylo ${r0(replaced.calories)} kcal / ${r1(replaced.protein)} g B na ${replaced.amount}, nově ${calories} kcal / ${protein} g B na ${fav.amount}.`
          : `Uložil jsem "${nm}" (${fav.amount}, ${calories} kcal, ${protein} g B, ${carbs} g S, ${fat} g T) mezi oblíbené. Celkem jich máš ${favs.length}.`
      };
    }

    case 'log_favorite': {
      const q = String(a.name || '').trim();
      if (!q) return { ok: false, error: 'Chybí název oblíbené potraviny.' };
      const hits = matchFavorites(state, q);
      if (!hits.length) {
        const all = ensureFavorites(state).map((f) => f.name).slice(0, 20);
        return {
          ok: false,
          error: all.length
            ? `Oblíbenou "${q}" nemám. Uložené jsou: ${all.join(', ')}.`
            : `Oblíbenou "${q}" nemám a zatím nemáš uložené žádné oblíbené jídlo.`
        };
      }
      if (hits.length > 1) {
        return {
          ok: false,
          matches: hits.map((f) => f.name),
          error: `"${q}" sedí na víc oblíbených: ${hits.map((f) => f.name).join(', ')}. Nezapsal jsem nic — nech si upřesnit kterou.`
        };
      }

      const date = a.date == null || String(a.date).trim() === '' ? todayOf(state) : normDate(a.date, state);
      if (!date) return { ok: false, error: `Neplatné datum: ${a.date}. Použij formát YYYY-MM-DD.` };
      const portionsRaw = a.portions == null ? 1 : num(a.portions, 1);
      if (portionsRaw <= 0) return { ok: false, error: 'Počet porcí musí být větší než nula.' };
      const portions = clamp(Math.round(portionsRaw * 10) / 10, 0.1, 10);
      // Without a category there is no clock to guess from (state has only a
      // date), so an explicit fallback beats inventing a time of day.
      const cat = normCategory(a.category) || 'Afternoon snack';
      const fav = hits[0];

      const item = shapeItem({
        id: genId(),
        time: CATEGORY_TIME[cat],
        name: fav.name,
        amount: portions === 1 ? (fav.amount || '100g') : scaleAmount(fav.amount || '100g', portions),
        calories: num(fav.calories) * portions,
        protein: num(fav.protein) * portions,
        carbs: num(fav.carbs) * portions,
        fat: num(fav.fat) * portions,
        category: cat
      });

      const list = ensureDay(state, date);
      list.push(item);
      sortDay(list);
      const t = totals(list);

      return {
        ok: true,
        date, category: cat, portions,
        item: describeItem(item),
        dayTotals: t,
        note: `Zapsal jsem "${item.name}"${portions === 1 ? '' : ` ${portions}× porce`} (${item.amount}, ${item.calories} kcal, ${item.protein} g B) do ${czCat(cat)} na ${date}. Den je na ${t.calories} kcal a ${t.protein} g bílkovin.`
      };
    }

    case 'delete_favorite': {
      const q = String(a.name || '').trim();
      if (!q) return { ok: false, error: 'Chybí název oblíbené potraviny.' };
      const favs = ensureFavorites(state);
      const hits = matchFavorites(state, q);
      if (!hits.length) {
        return { ok: false, error: `Oblíbenou "${q}" nemám, mazat není co. Uložené jsou: ${favs.map((f) => f.name).slice(0, 20).join(', ') || 'žádné'}.` };
      }
      if (hits.length > 1) {
        return {
          ok: false,
          matches: hits.map((f) => f.name),
          error: `"${q}" sedí na víc oblíbených: ${hits.map((f) => f.name).join(', ')}. Nic jsem nesmazal — nech si upřesnit kterou.`
        };
      }
      const gone = hits[0];
      state.favorites = favs.filter((f) => f !== gone);
      return {
        ok: true,
        removed: gone.name,
        count: state.favorites.length,
        note: `Smazal jsem "${gone.name}" (${r0(gone.calories)} kcal / ${gone.amount}) z oblíbených. Zbývá jich ${state.favorites.length}. Zapsaná jídla v deníku jsem nechal.`
      };
    }

    case 'list_favorites': {
      const favs = ensureFavorites(state);
      if (!favs.length) return { ok: true, count: 0, favorites: [], note: 'Zatím nemáš uložené žádné oblíbené jídlo.' };
      return {
        ok: true,
        count: favs.length,
        favorites: favs.map((f) => ({
          name: f.name, amount: f.amount || '100g',
          calories: r0(f.calories), protein: r1(f.protein), carbs: r1(f.carbs), fat: r1(f.fat)
        })),
        note: `Máš ${favs.length} oblíbených: ${favs.map((f) => `${f.name} (${r0(f.calories)} kcal / ${r1(f.protein)} g B na ${f.amount || '100g'})`).join(', ')}.`
      };
    }

    // Read-only on purpose: a suggestion the user has not confirmed must never
    // end up in the diary.
    case 'suggest_meal_for_remaining': {
      const date = a.date == null || String(a.date).trim() === '' ? todayOf(state) : normDate(a.date, state);
      if (!date) return { ok: false, error: `Neplatné datum: ${a.date}. Použij formát YYYY-MM-DD.` };
      const targets = state.targets;
      if (!targets || !num(targets.calories)) {
        return { ok: false, error: 'Nejsou nastavené denní cíle, takže nevím, kolik dni zbývá. Nejdřív spočítej cíle.' };
      }

      const eaten = totals(dayItems(state, date));
      const remainingKcal = r0(num(targets.calories) - eaten.calories);
      const remainingProtein = r1(num(targets.protein) - eaten.protein);

      if (remainingKcal <= 0) {
        return {
          ok: true, date, eaten, remainingCalories: remainingKcal, remainingProtein,
          suggestions: [],
          note: `Na ${date} máš snědeno ${eaten.calories} kcal, cíl je ${r0(targets.calories)} kcal — jsi ${Math.abs(remainingKcal)} kcal nad. Nic dalšího nenavrhuju.`
        };
      }

      const candidates = knownFoods(state)
        .filter((f) => f.calories > 0 && f.calories <= remainingKcal)
        // Highest protein first, and among similar ones the food that is eaten
        // more often — a familiar suggestion is more likely to be accepted.
        .sort((x, y) => (y.protein - x.protein) || (y.count - x.count))
        .slice(0, 6);

      if (!candidates.length) {
        return {
          ok: true, date, eaten, remainingCalories: remainingKcal, remainingProtein, suggestions: [],
          note: `Na ${date} zbývá ${remainingKcal} kcal a ${remainingProtein} g bílkovin, ale v oblíbených ani v historii nemám nic, co by se do toho vešlo. Navrhni jídlo sám a nech si ho potvrdit.`
        };
      }

      return {
        ok: true,
        date,
        eaten,
        remainingCalories: remainingKcal,
        remainingProtein,
        suggestions: candidates.map((f) => ({
          name: f.name, amount: f.amount, calories: f.calories, protein: f.protein,
          source: f.source, timesLogged: f.count
        })),
        note: `Na ${date} zbývá ${remainingKcal} kcal a ${remainingProtein} g bílkovin. Vejde se: ${candidates.map((f) => `${f.name} ${f.amount} (${f.calories} kcal, ${f.protein} g B)`).join('; ')}. Nic jsem nezapsal — nech si vybrat.`
      };
    }

    case 'find_protein_source': {
      const need = num(a.gramsNeeded, 0);
      if (!(need > 0)) return { ok: false, error: 'Řekni, kolik gramů bílkovin je potřeba dohnat (kladné číslo).' };
      if (need > 300) return { ok: false, error: 'Přes 300 g bílkovin na jedno doplnění nedává smysl, zkontroluj číslo.' };

      const picks = knownFoods(state)
        .filter((f) => f.protein >= 3)
        .map((f) => {
          const portions = clamp(Math.round((need / f.protein) * 2) / 2, 0.5, 5);
          return {
            name: f.name,
            amount: portions === 1 ? f.amount : `${portions}× ${f.amount}`,
            portions,
            protein: r1(f.protein * portions),
            calories: r0(f.calories * portions),
            kcalPerGramProtein: f.protein > 0 ? Math.round((f.calories / f.protein) * 10) / 10 : null,
            source: f.source
          };
        })
        // Cheapest protein first: fewest calories per gram of protein.
        .sort((x, y) => (x.kcalPerGramProtein - y.kcalPerGramProtein))
        .slice(0, 5);

      if (!picks.length) {
        return { ok: false, error: `V oblíbených ani v historii nemám žádnou bílkovinovou potravinu, kterou bych na ${r1(need)} g doporučil. Navrhni něco sám a nabídni, že to uložíš do oblíbených.` };
      }

      return {
        ok: true,
        gramsNeeded: r1(need),
        options: picks,
        note: `Na ${r1(need)} g bílkovin: ${picks.map((p) => `${p.name} ${p.amount} = ${p.protein} g B za ${p.calories} kcal`).join('; ')}. Jen návrh, nic jsem nezapsal.`
      };
    }

    // Destructive, so the note spells out exactly what disappeared — the user
    // needs to be able to tell the coach it was wrong.
    case 'reset_day': {
      const date = normDate(a.date, state);
      if (!date) return { ok: false, error: `Neplatné datum: ${a.date}. Použij formát YYYY-MM-DD.` };
      const items = dayItems(state, date);
      if (!items.length) return { ok: false, error: `V den ${date} není zapsané žádné jídlo, mazat není co.` };

      const t = totals(items);
      const byCat = {};
      items.forEach((i) => {
        const c = czCat(itemCategory(i));
        byCat[c] = (byCat[c] || 0) + 1;
      });
      const names = items.map((i) => `${i.name} (${r0(i.calories)} kcal)`);

      delete state.logs[date];

      return {
        ok: true,
        date,
        deletedCount: items.length,
        deletedCalories: t.calories,
        deletedTotals: t,
        deletedItems: names,
        byCategory: byCat,
        note: `Smazal jsem celý ${date}: ${items.length} položek za ${t.calories} kcal (${t.protein} g B, ${t.carbs} g S, ${t.fat} g T) — ${names.join(', ')}. Vrátit to nejde, jídla se musí zapsat znovu.`
      };
    }

    default:
      return { ok: false, error: `Neznámý nástroj: ${name}` };
  }
}

module.exports = {
  FOODOPS_TOOLS,
  FOODOPS_TOOL_NAMES,
  applyFoodOpsTool
};
