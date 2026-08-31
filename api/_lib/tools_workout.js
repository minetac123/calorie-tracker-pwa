// Coach tools for editing an EXISTING workout plan.
//
// plans.js owns creating and replacing whole days (set_workout_plan,
// update_workout_day, copy_workout_day, swap_workout_days). This module only
// does surgery inside a day that already exists: add/remove/reorder/substitute
// single exercises, deload the week, and so on. Nothing here regenerates a
// plan — if there is none, the tools refuse and tell the model to create one
// first, because silently inventing a week would overwrite what the user has.
//
// Everything is synchronous and mutates `state` in place, same contract as
// plans.js applyTool. Helpers are duplicated on purpose: the modules must stay
// independent of each other.

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_CZ = {
  mon: 'Pondělí', tue: 'Úterý', wed: 'Středa', thu: 'Čtvrtek',
  fri: 'Pátek', sat: 'Sobota', sun: 'Neděle'
};

const MAX_EXERCISES = 14; // same ceiling normWorkoutDay in plans.js enforces
const NOTE_MAX = 140;     // notes are truncated to this by plans.js normExercise

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function newExId() {
  return 'ex_' + Math.random().toString(36).slice(2, 9);
}

// Diacritics-insensitive key used for every name comparison — the model writes
// "drep" as often as "dřep" and the user types both.
function normName(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Czech decimal comma — these strings go straight to the user.
function fmtKg(n) {
  return (Math.round(n * 10) / 10).toString().replace('.', ',');
}

function normDayKey(k) {
  if (!k) return null;
  const s = normName(k);
  if (DAY_KEYS.includes(s)) return s;
  const map = {
    'monday': 'mon', 'po': 'mon', 'pondeli': 'mon',
    'tuesday': 'tue', 'tues': 'tue', 'ut': 'tue', 'utery': 'tue',
    'wednesday': 'wed', 'st': 'wed', 'streda': 'wed',
    'thursday': 'thu', 'thur': 'thu', 'thurs': 'thu', 'ct': 'thu', 'ctvrtek': 'thu',
    'friday': 'fri', 'pa': 'fri', 'patek': 'fri',
    'saturday': 'sat', 'so': 'sat', 'sobota': 'sat',
    'sunday': 'sun', 'ne': 'sun', 'nedele': 'sun'
  };
  return map[s] || null;
}

// Weekday key for a YYYY-MM-DD string. Noon UTC survives the Prague offset.
function dayKeyForDate(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const d = new Date(`${dateStr}T12:00:00Z`);
  return DAY_KEYS[(d.getUTCDay() + 6) % 7];
}

function todayStr(state) {
  // state.today is authoritative (server runs UTC, user is in Prague); the
  // clock read is only a last resort when the caller did not pass it.
  const t = state && state.today;
  if (t && /^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return new Date().toISOString().slice(0, 10);
}

// Accepts weekday keys plus the relative words the model likes to pass through
// verbatim ("dnes", "zítra").
function resolveDayKey(state, v) {
  const s = normName(v);
  const today = dayKeyForDate(todayStr(state));
  if (s === 'dnes' || s === 'today') return today;
  if (s === 'zitra' || s === 'tomorrow') return DAY_KEYS[(DAY_KEYS.indexOf(today) + 1) % 7];
  if (s === 'vcera' || s === 'yesterday') return DAY_KEYS[(DAY_KEYS.indexOf(today) + 6) % 7];
  return normDayKey(v);
}

// ---------------------------------------------------------------------------
// Plan access
// ---------------------------------------------------------------------------

const NO_PLAN = {
  ok: false,
  error: 'Tréninkový plán zatím neexistuje. Nejdřív si nech vytvořit plán (set_workout_plan), pak v něm můžu upravovat jednotlivé cviky.'
};

// Returns { key, day } or an { ok:false } result ready to be returned as-is.
function getDay(state, dayArg) {
  const plan = state && state.workoutPlan;
  if (!plan || !plan.days) return { err: NO_PLAN };
  const key = resolveDayKey(state, dayArg);
  if (!key) return { err: { ok: false, error: `Neznámý den "${dayArg}". Použij pondělí až neděle.` } };
  const day = plan.days[key];
  if (!day) return { err: { ok: false, error: `Den ${DAY_CZ[key]} v plánu chybí.` } };
  if (!Array.isArray(day.exercises)) day.exercises = [];
  return { key, day, plan };
}

function touch(state) {
  state.workoutPlan.updatedAt = Date.now();
}

function exLabel(e) {
  return `${e.name} ${e.sets}×${e.reps}`;
}

function dayExerciseNames(day) {
  return (day.exercises || []).map((e) => e.name).join(', ') || 'žádné';
}

// Resolve an exercise by id, exact name, or a fragment of the name. The model
// almost never has the id at hand, so name matching is the normal path.
function findExercise(day, ref) {
  const list = day.exercises || [];
  const raw = String(ref == null ? '' : ref).trim();
  if (!raw) return null;

  let idx = list.findIndex((e) => e.id === raw);
  if (idx === -1) {
    const n = normName(raw);
    if (!n) return null;
    idx = list.findIndex((e) => normName(e.name) === n);
    if (idx === -1) idx = list.findIndex((e) => normName(e.name).includes(n));
    // The reverse direction ("bench press s velkou činkou" vs "bench press")
    // only when the stored name is long enough to be meaningful.
    if (idx === -1) idx = list.findIndex((e) => normName(e.name).length >= 4 && n.includes(normName(e.name)));
  }
  return idx === -1 ? null : { idx, ex: list[idx] };
}

// A day must not end up with the same lift twice. Exact match is obvious;
// "bench press" vs "Bench press s velkou činkou" is the same lift too, while a
// single shared word ("kliky" inside "Tricepsové kliky o lavici") is not.
function duplicateOf(day, name) {
  const n = normName(name);
  const list = day.exercises || [];
  const exact = list.find((e) => normName(e.name) === n);
  if (exact) return exact;
  return list.find((e) => {
    const s = normName(e.name);
    const shorter = s.length <= n.length ? s : n;
    const longer = s.length <= n.length ? n : s;
    return shorter.split(' ').length >= 2 && longer.includes(shorter);
  }) || null;
}

function notFound(ref, key, day) {
  return { ok: false, error: `Cvik "${ref}" jsem v ${DAY_CZ[key]} nenašel. V tom dni jsou: ${dayExerciseNames(day)}.` };
}

// Notes are a single "; " separated line. Tags (tempo, superséria, dropset,
// cílová váha) must replace their older selves instead of piling up.
function replaceNoteTag(ex, re, text) {
  const parts = String(ex.note || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !re.test(s));
  if (text) parts.push(text);
  ex.note = parts.join('; ').slice(0, NOTE_MAX);
}

// Newest working weight for an exercise, taken from the logs the user actually
// recorded (keyed by normalised name, so it survives plan regeneration).
function lastWorkingWeight(state, name) {
  const logs = (state && state.exerciseLogs) || {};
  const key = normName(name);
  let entry = logs[key];
  if (!entry) {
    const hit = Object.keys(logs).find((k) => k === key || k.includes(key) || (key.length >= 4 && key.includes(k)));
    entry = hit ? logs[hit] : null;
  }
  const sessions = entry && Array.isArray(entry.sessions) ? entry.sessions : [];
  if (!sessions.length) return null;
  const last = sessions[sessions.length - 1];
  const sets = Array.isArray(last.sets) ? last.sets.filter((s) => num(s && s.w) > 0) : [];
  if (!sets.length) return null;
  const top = sets.reduce((b, s) => (num(s.w) > num(b.w) ? s : b), sets[0]);
  return { weight: num(top.w), reps: Math.round(num(top.r)), date: last.date };
}

// ---------------------------------------------------------------------------
// Supplementary exercise catalogue for extend_workout
// ---------------------------------------------------------------------------

// equipment: 'minimal' works everywhere (bodyweight), 'home' needs dumbbells /
// bands, 'gym' needs machines or cables.
const CATALOG = {
  legs: [
    { name: 'Leg press', sets: 3, reps: '10-12', restSec: 120, equipment: 'gym' },
    { name: 'Předkopávání na stroji', sets: 3, reps: '12-15', restSec: 60, equipment: 'gym' },
    { name: 'Zakopávání na stroji', sets: 3, reps: '10-12', restSec: 60, equipment: 'gym' },
    { name: 'Bulharský dřep s jednoručkami', sets: 3, reps: '8-10', restSec: 90, equipment: 'home' },
    { name: 'Rumunský mrtvý tah s jednoručkami', sets: 3, reps: '10-12', restSec: 90, equipment: 'home' },
    { name: 'Výpady vlastní vahou', sets: 3, reps: '12-15', restSec: 60, equipment: 'minimal' },
    { name: 'Výpony na lýtka', sets: 4, reps: '15-20', restSec: 45, equipment: 'minimal' }
  ],
  chest: [
    { name: 'Peck deck', sets: 3, reps: '12-15', restSec: 60, equipment: 'gym' },
    { name: 'Stahování kladek přes hrudník', sets: 3, reps: '12-15', restSec: 60, equipment: 'gym' },
    { name: 'Tlak s jednoručkami na šikmé lavici', sets: 3, reps: '8-10', restSec: 90, equipment: 'home' },
    { name: 'Rozpažky s jednoručkami', sets: 3, reps: '12-15', restSec: 60, equipment: 'home' },
    { name: 'Kliky', sets: 3, reps: '12-20', restSec: 60, equipment: 'minimal' }
  ],
  back: [
    { name: 'Stahování horní kladky', sets: 3, reps: '10-12', restSec: 75, equipment: 'gym' },
    { name: 'Veslování na stroji', sets: 3, reps: '10-12', restSec: 75, equipment: 'gym' },
    { name: 'Přítahy jednoručky v předklonu', sets: 3, reps: '10-12', restSec: 75, equipment: 'home' },
    { name: 'Rozpažky v předklonu s jednoručkami', sets: 3, reps: '12-15', restSec: 60, equipment: 'home' },
    { name: 'Australské shyby', sets: 3, reps: '8-12', restSec: 75, equipment: 'minimal' },
    { name: 'Superman', sets: 3, reps: '12-15', restSec: 45, equipment: 'minimal' }
  ],
  shoulders: [
    { name: 'Tlak na ramena na stroji', sets: 3, reps: '8-10', restSec: 90, equipment: 'gym' },
    { name: 'Upažování na kladce', sets: 3, reps: '12-15', restSec: 60, equipment: 'gym' },
    { name: 'Upažování s jednoručkami', sets: 3, reps: '12-15', restSec: 60, equipment: 'home' },
    { name: 'Arnold press', sets: 3, reps: '8-10', restSec: 75, equipment: 'home' },
    { name: 'Pike kliky', sets: 3, reps: '8-12', restSec: 60, equipment: 'minimal' }
  ],
  arms: [
    { name: 'Triceps na kladce', sets: 3, reps: '12-15', restSec: 60, equipment: 'gym' },
    { name: 'Biceps na Scottově lavici', sets: 3, reps: '10-12', restSec: 60, equipment: 'gym' },
    { name: 'Bicepsový zdvih s jednoručkami', sets: 3, reps: '10-12', restSec: 60, equipment: 'home' },
    { name: 'Kladivový zdvih', sets: 3, reps: '10-12', restSec: 60, equipment: 'home' },
    { name: 'Francouzský tlak s jednoručkou', sets: 3, reps: '10-12', restSec: 60, equipment: 'home' },
    { name: 'Tricepsové kliky o lavici', sets: 3, reps: '12-15', restSec: 60, equipment: 'minimal' }
  ],
  core: [
    { name: 'Kladka na břicho', sets: 3, reps: '12-15', restSec: 60, equipment: 'gym' },
    { name: 'Ruský twist s jednoručkou', sets: 3, reps: '16-20', restSec: 45, equipment: 'home' },
    { name: 'Plank', sets: 3, reps: '45 s', restSec: 45, equipment: 'minimal' },
    { name: 'Mrtvý brouk', sets: 3, reps: '10-12', restSec: 45, equipment: 'minimal' },
    { name: 'Zvedání nohou v lehu', sets: 3, reps: '12-15', restSec: 45, equipment: 'minimal' }
  ],
  fullbody: [
    { name: 'Farmářská chůze', sets: 3, reps: '40 m', restSec: 75, equipment: 'home' },
    { name: 'Švihy s kettlebellem', sets: 3, reps: '15-20', restSec: 60, equipment: 'home' },
    { name: 'Burpees', sets: 3, reps: '8-12', restSec: 60, equipment: 'minimal' },
    { name: 'Výpady vlastní vahou', sets: 3, reps: '12-15', restSec: 60, equipment: 'minimal' },
    { name: 'Plank', sets: 3, reps: '45 s', restSec: 45, equipment: 'minimal' }
  ]
};

const FOCUS_KEYWORDS = {
  legs: ['noh', 'nohy', 'dolni', 'stehn', 'quad', 'hamstring', 'glute', 'hyzd', 'lytk', 'lytka', 'drep', 'leg', 'spodek'],
  chest: ['hrud', 'prsa', 'prsni', 'chest', 'push', 'tlak', 'bench'],
  back: ['zada', 'zad', 'back', 'pull', 'sirok', 'veslovan', 'shyb'],
  shoulders: ['raman', 'ramen', 'delt', 'shoulder'],
  arms: ['biceps', 'triceps', 'paze', 'ruce', 'arm'],
  core: ['bric', 'core', 'stred tela', 'ab']
};

function detectFocus(day) {
  const hay = normName([day.focus, day.title, (day.exercises || []).map((e) => e.name).join(' ')].join(' '));
  const found = Object.keys(FOCUS_KEYWORDS).filter((cat) =>
    FOCUS_KEYWORDS[cat].some((k) => hay.includes(k)));
  return found.length ? found : ['fullbody'];
}

function allowedEquipment(profile) {
  const e = normName(profile && profile.equipment);
  if (e === 'gym' || e === 'posilovna') return ['minimal', 'home', 'gym'];
  if (e === 'minimal' || e === 'none' || e === 'zadne' || e === 'nic') return ['minimal'];
  // Unknown equipment is treated as home: prescribing machines nobody has is
  // worse than prescribing dumbbells that can be swapped for bodyweight.
  return ['minimal', 'home'];
}

// Priority for shorten_workout: big multi-joint lifts stay, isolation goes.
const COMPOUND_BIG = ['drep', 'squat', 'mrtvy tah', 'deadlift', 'bench', 'tlak', 'press', 'shyb', 'pull up', 'chin up', 'veslovan', 'row'];
const COMPOUND_MID = ['vypad', 'lunge', 'klik', 'push up', 'stahovani', 'dip', 'hip thrust', 'leg press', 'pritah'];

function compoundScore(name) {
  const n = normName(name);
  if (COMPOUND_BIG.some((k) => n.includes(k))) return 2;
  if (COMPOUND_MID.some((k) => n.includes(k))) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Gemini tool declarations
// ---------------------------------------------------------------------------

const DAY_PARAM = { type: 'STRING', enum: DAY_KEYS, description: 'Den v týdnu (mon-sun). Přijímá i "dnes"/"zítra".' };
const REF_PARAM = { type: 'STRING', description: 'Cvik — buď jeho id z plánu, nebo název (stačí část, diakritika nehraje roli).' };

const WORKOUTOPS_TOOLS = [
  {
    name: 'add_exercise_to_plan_day',
    description: 'Přidej JEDEN cvik do už existujícího dne v tréninkovém plánu. Použij na "přidej mi ve středu ještě biceps". Zbytek dne zůstane nedotčený — tím se liší od update_workout_day, který celý den přepíše. Když má uživatel přidat víc cviků "aby byl trénink delší", použij radši extend_workout.',
    parameters: {
      type: 'OBJECT',
      properties: {
        day: DAY_PARAM,
        name: { type: 'STRING', description: 'Český název cviku, např. "Bicepsový zdvih s jednoručkami"' },
        sets: { type: 'INTEGER', description: 'Počet sérií (výchozí 3)' },
        reps: { type: 'STRING', description: 'Rozsah opakování, např. "8-12" (výchozí "8-12")' },
        restSec: { type: 'INTEGER', description: 'Pauza mezi sériemi v sekundách (výchozí 90)' },
        note: { type: 'STRING', description: 'Krátká technická poznámka (volitelné)' },
        position: { type: 'STRING', description: '"start" = na začátek dne, "end" = na konec (výchozí), nebo číslo pozice od nuly.' }
      },
      required: ['day', 'name']
    }
  },
  {
    name: 'remove_exercise_from_plan_day',
    description: 'Odstraň JEDEN cvik ze dne v plánu natrvalo (platí i pro příští týdny). Použij na "ten cvik mi nesedí, vyhoď ho". POZOR: když ho chce uživatel vynechat jen dneska (bolí ho záda, je obsazený stroj), použij skip_exercise_today nebo substitute_exercise — plán se pak nemění.',
    parameters: {
      type: 'OBJECT',
      properties: { day: DAY_PARAM, exerciseRef: REF_PARAM },
      required: ['day', 'exerciseRef']
    }
  },
  {
    name: 'reorder_plan_exercises',
    description: 'Přeskládej pořadí cviků ve dni. Použij na "dej dřepy na začátek" nebo "těžké věci první". Cviky, které v seznamu neuvedeš, zůstanou na konci v původním pořadí — nemusíš vypisovat celý den.',
    parameters: {
      type: 'OBJECT',
      properties: {
        day: DAY_PARAM,
        order: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Cviky v požadovaném pořadí (id nebo názvy).' }
      },
      required: ['day', 'order']
    }
  },
  {
    name: 'substitute_exercise',
    description: 'Nahraď cvik jiným a ZACHOVEJ série, opakování i pauzu. Použij na "je obsazený leg press, co místo toho" nebo "tenhle stroj tu nemají". Když má cvik jen zmizet, použij remove_exercise_from_plan_day; když jde o jednorázový výpadek dneška, skip_exercise_today.',
    parameters: {
      type: 'OBJECT',
      properties: {
        day: DAY_PARAM,
        exerciseRef: REF_PARAM,
        newName: { type: 'STRING', description: 'Český název náhradního cviku' },
        note: { type: 'STRING', description: 'Proč se mění / technická poznámka (volitelné)' }
      },
      required: ['day', 'exerciseRef', 'newName']
    }
  },
  {
    name: 'set_rest_day',
    description: 'Udělej ze dne volno — všechny cviky z toho dne zmizí. Použij na "v pátek trénovat nebudu". Když si chce uživatel trénink jen přesunout jinam, použij nejdřív swap_workout_days nebo copy_workout_day, ať o něj nepřijde.',
    parameters: {
      type: 'OBJECT',
      properties: { day: DAY_PARAM },
      required: ['day']
    }
  },
  {
    name: 'deload_week',
    description: 'Zlehči CELÝ týden — sníží počet sérií u všech tréninkových dnů o zadaná procenta, opakování nechá být. Použij na "jsem vyčerpaný, potřebuju lehčí týden". Dny volna se nemění a žádný cvik nezmizí.',
    parameters: {
      type: 'OBJECT',
      properties: {
        percent: { type: 'INTEGER', description: 'O kolik procent snížit série, 5 až 50 (výchozí 10).' }
      },
      required: []
    }
  },
  {
    name: 'progress_exercise',
    description: 'Zvyš cílovou váhu u jednoho cviku (progresivní přetížení). Použij na "tohle už mi jde lehce, přidej kilo". Když u cviku žádná cílová váha není, zapíše se doporučení do poznámky podle poslední zalogované série.',
    parameters: {
      type: 'OBJECT',
      properties: {
        day: DAY_PARAM,
        exerciseRef: REF_PARAM,
        kgStep: { type: 'NUMBER', description: 'O kolik kg zvýšit, 0,5 až 20 (výchozí 2,5).' }
      },
      required: ['day', 'exerciseRef']
    }
  },
  {
    name: 'suggest_warmup_sets',
    description: 'Navrhne rozcvičovací série (40/60/80 % pracovní váhy) k cviku. POUZE ČTE — nic v plánu nemění. Použij na "jak se mám rozehřát před dřepy". Potřebuje zalogovanou historii vah u toho cviku.',
    parameters: {
      type: 'OBJECT',
      properties: {
        day: DAY_PARAM,
        exerciseRef: { type: 'STRING', description: 'Cvik (id nebo název). Když ho neuvedeš, vezme se první cvik dne.' }
      },
      required: ['day']
    }
  },
  {
    name: 'add_superset',
    description: 'Spoj dva cviky ve dni do supersérie — půjdou hned po sobě bez pauzy mezi nimi. Použij na "mám málo času, spoj mi biceps s tricepsem".',
    parameters: {
      type: 'OBJECT',
      properties: { day: DAY_PARAM, exerciseRefA: REF_PARAM, exerciseRefB: REF_PARAM },
      required: ['day', 'exerciseRefA', 'exerciseRefB']
    }
  },
  {
    name: 'add_dropset',
    description: 'Přidej cviku dropset na poslední sérii (po selhání snížit váhu a pokračovat). Použij na "chci to na konci dorazit".',
    parameters: {
      type: 'OBJECT',
      properties: { day: DAY_PARAM, exerciseRef: REF_PARAM },
      required: ['day', 'exerciseRef']
    }
  },
  {
    name: 'set_exercise_tempo',
    description: 'Nastav cviku tempo ve formátu "excentrická-pauza dole-koncentrická-pauza nahoře", např. "3-1-1-0". Použij na "chci to dělat pomaleji" nebo "víc pod kontrolou".',
    parameters: {
      type: 'OBJECT',
      properties: {
        day: DAY_PARAM,
        exerciseRef: REF_PARAM,
        tempo: { type: 'STRING', description: 'Čtyři čísla oddělená pomlčkami, např. "3-1-1-0". Místo čísla lze "X" pro maximální rychlost.' }
      },
      required: ['day', 'exerciseRef', 'tempo']
    }
  },
  {
    name: 'skip_exercise_today',
    description: 'Vynech cvik POUZE pro dnešek — týdenní plán zůstane beze změny a příště tam cvik zase bude. Použij na "dneska ten cvik vynechám, bolí mě rameno". Když má zmizet natrvalo, je to remove_exercise_from_plan_day.',
    parameters: {
      type: 'OBJECT',
      properties: { exerciseRef: REF_PARAM },
      required: ['exerciseRef']
    }
  },
  {
    name: 'extend_workout',
    description: 'Přidej ke dni několik doplňkových cviků podle jeho zaměření a podle vybavení z profilu (posilovna/domov/minimum). Použij na "mám dneska víc času, přidej mi něco navíc". Když uživatel řekne konkrétní cvik, použij add_exercise_to_plan_day.',
    parameters: {
      type: 'OBJECT',
      properties: {
        day: DAY_PARAM,
        count: { type: 'INTEGER', description: 'Kolik cviků přidat, 1 až 5 (výchozí 2).' }
      },
      required: ['day']
    }
  },
  {
    name: 'shorten_workout',
    description: 'Zkrať den na zadaný počet cviků — zůstanou ty nejdůležitější (dřepy, mrtvý tah, bench, tlaky, shyby, veslování), izolované cviky odpadnou. Použij na "mám jen 40 minut". Změna platí i pro příští týdny; když jde jen o dnešek, použij skip_exercise_today.',
    parameters: {
      type: 'OBJECT',
      properties: {
        day: DAY_PARAM,
        targetCount: { type: 'INTEGER', description: 'Kolik cviků má ve dni zbýt (1 až 14).' }
      },
      required: ['day', 'targetCount']
    }
  }
];

const WORKOUTOPS_TOOL_NAMES = new Set(WORKOUTOPS_TOOLS.map((t) => t.name));

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

function applyWorkoutOpsTool(name, args, state) {
  const a = args || {};
  if (!state || typeof state !== 'object') return { ok: false, error: 'Chybí stav aplikace.' };

  switch (name) {
    case 'add_exercise_to_plan_day': {
      const d = getDay(state, a.day);
      if (d.err) return d.err;

      const exName = String(a.name || '').trim().slice(0, 80);
      if (!exName) return { ok: false, error: 'Chybí název cviku.' };
      if (d.day.exercises.length >= MAX_EXERCISES) {
        return { ok: false, error: `${DAY_CZ[d.key]} má už ${MAX_EXERCISES} cviků, víc se do jednoho dne nevejde. Nejdřív něco odeber.` };
      }
      const dup = duplicateOf(d.day, exName);
      if (dup) {
        return { ok: false, error: `Cvik "${dup.name}" už v ${DAY_CZ[d.key]} je (${exLabel(dup)}). Když ho chceš změnit, použij substitute_exercise.` };
      }

      const ex = {
        id: newExId(),
        name: exName,
        sets: clamp(Math.round(num(a.sets, 3)), 1, 12),
        reps: String(a.reps || '8-12').slice(0, 20),
        restSec: clamp(Math.round(num(a.restSec, 90)), 15, 600),
        note: a.note ? String(a.note).slice(0, NOTE_MAX) : ''
      };

      const len = d.day.exercises.length;
      const pos = normName(a.position);
      let idx = len;
      if (pos === 'start' || pos === 'zacatek' || pos === 'prvni') idx = 0;
      else if (pos === 'end' || pos === 'konec' || pos === 'posledni' || !pos) idx = len;
      else if (Number.isFinite(Number(a.position))) idx = clamp(Math.round(Number(a.position)), 0, len);
      d.day.exercises.splice(idx, 0, ex);

      // Adding an exercise to a rest day turns it into a training day — silently
      // leaving rest:true would hide the exercise in the client.
      const wasRest = !!d.day.rest;
      if (wasRest) {
        d.day.rest = false;
        if (!d.day.title || normName(d.day.title) === 'volno') d.day.title = 'Trénink';
      }
      touch(state);

      return {
        ok: true,
        day: DAY_CZ[d.key],
        exercise: exLabel(ex),
        exerciseId: ex.id,
        position: idx + 1,
        exercises: d.day.exercises.map(exLabel),
        note: `Do ${DAY_CZ[d.key]} přidán ${ex.name} ${ex.sets}×${ex.reps} (pauza ${ex.restSec} s) na ${idx + 1}. místo. Den má teď ${d.day.exercises.length} cviků.`
          + (wasRest ? ` ${DAY_CZ[d.key]} bylo volno — je z něj teď tréninkový den.` : '')
      };
    }

    case 'remove_exercise_from_plan_day': {
      const d = getDay(state, a.day);
      if (d.err) return d.err;
      const hit = findExercise(d.day, a.exerciseRef);
      if (!hit) return notFound(a.exerciseRef, d.key, d.day);

      d.day.exercises.splice(hit.idx, 1);
      touch(state);
      const left = d.day.exercises.length;
      return {
        ok: true,
        day: DAY_CZ[d.key],
        removed: exLabel(hit.ex),
        remaining: d.day.exercises.map(exLabel),
        note: `Z ${DAY_CZ[d.key]} odebrán ${hit.ex.name} (${hit.ex.sets}×${hit.ex.reps}). Zbývá ${left} cviků: ${dayExerciseNames(d.day)}.`
          + (left === 0 ? ' Den je teď prázdný — buď do něj něco přidej, nebo z něj udělej volno.' : '')
      };
    }

    case 'reorder_plan_exercises': {
      const d = getDay(state, a.day);
      if (d.err) return d.err;
      const list = d.day.exercises;
      if (list.length < 2) return { ok: false, error: `${DAY_CZ[d.key]} má ${list.length} cviků, není co přeskládat.` };

      const order = Array.isArray(a.order) ? a.order : [];
      if (!order.length) return { ok: false, error: 'Chybí pořadí cviků.' };

      const before = list.map(exLabel);
      const used = new Set();
      const picked = [];
      const unknown = [];
      order.forEach((ref) => {
        const hit = findExercise(d.day, ref);
        if (!hit || used.has(hit.idx)) { unknown.push(String(ref)); return; }
        used.add(hit.idx);
        picked.push(hit.ex);
      });
      if (!picked.length) {
        return { ok: false, error: `Ani jeden z uvedených cviků v ${DAY_CZ[d.key]} není. V tom dni jsou: ${dayExerciseNames(d.day)}.` };
      }

      // Everything the model did not mention keeps its original relative order
      // at the end — the model rarely lists a whole day.
      const rest = list.filter((_, i) => !used.has(i));
      d.day.exercises = picked.concat(rest);
      touch(state);

      return {
        ok: true,
        day: DAY_CZ[d.key],
        before,
        after: d.day.exercises.map(exLabel),
        unmatched: unknown.length ? unknown : undefined,
        note: `Pořadí v ${DAY_CZ[d.key]}: ${d.day.exercises.map((e, i) => `${i + 1}. ${e.name}`).join(', ')}.`
          + (unknown.length ? ` Nenašel jsem: ${unknown.join(', ')} — ty jsem nechal být.` : '')
      };
    }

    case 'substitute_exercise': {
      const d = getDay(state, a.day);
      if (d.err) return d.err;
      const hit = findExercise(d.day, a.exerciseRef);
      if (!hit) return notFound(a.exerciseRef, d.key, d.day);

      const newName = String(a.newName || '').trim().slice(0, 80);
      if (!newName) return { ok: false, error: 'Chybí název náhradního cviku.' };
      if (normName(newName) === normName(hit.ex.name)) {
        return { ok: false, error: `"${newName}" je ten samý cvik, co tam už je. Pošli jiný název.` };
      }

      const old = hit.ex;
      // New id on purpose: workoutLogs/exerciseLogs are keyed by exercise, and
      // reusing the id would attribute the old exercise's ticks to the new one.
      const fresh = {
        id: newExId(),
        name: newName,
        sets: old.sets,
        reps: old.reps,
        restSec: old.restSec,
        note: a.note ? String(a.note).slice(0, NOTE_MAX) : `náhrada za ${old.name}`
      };
      d.day.exercises[hit.idx] = fresh;
      touch(state);

      return {
        ok: true,
        day: DAY_CZ[d.key],
        replaced: exLabel(old),
        withExercise: exLabel(fresh),
        exerciseId: fresh.id,
        note: `V ${DAY_CZ[d.key]} je místo cviku ${old.name} nově ${fresh.name}, série i opakování zůstaly ${fresh.sets}×${fresh.reps} (pauza ${fresh.restSec} s).`
      };
    }

    case 'set_rest_day': {
      const d = getDay(state, a.day);
      if (d.err) return d.err;
      if (d.day.rest && !d.day.exercises.length) {
        return { ok: false, error: `${DAY_CZ[d.key]} už je den volna, není co měnit.` };
      }

      const dropped = d.day.exercises.map(exLabel);
      const oldTitle = d.day.title;
      d.day.title = 'Volno';
      d.day.rest = true;
      d.day.focus = '';
      d.day.exercises = [];
      touch(state);

      return {
        ok: true,
        day: DAY_CZ[d.key],
        removedExercises: dropped,
        note: dropped.length
          ? `${DAY_CZ[d.key]} je nově volno. Z plánu tím zmizel trénink "${oldTitle}" a ${dropped.length} cviků: ${dropped.join(', ')}. Když ho chceš zachovat, řekni a překopíruju ho na jiný den.`
          : `${DAY_CZ[d.key]} je nově volno (žádné cviky tam nebyly).`
      };
    }

    case 'deload_week': {
      const plan = state.workoutPlan;
      if (!plan || !plan.days) return NO_PLAN;
      const percent = clamp(Math.round(num(a.percent, 10)), 5, 50);
      const factor = 1 - percent / 100;

      const trainingDays = DAY_KEYS.filter((k) => {
        const day = plan.days[k];
        return day && !day.rest && Array.isArray(day.exercises) && day.exercises.length;
      });
      if (!trainingDays.length) return { ok: false, error: 'V plánu není žádný tréninkový den, není co zlehčovat.' };

      const totalBefore = trainingDays.reduce((s, k) =>
        s + plan.days[k].exercises.reduce((t, e) => t + Math.round(num(e.sets, 3)), 0), 0);
      // Rounding can swallow a small percentage entirely (3 sérií × 10 % → 3).
      // A deload that changes nothing is worse than useless, so fall back to
      // rounding down when the first pass moved no sets at all.
      let projected = trainingDays.reduce((s, k) =>
        s + plan.days[k].exercises.reduce((t, e) => t + Math.max(1, Math.round(Math.round(num(e.sets, 3)) * factor)), 0), 0);
      const round = projected < totalBefore ? Math.round : Math.floor;

      const perDay = {};
      trainingDays.forEach((k) => {
        const day = plan.days[k];
        const changes = [];
        day.exercises.forEach((e) => {
          const before = clamp(Math.round(num(e.sets, 3)), 1, 12);
          const after = Math.max(1, round(before * factor));
          if (after !== before) changes.push(`${e.name} ${before}→${after}`);
          e.sets = after; // reps deliberately untouched — a deload cuts volume, not intensity
        });
        // Deload is a temporary state; saying so in focus is what the user sees
        // in the app without opening the chat.
        const baseFocus = String(day.focus || '').replace(/\s*\(deload[^)]*\)/gi, '').trim();
        day.focus = `${baseFocus}${baseFocus ? ' ' : ''}(deload -${percent} %)`.slice(0, 60);
        perDay[DAY_CZ[k]] = changes.length ? changes.join(', ') : 'beze změny (už jen 1 série)';
      });

      projected = trainingDays.reduce((s, k) =>
        s + plan.days[k].exercises.reduce((t, e) => t + e.sets, 0), 0);
      touch(state);

      const restDays = DAY_KEYS.filter((k) => plan.days[k] && plan.days[k].rest).map((k) => DAY_CZ[k]);
      return {
        ok: true,
        percent,
        setsBefore: totalBefore,
        setsAfter: projected,
        perDay,
        restDaysUntouched: restDays,
        note: `Deload -${percent} %: celkem ${totalBefore} → ${projected} sérií za týden napříč ${trainingDays.length} tréninkovými dny. Opakování i váhy zůstávají, dny volna (${restDays.join(', ') || 'žádné'}) jsem nesahal.`
      };
    }

    case 'progress_exercise': {
      const d = getDay(state, a.day);
      if (d.err) return d.err;
      const hit = findExercise(d.day, a.exerciseRef);
      if (!hit) return notFound(a.exerciseRef, d.key, d.day);

      const step = clamp(num(a.kgStep, 2.5), 0.5, 20);
      const ex = hit.ex;

      if (Number.isFinite(Number(ex.targetWeight)) && Number(ex.targetWeight) > 0) {
        const before = Number(ex.targetWeight);
        ex.targetWeight = Math.round((before + step) * 10) / 10;
        touch(state);
        return {
          ok: true, day: DAY_CZ[d.key], exercise: ex.name,
          targetWeightBefore: before, targetWeight: ex.targetWeight,
          note: `${ex.name} v ${DAY_CZ[d.key]}: cílová váha ${fmtKg(before)} → ${fmtKg(ex.targetWeight)} kg (+${fmtKg(step)} kg), série ${ex.sets}×${ex.reps} beze změny.`
        };
      }

      // No target field on the exercise (the usual case) — write the target into
      // the note instead of inventing a field the client does not render.
      const last = lastWorkingWeight(state, ex.name);
      const target = last ? Math.round((last.weight + step) * 10) / 10 : null;
      replaceNoteTag(ex, /^cíl /i, target ? `cíl ${fmtKg(target)} kg` : `příště přidej ${fmtKg(step)} kg`);
      touch(state);

      return {
        ok: true,
        day: DAY_CZ[d.key],
        exercise: ex.name,
        lastWeight: last ? last.weight : null,
        suggestedTarget: target,
        note: target
          ? `${ex.name} v ${DAY_CZ[d.key]}: naposledy (${last.date}) ${fmtKg(last.weight)} kg × ${last.reps}, do poznámky jsem zapsal cíl ${fmtKg(target)} kg (+${fmtKg(step)} kg). Série ${ex.sets}×${ex.reps} zůstávají.`
          : `${ex.name} v ${DAY_CZ[d.key]} nemá zalogovanou váhu, tak jsem do poznámky dal doporučení "příště přidej ${fmtKg(step)} kg". Až sérii zapíšeš, budu počítat z konkrétních čísel.`
      };
    }

    // READ-ONLY: nothing below may touch state.
    case 'suggest_warmup_sets': {
      const d = getDay(state, a.day);
      if (d.err) return d.err;
      if (!d.day.exercises.length) return { ok: false, error: `${DAY_CZ[d.key]} nemá žádné cviky.` };

      const ex = a.exerciseRef ? (findExercise(d.day, a.exerciseRef) || {}).ex : d.day.exercises[0];
      if (!ex) return notFound(a.exerciseRef, d.key, d.day);

      const last = lastWorkingWeight(state, ex.name);
      if (!last) {
        return { ok: false, error: `U cviku ${ex.name} nemám zaznamenanou žádnou pracovní váhu, takže rozcvičku nespočítám. Zaloguj sérii (váha × opakování) a zkus to znovu.` };
      }

      const plan = [{ pct: 40, reps: 8 }, { pct: 60, reps: 5 }, { pct: 80, reps: 3 }]
        .map((s) => ({
          percent: s.pct,
          // Round to 2.5 kg — nothing else can be loaded on a bar anyway.
          weight: Math.max(2.5, Math.round((last.weight * s.pct / 100) / 2.5) * 2.5),
          reps: s.reps
        }));

      return {
        ok: true,
        readOnly: true,
        day: DAY_CZ[d.key],
        exercise: ex.name,
        workingWeight: last.weight,
        lastLogged: last.date,
        warmupSets: plan.map((s) => `${fmtKg(s.weight)} kg × ${s.reps} (${s.percent} %)`),
        note: `Rozcvička na ${ex.name} (pracovní váha ${fmtKg(last.weight)} kg z ${last.date}): ${plan.map((s) => `${fmtKg(s.weight)} kg × ${s.reps}`).join(', ')}, pak pracovní série ${ex.sets}×${ex.reps}. Mezi rozcvičovacími sériemi stačí 60 s. V plánu jsem nic neměnil.`
      };
    }

    case 'add_superset': {
      const d = getDay(state, a.day);
      if (d.err) return d.err;
      const A = findExercise(d.day, a.exerciseRefA);
      if (!A) return notFound(a.exerciseRefA, d.key, d.day);
      const B = findExercise(d.day, a.exerciseRefB);
      if (!B) return notFound(a.exerciseRefB, d.key, d.day);
      if (A.idx === B.idx) return { ok: false, error: 'Superséria potřebuje dva různé cviky.' };

      replaceNoteTag(A.ex, /^supers[eé]ri[ae] s /i, `superséria s ${B.ex.name}`);
      replaceNoteTag(B.ex, /^supers[eé]ri[ae] s /i, `superséria s ${A.ex.name}`);

      // Put B right after A so the pair is adjacent in the client's list.
      const list = d.day.exercises;
      list.splice(B.idx, 1);
      const aIdx = list.indexOf(A.ex);
      list.splice(aIdx + 1, 0, B.ex);
      touch(state);

      return {
        ok: true,
        day: DAY_CZ[d.key],
        superset: [exLabel(A.ex), exLabel(B.ex)],
        exercises: list.map(exLabel),
        note: `V ${DAY_CZ[d.key]} jsou ${A.ex.name} a ${B.ex.name} spojené do supersérie a jdou hned po sobě. Mezi nimi bez pauzy, pauza ${A.ex.restSec} s až po druhém cviku. Ušetří ti to zhruba ${Math.round(A.ex.sets * A.ex.restSec / 60)} minut.`
      };
    }

    case 'add_dropset': {
      const d = getDay(state, a.day);
      if (d.err) return d.err;
      const hit = findExercise(d.day, a.exerciseRef);
      if (!hit) return notFound(a.exerciseRef, d.key, d.day);

      replaceNoteTag(hit.ex, /^dropset/i, 'dropset na poslední sérii: po selhání sniž váhu o 20 % a jeď do selhání');
      touch(state);
      return {
        ok: true,
        day: DAY_CZ[d.key],
        exercise: hit.ex.name,
        note: `${hit.ex.name} v ${DAY_CZ[d.key]} má nově dropset na poslední (${hit.ex.sets}.) sérii — po selhání sniž váhu o 20 % a pokračuj do selhání. Zbylé série nech normálně.`
      };
    }

    case 'set_exercise_tempo': {
      const d = getDay(state, a.day);
      if (d.err) return d.err;
      const hit = findExercise(d.day, a.exerciseRef);
      if (!hit) return notFound(a.exerciseRef, d.key, d.day);

      const raw = String(a.tempo || '').trim().replace(/\s+/g, '');
      const m = raw.match(/^(\d{1,2}|[xX])-(\d{1,2}|[xX])-(\d{1,2}|[xX])-(\d{1,2}|[xX])$/);
      if (!m) {
        return { ok: false, error: `Tempo "${a.tempo}" nemá správný formát. Čekám čtyři čísla oddělená pomlčkami, např. "3-1-1-0" (3 s dolů, 1 s pauza, 1 s nahoru, 0 s nahoře). Místo čísla lze "X".` };
      }
      const tempo = raw.toUpperCase();
      replaceNoteTag(hit.ex, /^tempo /i, `tempo ${tempo}`);
      touch(state);

      return {
        ok: true,
        day: DAY_CZ[d.key],
        exercise: hit.ex.name,
        tempo,
        note: `${hit.ex.name} v ${DAY_CZ[d.key]} má nastavené tempo ${tempo} (${m[1]} s excentricky, ${m[2]} s pauza dole, ${m[3]} s koncentricky, ${m[4]} s nahoře). Při pomalejším tempu čekej nižší váhu, série ${hit.ex.sets}×${hit.ex.reps} nechávám.`
      };
    }

    // The whole point of this tool: the weekly plan must survive untouched.
    // The skip lives in workoutLogs for a single date, exactly like the "done"
    // ticks, so next week the exercise shows up again on its own.
    case 'skip_exercise_today': {
      const plan = state.workoutPlan;
      if (!plan || !plan.days) return NO_PLAN;
      const date = todayStr(state);
      const key = dayKeyForDate(date);
      const day = key && plan.days[key];
      if (!day) return { ok: false, error: 'Dnešní den v plánu nenajdu.' };
      if (day.rest || !Array.isArray(day.exercises) || !day.exercises.length) {
        return { ok: false, error: `Dnes (${DAY_CZ[key]}) je v plánu volno, není co vynechávat.` };
      }
      const hit = findExercise(day, a.exerciseRef);
      if (!hit) return notFound(a.exerciseRef, key, day);

      if (!state.workoutLogs || typeof state.workoutLogs !== 'object') state.workoutLogs = {};
      if (!state.workoutLogs[date] || typeof state.workoutLogs[date] !== 'object') state.workoutLogs[date] = { done: [] };
      const log = state.workoutLogs[date];
      if (!Array.isArray(log.done)) log.done = [];
      if (!Array.isArray(log.skipped)) log.skipped = [];
      if (log.skipped.includes(hit.ex.id)) {
        return { ok: false, error: `${hit.ex.name} už máš na dnešek (${date}) vynechaný.` };
      }
      log.skipped.push(hit.ex.id);
      // No touch(state) here on purpose: workoutPlan.updatedAt must not move,
      // otherwise the client would think its copy of the weekly plan is stale.

      const left = day.exercises.filter((e) => !log.skipped.includes(e.id));
      return {
        ok: true,
        date,
        day: DAY_CZ[key],
        skipped: hit.ex.name,
        skippedToday: log.skipped.length,
        remainingToday: left.map(exLabel),
        note: `${hit.ex.name} dnes (${date}) vynecháváš — zbývá ${left.length} cviků: ${left.map((e) => e.name).join(', ') || 'žádný'}. Týdenní plán jsem nezměnil, příští ${DAY_CZ[key].toLowerCase()} tam cvik zase bude.`
      };
    }

    case 'extend_workout': {
      const d = getDay(state, a.day);
      if (d.err) return d.err;
      if (d.day.rest) return { ok: false, error: `${DAY_CZ[d.key]} je den volna. Buď z něj nejdřív udělej tréninkový den, nebo přidej cviky jinam.` };

      const want = clamp(Math.round(num(a.count, 2)), 1, 5);
      const room = MAX_EXERCISES - d.day.exercises.length;
      if (room <= 0) return { ok: false, error: `${DAY_CZ[d.key]} má už ${MAX_EXERCISES} cviků, víc se tam nevejde.` };

      const cats = detectFocus(d.day);
      const allowed = allowedEquipment(state.profile);
      const have = new Set(d.day.exercises.map((e) => normName(e.name)));
      const isDup = (n) => have.has(normName(n)) || !!duplicateOf(d.day, n);

      // Round-robin across the detected focus categories, so a "push" day gets
      // chest AND triceps instead of four chest exercises.
      const pools = cats.map((c) => (CATALOG[c] || []).filter((x) => allowed.includes(x.equipment)));
      const picked = [];
      for (let round = 0; picked.length < Math.min(want, room) && round < 8; round++) {
        let progressed = false;
        for (let i = 0; i < pools.length && picked.length < Math.min(want, room); i++) {
          const cand = pools[i][round];
          if (!cand) continue;
          progressed = true;
          if (isDup(cand.name)) continue;
          have.add(normName(cand.name));
          picked.push(cand);
        }
        if (!progressed) break;
      }

      if (!picked.length) {
        return { ok: false, error: `K zaměření "${d.day.focus || d.day.title}" a vybavení "${(state.profile && state.profile.equipment) || 'neuvedeno'}" už nemám co rozumného přidat — všechno vhodné tam už je. Řekni konkrétní cvik a přidám ho.` };
      }

      const added = picked.map((c) => {
        const ex = { id: newExId(), name: c.name, sets: c.sets, reps: c.reps, restSec: c.restSec, note: '' };
        d.day.exercises.push(ex);
        return ex;
      });
      touch(state);

      return {
        ok: true,
        day: DAY_CZ[d.key],
        focus: cats.join(', '),
        equipment: (state.profile && state.profile.equipment) || 'neuvedeno',
        added: added.map(exLabel),
        exercises: d.day.exercises.map(exLabel),
        note: `Do ${DAY_CZ[d.key]} (${d.day.focus || d.day.title}) jsem přidal ${added.length} cviků: ${added.map((e) => `${e.name} ${e.sets}×${e.reps}`).join(', ')}. Den má teď ${d.day.exercises.length} cviků, počítej zhruba +${added.reduce((s, e) => s + Math.round(e.sets * (e.restSec + 40) / 60), 0)} minut.`
          + (added.length < want ? ` Víc vhodných cviků k tomu zaměření a vybavení nemám.` : '')
      };
    }

    case 'shorten_workout': {
      const d = getDay(state, a.day);
      if (d.err) return d.err;
      const list = d.day.exercises;
      if (!list.length) return { ok: false, error: `${DAY_CZ[d.key]} nemá žádné cviky.` };

      const target = clamp(Math.round(num(a.targetCount, 0)), 1, MAX_EXERCISES);
      if (!a.targetCount || target < 1) return { ok: false, error: 'Řekni, kolik cviků má ve dni zbýt (1 až 14).' };
      if (target >= list.length) {
        return { ok: false, error: `${DAY_CZ[d.key]} má jen ${list.length} cviků, na ${target} ho zkracovat nemusím.` };
      }

      // Sort by importance but keep the original order as tie-break, so the
      // kept exercises stay in the sequence the user is used to.
      const ranked = list
        .map((e, i) => ({ e, i, score: compoundScore(e.name) }))
        .sort((x, y) => (y.score - x.score) || (x.i - y.i));
      const keep = ranked.slice(0, target).sort((x, y) => x.i - y.i).map((r) => r.e);
      const dropped = ranked.slice(target).sort((x, y) => x.i - y.i).map((r) => r.e);

      d.day.exercises = keep;
      touch(state);

      return {
        ok: true,
        day: DAY_CZ[d.key],
        kept: keep.map(exLabel),
        removed: dropped.map(exLabel),
        note: `${DAY_CZ[d.key]} zkráceno z ${list.length} na ${keep.length} cviků. Zůstává: ${keep.map((e) => `${e.name} ${e.sets}×${e.reps}`).join(', ')}. Odpadlo: ${dropped.map((e) => e.name).join(', ')} — nechal jsem velké vícekloubové cviky, izolace šla pryč. Změna platí i pro další týdny; kdyby to bylo jen na dnešek, řekni a vynechám je jen dneska.`
      };
    }

    default:
      return { ok: false, error: `Neznámý nástroj: ${name}` };
  }
}

module.exports = {
  WORKOUTOPS_TOOLS,
  WORKOUTOPS_TOOL_NAMES,
  applyWorkoutOpsTool
};
