// Coach memory, preferences and profile layer.
//
// Everything here is about what the app *knows* about the user — remembered
// facts, allergies, dislikes, equipment, goal, schedule limits, coaching style
// and per-day notes. Nothing in this file computes nutrition: targets belong to
// plans.js, and duplicating the formula here would mean two sources of truth
// that silently drift apart. Tools that change something targets depend on
// (set_goal) therefore tell the model to call compute_targets instead.
//
// Same contract as the other tool modules: applyPrefsTool is synchronous,
// mutates `state`, and returns an object the model reads back to the user.

const MAX_FACT_LEN = 200;
const MAX_DAY_NOTE_LEN = 500;
const MAX_DAY_NOTE_TOTAL = 2000;
const MAX_CONSTRAINT_LEN = 140;
const MAX_CONSTRAINTS = 10;
const MAX_LIST_ITEM_LEN = 60;
const MAX_LIST_ITEMS = 20;

const EQUIPMENT = {
  gym: 'posilovna — činky, osa, stroje i kladky',
  home: 'domácí vybavení — jednoručky, gumy, hrazda',
  minimal: 'minimum — jen vlastní váha, případně guma'
};

// The app-wide goal vocabulary is recomp/cut/bulk (computeTargets in plans.js
// only understands those three). The coach talks to users about hubnutí /
// nabírání / udržení, so the tool takes the plain words and maps them onto the
// stored value — writing "lose" straight into profile.goal would silently fall
// back to recomp the next time targets are computed.
const GOAL_MAP = {
  lose: 'cut', cut: 'cut', hubnuti: 'cut',
  gain: 'bulk', bulk: 'bulk', nabirani: 'bulk',
  maintain: 'recomp', recomp: 'recomp', udrzeni: 'recomp'
};
const GOAL_CZ = {
  cut: 'hubnutí (kalorický deficit)',
  bulk: 'nabírání (kalorický přebytek)',
  recomp: 'udržení / rekompozice (mírný deficit, důraz na bílkoviny)'
};

const STYLE_CZ = {
  strucny: 'stručně — krátké odpovědi, žádná vata',
  normalni: 'normálně — vyvážená délka',
  detailni: 'detailně — vysvětlovat souvislosti a proč'
};

const SEX_CZ = { male: 'muž', female: 'žena' };
const EXPERIENCE_CZ = { beginner: 'začátečník', intermediate: 'pokročilý', advanced: 'zkušený' };

// ---------------------------------------------------------------------------
// Helpers (kept local on purpose — this module imports nothing from plans.js)
// ---------------------------------------------------------------------------

function txt(v, max) {
  if (v == null) return '';
  return String(v).trim().replace(/\s+/g, ' ').slice(0, max);
}

// Comparison key: diacritics off, lower case, single spaces. Czech users type
// "jahody" and "Jahody" and "jahodý" for the same thing, and a match that only
// works with the right háčky would quietly duplicate entries.
function norm(v) {
  return String(v == null ? '' : v)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Older saved states predate these fields, so every accessor creates them.
function facts(state) {
  if (!Array.isArray(state.coachMemories)) state.coachMemories = [];
  return state.coachMemories;
}

function profile(state) {
  if (!state.profile || typeof state.profile !== 'object') state.profile = {};
  return state.profile;
}

// A legacy state may hold a bare string where a list belongs; keep that value
// instead of dropping the user's data on the floor.
function strList(obj, key) {
  const cur = obj[key];
  if (Array.isArray(cur)) {
    obj[key] = cur.map((s) => txt(s, MAX_LIST_ITEM_LEN)).filter(Boolean);
  } else if (typeof cur === 'string' && cur.trim()) {
    obj[key] = [txt(cur, MAX_LIST_ITEM_LEN)];
  } else {
    obj[key] = [];
  }
  return obj[key];
}

function dayNotes(state) {
  if (!state.dayNotes || typeof state.dayNotes !== 'object' || Array.isArray(state.dayNotes)) {
    state.dayNotes = {};
  }
  return state.dayNotes;
}

function isDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Noon UTC survives the Prague offset, so day arithmetic never slips a day.
function shiftDate(base, deltaDays) {
  const d = new Date(`${base}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

// The model sometimes sends "dnes"/"včera" instead of a date. Resolving them
// against state.today (never new Date()) keeps the note on the day the user meant.
function resolveDate(raw, state) {
  const today = isDate(state.today) ? state.today : null;
  const v = norm(raw);
  if (!v) return today;
  if (v === 'dnes' || v === 'today') return today;
  if (v === 'vcera' || v === 'yesterday') return today ? shiftDate(today, -1) : null;
  if (v === 'zitra' || v === 'tomorrow') return today ? shiftDate(today, 1) : null;
  return isDate(raw) ? String(raw) : null;
}

// Resolves a fact reference (id or a piece of its text) to exactly one fact.
// Ambiguity is an error, never a guess: deleting or rewriting the wrong
// remembered fact is invisible to the user until the coach acts on it.
function findFact(list, ref) {
  const raw = txt(ref, MAX_FACT_LEN);
  if (!raw) return { error: 'Řekni id faktu nebo část jeho textu — bez toho nevím, který fakt myslíš.' };

  const byId = list.findIndex((m) => m && String(m.id) === raw);
  if (byId >= 0) return { index: byId };

  const key = norm(raw);
  const exact = [];
  const partial = [];
  list.forEach((m, i) => {
    const t = norm(m && m.text);
    if (!t) return;
    if (t === key) exact.push(i);
    else if (t.includes(key)) partial.push(i);
  });

  const hits = exact.length ? exact : partial;
  if (!hits.length) {
    return {
      error: `Fakt "${raw}" v paměti není. Zavolej list_facts a vyber podle id.`,
      candidates: list.map((m) => ({ id: m.id, text: m.text }))
    };
  }
  if (hits.length > 1) {
    return {
      ambiguous: true,
      error: `"${raw}" sedí na ${hits.length} faktů — neuhodnu který. Zavolej to znovu s konkrétním id.`,
      candidates: hits.map((i) => ({ id: list[i].id, text: list[i].text }))
    };
  }
  return { index: hits[0] };
}

function listSummary(arr) {
  return arr.length ? arr.join(', ') : 'zatím nic';
}

// ---------------------------------------------------------------------------
// Tool declarations — the description is the model's only instruction manual
// ---------------------------------------------------------------------------

const PREFS_TOOLS = [
  {
    name: 'list_facts',
    description: 'Vypíše všechno, co si o uživateli pamatuješ (dlouhodobá paměť kouče), včetně id každého faktu. Nic nemění. Volej vždycky PŘED forget_fact nebo update_fact, aby ses trefil do správného id, a taky když se uživatel zeptá "co o mně víš".',
    parameters: { type: 'OBJECT', properties: {} }
  },
  {
    name: 'forget_fact',
    description: 'Smaže JEDEN zapamatovaný fakt. Použij, když uživatel řekne "zapomeň, že…" nebo "to už neplatí". Když se fakt jen změnil (např. jiná váha činky, jiná práce), použij update_fact — ten zachová id. Když na zadaný text sedí víc faktů, nástroj nic nesmaže a vrátí seznam kandidátů; zavolej ho pak znovu s konkrétním id.',
    parameters: {
      type: 'OBJECT',
      properties: {
        idOrText: { type: 'STRING', description: 'id faktu z list_facts, nebo část jeho textu (diakritika a velikost písmen nehrají roli)' }
      },
      required: ['idOrText']
    }
  },
  {
    name: 'update_fact',
    description: 'Přepíše text zapamatovaného faktu, id zůstane. Použij, když se informace změnila ("už nepracuju na směny, mám ranní"), místo forget_fact + nového zápisu.',
    parameters: {
      type: 'OBJECT',
      properties: {
        idOrText: { type: 'STRING', description: 'id faktu z list_facts, nebo část jeho stávajícího textu' },
        newText: { type: 'STRING', description: 'Nové znění faktu, jedna věta (max 200 znaků)' }
      },
      required: ['idOrText', 'newText']
    }
  },
  {
    name: 'add_allergy',
    description: 'Přidá potravinovou ALERGII nebo nesnášenlivost do profilu — tedy něco, co uživatel jíst NESMÍ (ořechy, laktóza, lepek). Tohle je zdravotní omezení: v jídelníčku to nesmí být nikdy. Když jde jen o to, že mu něco nechutná, použij add_dislike.',
    parameters: {
      type: 'OBJECT',
      properties: { item: { type: 'STRING', description: 'Název alergenu, jak ho řekl uživatel, např. "arašídy"' } },
      required: ['item']
    }
  },
  {
    name: 'remove_allergy',
    description: 'Odebere alergii z profilu. Použij, když uživatel řekne, že už ji nemá nebo že šlo o omyl.',
    parameters: {
      type: 'OBJECT',
      properties: { item: { type: 'STRING', description: 'Název alergenu (diakritika a velikost písmen nehrají roli)' } },
      required: ['item']
    }
  },
  {
    name: 'add_dislike',
    description: 'Přidá jídlo, které uživateli NECHUTNÁ — smí ho jíst, jen ho nechce. Do jídelníčku ho nedávej, ale není to zdravotní riziko. Na alergie a nesnášenlivosti použij add_allergy.',
    parameters: {
      type: 'OBJECT',
      properties: { item: { type: 'STRING', description: 'Název jídla, např. "brokolice"' } },
      required: ['item']
    }
  },
  {
    name: 'remove_dislike',
    description: 'Odebere jídlo ze seznamu nechutenství — uživatel si ho oblíbil nebo je ochotný ho zkusit.',
    parameters: {
      type: 'OBJECT',
      properties: { item: { type: 'STRING', description: 'Název jídla (diakritika a velikost písmen nehrají roli)' } },
      required: ['item']
    }
  },
  {
    name: 'set_equipment',
    description: 'Nastaví, k jakému vybavení má uživatel přístup: gym = posilovna, home = domácí činky/gumy/hrazda, minimal = jen vlastní váha. Volej, když uživatel řekne, že mění místo tréninku ("skončil jsem s posilovnou, cvičím doma"). Po změně projdi tréninkový plán a cviky, které se s novým vybavením nedají dělat, vyměň přes update_workout_day.',
    parameters: {
      type: 'OBJECT',
      properties: { equipment: { type: 'STRING', enum: ['gym', 'home', 'minimal'], description: 'gym | home | minimal' } },
      required: ['equipment']
    }
  },
  {
    name: 'set_goal',
    description: 'Změní hlavní cíl uživatele: lose = hubnutí, gain = nabírání, maintain = udržení/rekompozice. Volej, když uživatel řekne, že chce něco jiného než dosud ("už nechci hubnout, chci nabrat"). Tenhle nástroj kalorie NEPŘEPOČÍTÁVÁ — hned po něm zavolej compute_targets, jinak zůstanou staré cíle.',
    parameters: {
      type: 'OBJECT',
      properties: { goal: { type: 'STRING', enum: ['lose', 'gain', 'maintain'], description: 'lose | gain | maintain' } },
      required: ['goal']
    }
  },
  {
    name: 'set_schedule_constraint',
    description: 'Uloží trvalé časové omezení uživatele ("v úterý můžu jen ráno", "o víkendu netrénuju", "ve středu mám noční"). Ber to jako pravidlo, které platí každý týden — na jednorázovou změnu tohoto týdne použij swap_workout_days. Drží se posledních 10 omezení.',
    parameters: {
      type: 'OBJECT',
      properties: { text: { type: 'STRING', description: 'Omezení jednou větou, max 140 znaků' } },
      required: ['text']
    }
  },
  {
    name: 'set_coach_style',
    description: 'Nastaví, jak má kouč psát: strucny = krátce a věcně, normalni = vyváženě, detailni = s vysvětlením a souvislostmi. Volitelně i tón ("drsňácky", "vlídně"). Volej, když si uživatel řekne o jinou délku nebo tón odpovědí ("piš mi to kratší").',
    parameters: {
      type: 'OBJECT',
      properties: {
        style: { type: 'STRING', enum: ['strucny', 'normalni', 'detailni'], description: 'strucny | normalni | detailni' },
        tone: { type: 'STRING', description: 'Nepovinný tón, např. "přátelsky" nebo "bez omáčky"' }
      },
      required: ['style']
    }
  },
  {
    name: 'add_note_to_day',
    description: 'Připíše poznámku ke konkrétnímu dni (nemoc, dovolená, špatný spánek, oslava) — kontext, proč ten den vypadá, jak vypadá. Poznámku k existujícímu dni PŘIPOJÍ na nový řádek, nic nepřepisuje. Není to zápis jídla ani tréninku, jen komentář ke dni.',
    parameters: {
      type: 'OBJECT',
      properties: {
        date: { type: 'STRING', description: 'Datum YYYY-MM-DD, případně "dnes" nebo "vcera". Když nevyplníš, použije se dnešek.' },
        text: { type: 'STRING', description: 'Text poznámky, max 500 znaků' }
      },
      required: ['text']
    }
  },
  {
    name: 'get_profile_summary',
    description: 'Vrátí kompletní přehled toho, co appka o uživateli ví — profil, cíl, vybavení, alergie, nechutenství, časová omezení, styl kouče a počet zapamatovaných faktů. Nic nemění. Použij, když se uživatel zeptá "co o mně víš" nebo než mu začneš předělávat plán.',
    parameters: { type: 'OBJECT', properties: {} }
  }
];

const PREFS_TOOL_NAMES = new Set(PREFS_TOOLS.map((t) => t.name));

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

// Shared body for the four allergy/dislike tools — they differ only in the
// field they touch and the words in the note.
function addToList(state, key, label, rawItem) {
  const p = profile(state);
  const list = strList(p, key);
  const item = txt(rawItem, MAX_LIST_ITEM_LEN);
  if (!item) return { ok: false, error: `Neřekl jsi, co má do seznamu (${label}) přibýt.` };

  const existing = list.find((x) => norm(x) === norm(item));
  if (existing) {
    return {
      ok: true,
      changed: false,
      list,
      note: `"${existing}" už v seznamu (${label}) je, podruhé to nepřidávám. Aktuálně: ${listSummary(list)}.`
    };
  }
  if (list.length >= MAX_LIST_ITEMS) {
    return { ok: false, error: `Seznam (${label}) je plný (${MAX_LIST_ITEMS} položek). Něco nejdřív odeber.` };
  }
  // Stored exactly as the user wrote it — only the comparison is normalised.
  list.push(item);
  return { ok: true, changed: true, list, note: `Přidáno do seznamu (${label}): "${item}". Aktuálně: ${listSummary(list)}.` };
}

function removeFromList(state, key, label, rawItem) {
  const p = profile(state);
  const list = strList(p, key);
  const item = txt(rawItem, MAX_LIST_ITEM_LEN);
  if (!item) return { ok: false, error: `Neřekl jsi, co ze seznamu (${label}) odebrat.` };

  const key0 = norm(item);
  let hits = list.filter((x) => norm(x) === key0);
  if (!hits.length) hits = list.filter((x) => norm(x).includes(key0));

  if (!hits.length) {
    return { ok: false, error: `"${item}" v seznamu (${label}) není. Aktuálně tam je: ${listSummary(list)}.`, list };
  }
  if (hits.length > 1) {
    return { ok: false, error: `"${item}" sedí na víc položek (${hits.join(', ')}) — napiš přesně tu, kterou mám odebrat.`, candidates: hits };
  }
  const removed = hits[0];
  p[key] = list.filter((x) => x !== removed);
  return { ok: true, removed, list: p[key], note: `Odebráno ze seznamu (${label}): "${removed}". Zbývá: ${listSummary(p[key])}.` };
}

// Applies one tool call. Mutates `state`, returns the object fed back to the
// model. Never touches state.targets — that is plans.js territory.
function applyPrefsTool(name, args, state) {
  const a = args || {};

  switch (name) {
    // ---- memory ----------------------------------------------------------
    case 'list_facts': {
      const list = facts(state);
      return {
        ok: true,
        count: list.length,
        facts: list.map((m) => ({ id: m.id, text: m.text })),
        note: list.length
          ? `V paměti je ${list.length} faktů.`
          : 'V paměti zatím nic není.'
      };
    }

    case 'forget_fact': {
      const list = facts(state);
      if (!list.length) return { ok: false, error: 'Paměť je prázdná, není co zapomínat.' };
      const found = findFact(list, a.idOrText);
      if (found.error) return { ok: false, error: found.error, candidates: found.candidates || [] };
      const removed = list[found.index];
      list.splice(found.index, 1);
      return {
        ok: true,
        removed: { id: removed.id, text: removed.text },
        remaining: list.length,
        note: `Zapomenuto: "${removed.text}". V paměti zbývá ${list.length} faktů.`
      };
    }

    case 'update_fact': {
      const list = facts(state);
      if (!list.length) return { ok: false, error: 'Paměť je prázdná, není co upravovat — použij zápis nového faktu.' };
      const newText = txt(a.newText, MAX_FACT_LEN);
      if (!newText) return { ok: false, error: 'Chybí nové znění faktu (newText).' };
      const found = findFact(list, a.idOrText);
      if (found.error) return { ok: false, error: found.error, candidates: found.candidates || [] };
      const fact = list[found.index];
      const before = fact.text;
      if (norm(before) === norm(newText)) {
        return { ok: true, changed: false, id: fact.id, text: fact.text, note: `Fakt "${before}" už takhle zní, nic neměním.` };
      }
      fact.text = newText;
      return {
        ok: true,
        changed: true,
        id: fact.id,
        before,
        text: newText,
        note: `Fakt přepsán: "${before}" → "${newText}".`
      };
    }

    // ---- food restrictions ----------------------------------------------
    case 'add_allergy': return addToList(state, 'allergies', 'alergie', a.item);
    case 'remove_allergy': return removeFromList(state, 'allergies', 'alergie', a.item);
    case 'add_dislike': return addToList(state, 'dislikes', 'nechutná mu', a.item);
    case 'remove_dislike': return removeFromList(state, 'dislikes', 'nechutná mu', a.item);

    // ---- training context ------------------------------------------------
    case 'set_equipment': {
      const eq = norm(a.equipment);
      if (!EQUIPMENT[eq]) {
        return { ok: false, error: `Neznámé vybavení "${a.equipment == null ? '' : a.equipment}". Povolené hodnoty: gym, home, minimal.` };
      }
      const p = profile(state);
      const before = p.equipment || null;
      p.equipment = eq;
      const hasPlan = !!state.workoutPlan;
      return {
        ok: true,
        equipment: eq,
        before,
        note: `Vybavení nastaveno na ${eq} (${EQUIPMENT[eq]}).`
          + (eq === 'minimal' ? ' Plán teď musí stát na cvicích s vlastní vahou — žádné činky ani stroje.' : '')
          + (eq === 'home' ? ' V plánu počítej s jednoručkami, gumami a hrazdou, ne se stroji.' : '')
          + (eq === 'gym' ? ' V plánu můžeš používat osu, stroje i kladky.' : '')
          + (hasPlan ? ' Projdi stávající tréninkový plán a cviky, které se s tímhle vybavením nedají dělat, vyměň přes update_workout_day.' : '')
      };
    }

    case 'set_goal': {
      const raw = norm(a.goal);
      const goal = GOAL_MAP[raw];
      if (!goal) {
        return { ok: false, error: `Neznámý cíl "${a.goal == null ? '' : a.goal}". Povolené hodnoty: lose (hubnutí), gain (nabírání), maintain (udržení).` };
      }
      const p = profile(state);
      const before = p.goal || null;
      if (before === goal) {
        return { ok: true, changed: false, goal, note: `Cíl už je "${GOAL_CZ[goal]}", nic neměním. Kalorie nech, jak jsou.` };
      }
      p.goal = goal;
      const kcal = state.targets && state.targets.calories ? `Současný cíl ${state.targets.calories} kcal ještě patří ke starému cíli. ` : '';
      return {
        ok: true,
        changed: true,
        goal,
        before,
        note: `Cíl změněn na ${GOAL_CZ[goal]}. ${kcal}TEĎ ZAVOLEJ compute_targets, aby se přepočítaly kalorie a makra — dokud to neuděláš, cíle uživateli nesedí. Sám čísla nepočítej.`
      };
    }

    case 'set_schedule_constraint': {
      const p = profile(state);
      const list = strList(p, 'scheduleConstraints');
      const text = txt(a.text, MAX_CONSTRAINT_LEN);
      if (!text) return { ok: false, error: 'Chybí text omezení, např. "v úterý můžu jen ráno".' };
      if (list.some((x) => norm(x) === norm(text))) {
        return { ok: true, changed: false, constraints: list, note: `Omezení "${text}" už uložené je, podruhé ho nepřidávám.` };
      }
      list.push(text);
      // Newest wins: a stale limit from three months ago must not push out the
      // one the user just said out loud.
      let dropped = null;
      if (list.length > MAX_CONSTRAINTS) dropped = list.splice(0, list.length - MAX_CONSTRAINTS)[0];
      return {
        ok: true,
        changed: true,
        constraints: list,
        dropped,
        note: `Uloženo omezení: "${text}". Celkem ${list.length} omezení.`
          + (dropped ? ` Nejstarší ("${dropped}") vypadlo, drží se jen posledních ${MAX_CONSTRAINTS}.` : '')
      };
    }

    case 'set_coach_style': {
      const style = norm(a.style);
      if (!STYLE_CZ[style]) {
        return { ok: false, error: `Neznámý styl "${a.style == null ? '' : a.style}". Povolené hodnoty: strucny, normalni, detailni.` };
      }
      const p = profile(state);
      const tone = txt(a.tone, MAX_LIST_ITEM_LEN);
      p.coachStyle = { style, tone: tone || null, updatedAt: Date.now() };
      return {
        ok: true,
        coachStyle: p.coachStyle,
        note: `Styl komunikace nastaven na "${style}" (${STYLE_CZ[style]})`
          + (tone ? `, tón: ${tone}` : '')
          + '. Projeví se od příští zprávy — tuhle odpověď ještě napiš normálně a jen potvrď změnu.'
      };
    }

    // ---- day notes -------------------------------------------------------
    case 'add_note_to_day': {
      const date = resolveDate(a.date, state);
      if (!date) {
        return { ok: false, error: `Neplatné datum "${a.date == null ? '' : a.date}" — čekám formát YYYY-MM-DD, nebo "dnes"/"vcera".` };
      }
      const text = txt(a.text, MAX_DAY_NOTE_LEN);
      if (!text) return { ok: false, error: 'Chybí text poznámky.' };

      const notes = dayNotes(state);
      const prev = typeof notes[date] === 'string' ? notes[date] : '';
      // norm() collapses newlines, so split the raw note first.
      if (prev && prev.split('\n').some((l) => norm(l) === norm(text))) {
        return { ok: true, changed: false, date, note: `Poznámka "${text}" u ${date} už je, nepřidávám ji dvakrát.`, dayNote: prev };
      }
      // Append, never overwrite: a day can collect several unrelated notes and
      // replacing them would throw away context the user already gave.
      const merged = (prev ? prev + '\n' + text : text).slice(0, MAX_DAY_NOTE_TOTAL);
      notes[date] = merged;
      return {
        ok: true,
        changed: true,
        date,
        appended: !!prev,
        dayNote: merged,
        note: prev
          ? `K poznámce u ${date} přidán nový řádek: "${text}". Původní text zůstal.`
          : `Poznámka k ${date}: "${text}".`
      };
    }

    // ---- read-only overview ----------------------------------------------
    case 'get_profile_summary': {
      const p = profile(state);
      const allergies = strList(p, 'allergies');
      const dislikes = strList(p, 'dislikes');
      const restrictions = strList(p, 'dietaryRestrictions');
      const constraints = strList(p, 'scheduleConstraints');
      const mem = facts(state);

      const L = [];
      L.push(`Cíl: ${p.goal && GOAL_CZ[p.goal] ? GOAL_CZ[p.goal] : 'není nastavený'}`);
      L.push(`Pohlaví: ${SEX_CZ[p.sex] || 'neznámé'}`);
      L.push(`Věk: ${p.age != null ? p.age + ' let' : 'neznámý'}`);
      L.push(`Výška: ${p.heightCm != null ? p.heightCm + ' cm' : 'neznámá'}`);
      L.push(`Váha: ${p.weightKg != null ? p.weightKg + ' kg' : 'neznámá'}`);
      L.push(`Tréninky: ${p.trainingDaysPerWeek != null ? p.trainingDaysPerWeek + '× týdně' : 'neznámo'}`
        + (p.sessionMinutes ? `, ${p.sessionMinutes} min` : ''));
      L.push(`Zkušenost: ${EXPERIENCE_CZ[p.experience] || 'neznámá'}`);
      L.push(`Vybavení: ${p.equipment && EQUIPMENT[p.equipment] ? p.equipment + ' — ' + EQUIPMENT[p.equipment] : 'není nastavené'}`);
      L.push(`Alergie: ${listSummary(allergies)}`);
      L.push(`Nechutná mu: ${listSummary(dislikes)}`);
      L.push(`Stravovací omezení: ${listSummary(restrictions)}`);
      L.push(`Časová omezení: ${listSummary(constraints)}`);
      const cs = p.coachStyle;
      L.push(`Styl kouče: ${cs && STYLE_CZ[cs.style] ? STYLE_CZ[cs.style] + (cs.tone ? `, tón: ${cs.tone}` : '') : 'výchozí'}`);
      if (state.targets && state.targets.calories) {
        const t = state.targets;
        L.push(`Denní cíle: ${t.calories} kcal, B ${t.protein} g, S ${t.carbs} g, T ${t.fat} g`);
      } else {
        L.push('Denní cíle: zatím nespočítané (compute_targets)');
      }
      L.push(`Zapamatovaných faktů: ${mem.length}`);

      const missing = [];
      if (!p.sex) missing.push('pohlaví');
      if (!p.age) missing.push('věk');
      if (!p.heightCm) missing.push('výška');
      if (!p.weightKg) missing.push('váha');
      if (!p.goal) missing.push('cíl');
      if (p.trainingDaysPerWeek == null) missing.push('počet tréninků týdně');

      return {
        ok: true,
        profile: p,
        allergies,
        dislikes,
        scheduleConstraints: constraints,
        facts: mem.map((m) => ({ id: m.id, text: m.text })),
        missingFields: missing,
        summary: L.join('\n'),
        note: `Přehled profilu (${L.length} položek).`
          + (missing.length ? ` Chybí: ${missing.join(', ')}.` : '')
      };
    }

    default:
      return { ok: false, error: `Neznámý nástroj: ${name}` };
  }
}

module.exports = {
  PREFS_TOOLS, PREFS_TOOL_NAMES, applyPrefsTool,
  // exported for tests / reuse by the coordinator
  GOAL_MAP, GOAL_CZ, EQUIPMENT, STYLE_CZ
};
