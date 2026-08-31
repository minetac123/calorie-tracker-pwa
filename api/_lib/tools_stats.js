// Coach analytics layer: read-only tools over the data the app already has.
//
// Nothing in this file mutates `state` — every tool just reads, counts and
// returns findings, which makes them the safe ones for the model to call at
// will. Two rules drive the shape of every result:
//
//   1. A thin sample is never dressed up as a finding. Each result carries the
//      sample size and, where the data cannot carry the conclusion, a
//      `weakSample: true` plus a note that says so in plain Czech — "dvě vážení"
//      must never come back as "hubneš 0,5 kg týdně".
//   2. When there is genuinely nothing to report (unknown exercise, zero
//      weigh-ins behind a prediction), the tool returns ok:false with an
//      explanation rather than a number nobody can stand behind. Period tools
//      that legitimately have "nula zapsaných dní" as an answer return ok:true
//      with hasData:false so the coach can say exactly that.

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_CZ = {
  mon: 'Pondělí', tue: 'Úterý', wed: 'Středa', thu: 'Čtvrtek',
  fri: 'Pátek', sat: 'Sobota', sun: 'Neděle'
};

// Same activity multipliers and goal math as the plan layer — explain_number
// has to reproduce the app's numbers exactly, and the modules stay independent.
const ACTIVITY_FACTORS = { 0: 1.2, 1: 1.32, 2: 1.4, 3: 1.48, 4: 1.55, 5: 1.63, 6: 1.72, 7: 1.8 };
const GOAL_ADJUST = { recomp: 0.92, cut: 0.82, bulk: 1.10 };
const GOAL_PROTEIN = { recomp: 2.0, cut: 2.2, bulk: 1.8 };
const GOAL_CZ = { recomp: 'rekompozice', cut: 'hubnutí', bulk: 'nabírání' };

// Energy in a kilo of body mass — the constant behind every "kolik ti to
// ubere" estimate in the app.
const KCAL_PER_KG = 7700;

// A day counts as "v cíli" within this many kcal either way.
const KCAL_TOLERANCE = 150;

// Compound lifts jump in bigger steps than isolation work.
const BIG_LIFT_HINTS = [
  'drep', 'squat', 'mrtvy tah', 'deadlift', 'bench', 'tlak', 'press',
  'leg press', 'hip thrust', 'veslovani', 'row', 'pritahy', 'shyby', 'pull up'
];

// ---------------------------------------------------------------------------
// Small helpers (kept local on purpose — this module imports nothing)
// ---------------------------------------------------------------------------

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function r0(n) {
  return Math.round(num(n, 0));
}

function r1(n) {
  return Math.round(num(n, 0) * 10) / 10;
}

function pct(part, total) {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

function avg(list) {
  if (!list.length) return 0;
  return list.reduce((s, x) => s + x, 0) / list.length;
}

// Czech decimal comma, for strings the user actually reads.
function cz(n) {
  return String(n).replace('.', ',');
}

// Czech has three plural forms (1 / 2-4 / 5+) and the model repeats these
// strings verbatim, so getting them right here saves it from guessing.
function plural(n, one, few, many) {
  const a = Math.abs(n);
  if (a === 1) return one;
  if (a >= 2 && a <= 4) return few;
  return many;
}

function agoDays(n) {
  if (n === 0) return 'dnes';
  return n === 1 ? 'před 1 dnem' : `před ${n} dny`;
}

function isDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// The server runs in UTC and the user lives in Prague, so state.today is the
// only trustworthy "dnes". The Intl fallback is for tests / stray callers.
function todayOf(state) {
  if (state && isDate(state.today)) return state.today;
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
  } catch (e) {
    return new Date().toISOString().slice(0, 10);
  }
}

// Noon UTC survives every timezone shift, so date arithmetic never slips a day.
function dParse(s) {
  return new Date(`${s}T12:00:00Z`);
}

function shiftDate(dateStr, delta) {
  const d = dParse(dateStr);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromStr, toStr) {
  return Math.round((dParse(toStr) - dParse(fromStr)) / 86400000);
}

function dayKeyForDate(dateStr) {
  const d = isDate(dateStr) ? dParse(dateStr) : new Date();
  return DAY_KEYS[(d.getUTCDay() + 6) % 7];
}

function normDayKey(k) {
  if (!k) return null;
  const s = String(k).toLowerCase().trim();
  if (DAY_KEYS.includes(s)) return s;
  const map = {
    'pondeli': 'mon', 'pondělí': 'mon', 'po': 'mon', 'monday': 'mon',
    'utery': 'tue', 'úterý': 'tue', 'ut': 'tue', 'út': 'tue', 'tuesday': 'tue',
    'streda': 'wed', 'středa': 'wed', 'st': 'wed', 'wednesday': 'wed',
    'ctvrtek': 'thu', 'čtvrtek': 'thu', 'ct': 'thu', 'čt': 'thu', 'thursday': 'thu',
    'patek': 'fri', 'pátek': 'fri', 'pa': 'fri', 'pá': 'fri', 'friday': 'fri',
    'sobota': 'sat', 'so': 'sat', 'saturday': 'sat',
    'nedele': 'sun', 'neděle': 'sun', 'ne': 'sun', 'sunday': 'sun'
  };
  return map[s] || null;
}

// Window of dates ending today, oldest first.
function windowDates(today, days) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(shiftDate(today, -i));
  return out;
}

function normName(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// "150g" -> 150, "2 plátky (40g)" -> 40, "1 ks" -> null.
function parseGrams(str) {
  const s = String(str || '');
  const paren = s.match(/\((\d+(?:[.,]\d+)?)\s*(g|ml|kg|l)\)/i);
  const m = paren || s.match(/(\d+(?:[.,]\d+)?)\s*(g|ml|kg|l)\b/i);
  if (!m) return null;
  const v = parseFloat(m[1].replace(',', '.'));
  if (!Number.isFinite(v) || v <= 0) return null;
  const unit = m[2].toLowerCase();
  return (unit === 'kg' || unit === 'l') ? v * 1000 : v;
}

// ---------------------------------------------------------------------------
// State readers — every one of them is defensive; the client sends whatever
// it has and half the fields are optional.
// ---------------------------------------------------------------------------

function logsOf(state) {
  return (state.logs && typeof state.logs === 'object') ? state.logs : {};
}

function itemsOn(state, date) {
  const l = logsOf(state)[date];
  return Array.isArray(l) ? l.filter((x) => x && typeof x === 'object') : [];
}

function totalsOn(state, date) {
  return itemsOn(state, date).reduce((s, i) => ({
    calories: s.calories + num(i.calories),
    protein: s.protein + num(i.protein),
    carbs: s.carbs + num(i.carbs),
    fat: s.fat + num(i.fat)
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
}

function targetsOf(state) {
  const t = state.targets || {};
  return {
    calories: r0(num(t.calories, 0)),
    protein: r0(num(t.protein, 0)),
    carbs: r0(num(t.carbs, 0)),
    fat: r0(num(t.fat, 0))
  };
}

function hasCalorieTarget(state) {
  return num((state.targets || {}).calories, 0) > 0;
}

// Weigh-ins normalised to oldest-first and deduplicated per day (state keeps
// them newest-first, so the first entry for a date is the freshest one).
function weighIns(state) {
  const arr = Array.isArray(state.weightLogs) ? state.weightLogs : [];
  const seen = new Set();
  const out = [];
  arr.forEach((w) => {
    if (!w || !isDate(w.date)) return;
    const kg = num(w.weight, 0);
    if (kg <= 0 || kg > 500) return;
    if (seen.has(w.date)) return;
    seen.add(w.date);
    out.push({ date: w.date, weight: r1(kg) });
  });
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

function weighInsBetween(state, fromStr, toStr) {
  return weighIns(state).filter((w) => w.date >= fromStr && w.date <= toStr);
}

function workoutLogsOf(state) {
  return (state.workoutLogs && typeof state.workoutLogs === 'object') ? state.workoutLogs : {};
}

function doneIdsOn(state, date) {
  const l = workoutLogsOf(state)[date];
  return (l && Array.isArray(l.done)) ? l.done.filter(Boolean) : [];
}

function plannedDayFor(state, date) {
  const plan = state.workoutPlan;
  if (!plan || !plan.days) return null;
  const d = plan.days[dayKeyForDate(date)];
  if (!d) return null;
  const exercises = Array.isArray(d.exercises) ? d.exercises.filter((e) => e && e.name) : [];
  return { title: d.title || 'Trénink', rest: !!d.rest || !exercises.length, focus: d.focus || '', exercises };
}

function normSession(s) {
  if (!s || !isDate(s.date)) return null;
  const sets = (Array.isArray(s.sets) ? s.sets : [])
    .map((x) => ({ w: r1(num(x && x.w, 0)), r: r0(num(x && x.r, 0)) }))
    .filter((x) => x.w > 0 && x.r > 0);
  if (!sets.length) return null;
  return { date: s.date, sets };
}

// All exercises that actually have logged sets, sessions sorted oldest-first.
function exerciseEntries(state) {
  const logs = (state.exerciseLogs && typeof state.exerciseLogs === 'object') ? state.exerciseLogs : {};
  return Object.keys(logs).map((key) => {
    const e = logs[key];
    if (!e) return null;
    const sessions = (Array.isArray(e.sessions) ? e.sessions : [])
      .map(normSession).filter(Boolean)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!sessions.length) return null;
    return { key, name: String(e.name || key), sessions };
  }).filter(Boolean);
}

function findExerciseEntry(state, name) {
  const q = normName(name);
  if (!q) return null;
  const all = exerciseEntries(state);
  return all.find((e) => e.key === q)
    || all.find((e) => normName(e.name) === q)
    || all.find((e) => normName(e.name).includes(q) || q.includes(normName(e.name)))
    || null;
}

function sessionVolume(s) {
  return s.sets.reduce((t, x) => t + x.w * x.r, 0);
}

function topSetOf(s) {
  return s.sets.reduce((b, x) => ((x.w > b.w || (x.w === b.w && x.r > b.r)) ? x : b), s.sets[0]);
}

function fmtSets(s) {
  return s.sets.map((x) => `${cz(x.w)}kg×${x.r}`).join(', ');
}

// A day counts as trained when something was ticked off in the plan or any set
// was logged — the app's own history uses the same two signals.
function trainedOn(state, date) {
  if (doneIdsOn(state, date).length) return true;
  return exerciseEntries(state).some((e) => e.sessions.some((s) => s.date === date));
}

// Stricter version for adherence: half the planned exercises is the app's own
// threshold for "trénink splněn".
function plannedWorkoutDone(state, date) {
  const day = plannedDayFor(state, date);
  if (!day || day.rest) return null; // nothing was planned → not counted either way
  const done = doneIdsOn(state, date).length;
  if (done >= Math.ceil(day.exercises.length / 2)) return true;
  // Sets logged that day still count — the user may log lifts without ticking.
  const logged = exerciseEntries(state).filter((e) => e.sessions.some((s) => s.date === date)).length;
  return logged >= Math.ceil(day.exercises.length / 2);
}

function isBigLift(name) {
  const n = normName(name);
  return BIG_LIFT_HINTS.some((h) => n.includes(h));
}

// "8-12" -> {lo:8, hi:12}, "5" -> {lo:5, hi:5}
function parseRepRange(reps) {
  const s = String(reps || '');
  const range = s.match(/(\d+)\s*[-–—]\s*(\d+)/);
  if (range) return { lo: Number(range[1]), hi: Number(range[2]) };
  const one = s.match(/(\d+)/);
  if (one) return { lo: Number(one[1]), hi: Number(one[1]) };
  return { lo: 8, hi: 12 };
}

// Mifflin-St Jeor, identical to the plan layer.
function mifflinStJeor(p) {
  const base = 10 * num(p.weightKg, 70) + 6.25 * num(p.heightCm, 175) - 5 * num(p.age, 25);
  return Math.round(base + (p.sex === 'female' ? -161 : 5));
}

// Reproduction of plans.js computeTargets, with the reasoning trail kept as
// text steps so explain_number can show the work instead of hand-waving.
function targetsWithSteps(profile) {
  const p = profile || {};
  const weightKg = num(p.weightKg, 70);
  const age = num(p.age, 25);
  const goal = ['recomp', 'cut', 'bulk'].includes(p.goal) ? p.goal : 'recomp';
  const sexSign = p.sex === 'female' ? -161 : 5;

  const bmr = mifflinStJeor(p);
  const days = clamp(Math.round(num(p.trainingDaysPerWeek, 3)), 0, 7);
  const factor = num(p.activityFactor, 0) || ACTIVITY_FACTORS[days] || 1.5;
  const tdee = Math.round(bmr * factor);

  const adjust = GOAL_ADJUST[goal];
  let calories = Math.round(tdee * adjust);

  const isTeen = age > 0 && age < 18;
  const floor = isTeen ? Math.round(bmr * 1.3) : Math.round(bmr * 1.1);
  const floored = calories < floor;
  const beforeFloor = calories;
  if (floored) calories = floor;
  calories = Math.round(calories / 10) * 10;

  const proteinPerKg = GOAL_PROTEIN[goal];
  const protein = Math.round(weightKg * proteinPerKg);
  const fat = Math.round(weightKg * 0.9);
  const carbs = Math.max(50, Math.round((calories - protein * 4 - fat * 9) / 4));

  const steps = [
    `1) Bazální metabolismus (Mifflin-St Jeor): 10×${cz(weightKg)} kg + 6,25×${cz(num(p.heightCm, 175))} cm − 5×${age} let ${sexSign < 0 ? '−161' : '+5'} = ${bmr} kcal`,
    `2) Aktivitní faktor podle ${days} tréninků týdně: ×${cz(factor)} → celkový výdej ${tdee} kcal`,
    `3) Úprava podle cíle (${GOAL_CZ[goal]}): ×${cz(adjust)} → ${beforeFloor} kcal`
  ];
  if (floored) {
    steps.push(`4) Růstové minimum (${isTeen ? 'do 18 let' : 'bezpečné dno'}) = ${isTeen ? '1,3' : '1,1'}× BMR = ${floor} kcal — zvednuto na něj`);
  }
  steps.push(`${floored ? 5 : 4}) Zaokrouhleno na desítky: ${calories} kcal`);
  steps.push(`Bílkoviny: ${cz(weightKg)} kg × ${cz(proteinPerKg)} g/kg = ${protein} g`);
  steps.push(`Tuky: ${cz(weightKg)} kg × 0,9 g/kg = ${fat} g`);
  steps.push(`Sacharidy = zbytek: (${calories} − ${protein}×4 − ${fat}×9) ÷ 4 = ${carbs} g`);

  return {
    calories, protein, carbs, fat,
    bmr, tdee, activityFactor: factor, goal, trainingDaysPerWeek: days,
    flooredForGrowth: floored, floor, steps
  };
}

// Every food item the user has logged, aggregated by name, plus favourites.
function foodIndex(state, dates) {
  const index = new Map();
  const add = (item, date) => {
    const name = String(item.name || '').trim();
    const key = normName(name);
    if (!key) return;
    let e = index.get(key);
    if (!e) {
      e = {
        key, name, count: 0, source: 'log',
        calories: 0, protein: 0, carbs: 0, fat: 0,
        amounts: new Map(), lastDate: null
      };
      index.set(key, e);
    }
    e.count += 1;
    e.calories += num(item.calories);
    e.protein += num(item.protein);
    e.carbs += num(item.carbs);
    e.fat += num(item.fat);
    const amt = String(item.amount || '').trim();
    if (amt) e.amounts.set(amt, (e.amounts.get(amt) || 0) + 1);
    if (date && (!e.lastDate || date > e.lastDate)) e.lastDate = date;
  };

  (dates || []).forEach((d) => itemsOn(state, d).forEach((i) => add(i, d)));

  // Favourites fill in foods the user keeps but hasn't logged in this window.
  (Array.isArray(state.favorites) ? state.favorites : []).forEach((f) => {
    if (!f || !f.name) return;
    const key = normName(f.name);
    if (index.has(key)) return;
    index.set(key, {
      key, name: String(f.name), count: 0, source: 'favorite',
      calories: num(f.calories), protein: num(f.protein), carbs: num(f.carbs), fat: num(f.fat),
      amounts: new Map(f.amount ? [[String(f.amount), 1]] : []), lastDate: null
    });
  });

  return index;
}

function foodStats(entry) {
  const n = Math.max(1, entry.count);
  const amounts = Array.from(entry.amounts.entries()).sort((a, b) => b[1] - a[1]);
  return {
    name: entry.name,
    source: entry.source,
    count: entry.count,
    lastDate: entry.lastDate,
    typicalAmount: amounts.length ? amounts[0][0] : null,
    calories: r0(entry.calories / n),
    protein: r1(entry.protein / n),
    carbs: r1(entry.carbs / n),
    fat: r1(entry.fat / n)
  };
}

function findFood(index, name) {
  const q = normName(name);
  if (!q) return null;
  if (index.has(q)) return index.get(q);
  let best = null;
  index.forEach((e) => {
    if (best) return;
    if (e.key.includes(q) || q.includes(e.key)) best = e;
  });
  return best;
}

// 7-day moving average over sparse weigh-ins: each point is the mean of every
// weigh-in in the preceding week, which is what kills day-to-day water noise.
function movingAverage(points, windowDays) {
  return points.map((p, i) => {
    const from = shiftDate(p.date, -(windowDays - 1));
    const bucket = [];
    for (let j = i; j >= 0; j--) {
      if (points[j].date < from) break;
      bucket.push(points[j].weight);
    }
    return { date: p.date, weight: p.weight, avg: r1(avg(bucket)), samples: bucket.length };
  });
}

// kg per week between the first and last smoothed point. Returns null when the
// span is too short to mean anything.
function weeklyRate(smoothed) {
  if (smoothed.length < 2) return null;
  const first = smoothed[0];
  const last = smoothed[smoothed.length - 1];
  const span = daysBetween(first.date, last.date);
  if (span < 1) return null;
  return { rate: r1(((last.avg - first.avg) / span) * 7), spanDays: span, from: first, to: last };
}

// The goal weight lives on the client (appState.weightTarget); accept every
// place it might arrive from, plus an explicit argument from the model.
function goalWeightOf(state, arg) {
  const candidates = [
    arg,
    state.weightTarget,
    state.profile && state.profile.weightTarget,
    state.profile && state.profile.targetWeightKg
  ];
  for (const c of candidates) {
    const v = num(c, 0);
    if (v >= 30 && v <= 400) return r1(v);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Gemini tool declarations
// ---------------------------------------------------------------------------

const DAYS_PARAM = { type: 'INTEGER', description: 'Za kolik posledních dní počítat (1-90). Když neuvedeš, použije se 7.' };

const STATS_TOOLS = [
  {
    name: 'get_progress_summary',
    description: 'Souhrn za období: průměrné kalorie a makra, kolik dní bylo zapsáno, změna váhy, počet tréninků a celkový objem. Použij, když se uživatel ptá „jak mi to jde" nebo chceš na začátku hovoru vědět, kde je. Když chceš srovnat dvě období proti sobě, použij compare_periods; když chceš procenta dodržování, get_adherence.',
    parameters: {
      type: 'OBJECT',
      properties: { days: DAYS_PARAM }
    }
  },
  {
    name: 'get_exercise_history',
    description: 'Kompletní historie jednoho cviku: všechny odcvičené série po datech, nejlepší série, nejlepší objem a trend. Použij, když se uživatel ptá na konkrétní cvik („jak mi jde bench"). Pro odhad maxima použij estimate_1rm, pro přehled objemu všech cviků get_volume_stats.',
    parameters: {
      type: 'OBJECT',
      properties: {
        exerciseName: { type: 'STRING', description: 'Název cviku tak, jak ho uživatel řekl, např. "bench press"' }
      },
      required: ['exerciseName']
    }
  },
  {
    name: 'estimate_1rm',
    description: 'Odhadne jednorepové maximum (1RM) z nejlepší zapsané série podle Epleyho vzorce váha×(1+opakování/30) a vrátí i tréninkové váhy na procenta. Použij, když se uživatel ptá „kolik bych dal na jednu" nebo chceš nastavit procenta. Nezaměňuj s get_exercise_history, ten vrací celý průběh.',
    parameters: {
      type: 'OBJECT',
      properties: {
        exerciseName: { type: 'STRING', description: 'Název cviku' }
      },
      required: ['exerciseName']
    }
  },
  {
    name: 'get_volume_stats',
    description: 'Celkový objem (váha × opakování) po jednotlivých cvicích za období, seřazeno od největšího. Použij, když chceš vidět, kam jde nejvíc práce, nebo jestli objem klesá. Pro jeden cvik do detailu použij get_exercise_history.',
    parameters: {
      type: 'OBJECT',
      properties: { days: { type: 'INTEGER', description: 'Za kolik posledních dní (1-365). Výchozí 28.' } }
    }
  },
  {
    name: 'detect_stagnation',
    description: 'Najde cviky, které stojí na stejné váze tři a víc tréninků po sobě, a řekne, jak dlouho. Použij, když uživatel řekne, že se nikam nehne, nebo než navrhneš změnu programu. Pro návrh konkrétních vah na příští trénink použij plan_next_session.',
    parameters: {
      type: 'OBJECT',
      properties: {
        minSessions: { type: 'INTEGER', description: 'Kolik tréninků bez posunu už bereš jako stagnaci (2-10). Výchozí 3.' }
      }
    }
  },
  {
    name: 'plan_next_session',
    description: 'Navrhne váhy na příští trénink konkrétního dne podle zapsané historie — kdo splnil horní hranici opakování, dostane +2,5 kg (u velkých cviků +5 kg). Použij, když se uživatel ptá „co mám dneska dát". Nic nezapisuje, je to jen návrh.',
    parameters: {
      type: 'OBJECT',
      properties: {
        dayKey: { type: 'STRING', enum: DAY_KEYS, description: 'Den v týdnu. Když neuvedeš, bere se dnešek.' }
      }
    }
  },
  {
    name: 'get_weight_trend',
    description: 'Vývoj váhy přes sedmidenní klouzavý průměr (ne syrová čísla, ta skáčou podle vody) a rychlost změny v kg za týden. Použij vždy, když se mluví o hubnutí nebo nabírání. Pro odhad, kdy bude uživatel na cíli, použij predict_goal_date.',
    parameters: {
      type: 'OBJECT',
      properties: { days: { type: 'INTEGER', description: 'Za kolik posledních dní (7-365). Výchozí 30.' } }
    }
  },
  {
    name: 'predict_goal_date',
    description: 'Odhadne datum, kdy uživatel při současném tempu dosáhne cílové váhy. Když tempo míří opačným směrem nebo se váha nehýbe, žádné datum nevymýšlí a řekne to na rovinu. Použij jen když se uživatel ptá na „kdy" — na samotné tempo stačí get_weight_trend.',
    parameters: {
      type: 'OBJECT',
      properties: {
        targetWeightKg: { type: 'NUMBER', description: 'Cílová váha v kg. Uveď jen když ji aplikace nezná a uživatel ti ji řekl v chatu.' }
      }
    }
  },
  {
    name: 'compare_periods',
    description: 'Porovná poslední období s předchozím stejně dlouhým: kalorie, bílkoviny, váha, tréninky, objem. Použij na otázky typu „je to lepší než minulý týden". Pro absolutní čísla za jedno období použij get_progress_summary.',
    parameters: {
      type: 'OBJECT',
      properties: { days: { type: 'INTEGER', description: 'Délka jednoho období ve dnech (1-45). Výchozí 7.' } }
    }
  },
  {
    name: 'get_adherence',
    description: 'Procenta dodržování: kolik procent dní bylo v kalorickém cíli (±150 kcal), kolik procent dní vůbec zapsaných a kolik naplánovaných tréninků odcvičených. Použij, když jde o disciplínu a pravidelnost, ne o samotná čísla příjmu.',
    parameters: {
      type: 'OBJECT',
      properties: { days: { type: 'INTEGER', description: 'Za kolik posledních dní (1-90). Výchozí 14.' } }
    }
  },
  {
    name: 'get_streak',
    description: 'Aktuální série: kolik dní v řadě uživatel zapisuje jídlo, nejdelší série za 90 dní, kolik naplánovaných tréninků po sobě splnil a kdy trénoval naposledy. Použij na povzbuzení nebo když se ptá „kolik už mi to jede".',
    parameters: { type: 'OBJECT', properties: {} }
  },
  {
    name: 'find_patterns',
    description: 'Vzorce, které jsou opravdu vidět v číslech: víkend vs. všední dny, které dny bývají přes cíl, které dny nejčastěji chybí zápis. Vrací jen to, co má dost opakování — nic nedomýšlí. Použij, když chceš uživateli ukázat, kde se to láme.',
    parameters: {
      type: 'OBJECT',
      properties: { days: { type: 'INTEGER', description: 'Za kolik posledních dní hledat (7-90). Výchozí 30.' } }
    }
  },
  {
    name: 'get_macro_breakdown',
    description: 'Rozpad maker za období v gramech i v procentech energie a srovnání s cílem. Použij, když jde o poměr bílkovin/sacharidů/tuků. Pro samotné kalorie a shrnutí použij get_progress_summary.',
    parameters: {
      type: 'OBJECT',
      properties: { days: DAYS_PARAM }
    }
  },
  {
    name: 'get_most_eaten',
    description: 'Nejčastěji zapisovaná jídla za období s počtem výskytů a průměrnými makry. Použij, když chceš stavět jídelníček z toho, co uživatel reálně jí, nebo najít, co mu žere kalorie.',
    parameters: {
      type: 'OBJECT',
      properties: {
        days: { type: 'INTEGER', description: 'Za kolik posledních dní (1-90). Výchozí 30.' },
        limit: { type: 'INTEGER', description: 'Kolik jídel vrátit (1-20). Výchozí 8.' }
      }
    }
  },
  {
    name: 'get_day_detail',
    description: 'Detail jednoho konkrétního dne: všechna jídla s časy a makry, součty proti cíli, voda, trénink a případné vážení. Použij, když se řeší konkrétní den („co jsem měl ve středu").',
    parameters: {
      type: 'OBJECT',
      properties: {
        date: { type: 'STRING', description: 'Datum ve tvaru YYYY-MM-DD, nebo "dnes" / "včera".' }
      },
      required: ['date']
    }
  },
  {
    name: 'find_best_day',
    description: 'Najde nejlepší den v období a řekne čím — nejblíž kalorickému cíli, splněné bílkoviny, odcvičený trénink. Použij na konkrétní pochvalu místo obecného „jde ti to".',
    parameters: {
      type: 'OBJECT',
      properties: { days: { type: 'INTEGER', description: 'Za kolik posledních dní (1-90). Výchozí 14.' } }
    }
  },
  {
    name: 'estimate_tdee_from_data',
    description: 'Spočítá skutečný denní výdej z reálných dat: průměrný příjem plus změna váhy (1 kg ≈ 7700 kcal). Potřebuje aspoň 14 zapsaných dní a 2 vážení, jinak vrátí ok:false. Tohle je měřený výdej — vzorcový odhad z profilu dá explain_number.',
    parameters: { type: 'OBJECT', properties: {} }
  },
  {
    name: 'explain_number',
    description: 'Vysvětlí, jak aplikace došla ke svým číslům — kalorie, bílkoviny nebo celé cíle — krok po kroku (Mifflin-St Jeor + aktivitní faktor + úprava podle cíle). Použij, když se uživatel ptá „proč zrovna tolik". Neplete se s estimate_tdee_from_data, ten počítá z naměřených dat, ne ze vzorce.',
    parameters: {
      type: 'OBJECT',
      properties: {
        what: { type: 'STRING', description: 'Co vysvětlit: "calories", "protein" nebo "targets" (všechno).' }
      },
      required: ['what']
    }
  },
  {
    name: 'compare_two_foods',
    description: 'Porovná dvě jídla z historie zápisů nebo z oblíbených: kalorie, makra, hustota bílkovin a co je vzhledem k cíli lepší volba. Použij na otázky „co je lepší, A nebo B" o jídlech, která už uživatel zná.',
    parameters: {
      type: 'OBJECT',
      properties: {
        nameA: { type: 'STRING', description: 'První jídlo' },
        nameB: { type: 'STRING', description: 'Druhé jídlo' }
      },
      required: ['nameA', 'nameB']
    }
  }
];

const STATS_TOOL_NAMES = new Set(STATS_TOOLS.map((t) => t.name));

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

// Shared preamble: window of dates + which of them have any food logged.
function loggedWindow(state, days) {
  const today = todayOf(state);
  const dates = windowDates(today, days);
  const logged = dates.filter((d) => itemsOn(state, d).length > 0);
  return { today, dates, logged };
}

function sampleWarning(loggedCount, askedDays) {
  if (loggedCount === 0) return 'Za tohle období není zapsaný ani jeden den, takže se nedá říct nic.';
  if (loggedCount < 4) return `Vzorek je malý (${loggedCount} ${loggedCount === 1 ? 'den' : 'dny'}), ber závěr jen orientačně.`;
  if (loggedCount < askedDays / 2) return `Zapsaná je jen část období (${loggedCount} z ${askedDays} dní), průměry můžou být zkreslené.`;
  return null;
}

function toolProgressSummary(a, state) {
  const days = clamp(r0(num(a.days, 7)), 1, 90);
  const { today, dates, logged } = loggedWindow(state, days);
  const t = targetsOf(state);

  const totals = logged.map((d) => totalsOn(state, d));
  const avgCal = r0(avg(totals.map((x) => x.calories)));
  const avgP = r0(avg(totals.map((x) => x.protein)));
  const avgC = r0(avg(totals.map((x) => x.carbs)));
  const avgF = r0(avg(totals.map((x) => x.fat)));

  const w = weighInsBetween(state, dates[0], today);
  let weight = null;
  if (w.length >= 1) {
    weight = {
      weighIns: w.length,
      first: w[0].weight,
      last: w[w.length - 1].weight,
      change: w.length >= 2 ? r1(w[w.length - 1].weight - w[0].weight) : null,
      fromDate: w[0].date,
      toDate: w[w.length - 1].date
    };
  }

  const workouts = dates.filter((d) => trainedOn(state, d)).length;
  let volume = 0;
  exerciseEntries(state).forEach((e) => e.sessions.forEach((s) => {
    if (s.date >= dates[0] && s.date <= today) volume += sessionVolume(s);
  }));

  const warn = sampleWarning(logged.length, days);
  const parts = [];
  if (logged.length) {
    parts.push(`Za ${days} dní zapsáno ${logged.length} dní, průměr ${avgCal} kcal${t.calories ? ` (cíl ${t.calories}, rozdíl ${avgCal - t.calories > 0 ? '+' : ''}${avgCal - t.calories})` : ''}, bílkoviny ${avgP} g.`);
  } else {
    parts.push(`Za posledních ${days} dní není zapsaný žádný den jídla.`);
  }
  if (weight && weight.change != null) {
    parts.push(`Váha ${weight.change > 0 ? '+' : ''}${cz(weight.change)} kg (${cz(weight.first)} → ${cz(weight.last)} kg, ${weight.weighIns} vážení).`);
  } else if (weight) {
    parts.push(`Jen jedno vážení (${cz(weight.last)} kg), změna se nedá spočítat.`);
  }
  parts.push(`Tréninků ${workouts}, objem ${r0(volume)} kg.`);
  if (warn) parts.push(warn);

  return {
    ok: true,
    days,
    from: dates[0],
    to: today,
    hasData: logged.length > 0,
    loggedDays: logged.length,
    coveragePct: pct(logged.length, days),
    average: { calories: avgCal, protein: avgP, carbs: avgC, fat: avgF },
    targets: t.calories ? t : null,
    calorieDiff: t.calories && logged.length ? avgCal - t.calories : null,
    weight,
    workouts,
    totalVolume: r0(volume),
    weakSample: !!warn,
    note: parts.join(' ')
  };
}

function toolExerciseHistory(a, state) {
  const name = String(a.exerciseName || '').trim();
  if (!name) return { ok: false, error: 'Chybí název cviku.' };
  const entry = findExerciseEntry(state, name);
  if (!entry) {
    const known = exerciseEntries(state).map((e) => e.name).slice(0, 12);
    return {
      ok: false,
      error: known.length
        ? `Cvik "${name}" nemám v historii. Zapsané cviky: ${known.join(', ')}.`
        : `Cvik "${name}" nemám v historii — zatím nejsou zapsané žádné série.`
    };
  }

  const today = todayOf(state);
  const sessions = entry.sessions.slice(-20).map((s) => ({
    date: s.date,
    sets: fmtSets(s),
    topSet: `${cz(topSetOf(s).w)}kg×${topSetOf(s).r}`,
    topWeight: topSetOf(s).w,
    volume: r0(sessionVolume(s))
  }));

  let best = { w: 0, r: 0, date: null };
  entry.sessions.forEach((s) => s.sets.forEach((x) => {
    if (x.w > best.w || (x.w === best.w && x.r > best.r)) best = { w: x.w, r: x.r, date: s.date };
  }));
  const bestVolume = entry.sessions.reduce((b, s) => (sessionVolume(s) > sessionVolume(b) ? s : b), entry.sessions[0]);

  // Trend: first vs last top weight, but only stated as a trend once there are
  // at least three sessions — two points are a coincidence, not a direction.
  const firstTop = topSetOf(entry.sessions[0]).w;
  const lastTop = topSetOf(entry.sessions[entry.sessions.length - 1]).w;
  const diff = r1(lastTop - firstTop);
  let trend = 'málo dat';
  if (entry.sessions.length >= 3) {
    if (diff > 0) trend = 'roste';
    else if (diff < 0) trend = 'klesá';
    else trend = 'stojí';
  }
  const lastDate = entry.sessions[entry.sessions.length - 1].date;
  const sinceDays = daysBetween(lastDate, today);
  const weak = entry.sessions.length < 3;

  return {
    ok: true,
    exercise: entry.name,
    sessionCount: entry.sessions.length,
    sessions,
    best: { weight: best.w, reps: best.r, date: best.date },
    bestVolumeSession: { date: bestVolume.date, volume: r0(sessionVolume(bestVolume)) },
    firstTopWeight: firstTop,
    lastTopWeight: lastTop,
    changeKg: diff,
    trend,
    lastSessionDate: lastDate,
    daysSinceLastSession: sinceDays,
    weakSample: weak,
    note: `${entry.name}: ${entry.sessions.length} ${plural(entry.sessions.length, 'zápis', 'zápisy', 'zápisů')}, nejlepší série ${cz(best.w)} kg × ${best.r} (${best.date}), poslední trénink ${lastDate} (${agoDays(sinceDays)}). `
      + (weak
        ? 'Na trend je to zatím málo dat.'
        : `Od prvního zápisu ${diff > 0 ? '+' : ''}${cz(diff)} kg na top sérii — ${trend}.`)
  };
}

function toolEstimate1rm(a, state) {
  const name = String(a.exerciseName || '').trim();
  if (!name) return { ok: false, error: 'Chybí název cviku.' };
  const entry = findExerciseEntry(state, name);
  if (!entry) {
    const known = exerciseEntries(state).map((e) => e.name).slice(0, 12);
    return {
      ok: false,
      error: known.length
        ? `Cvik "${name}" nemám v historii, 1RM není z čeho spočítat. Zapsané cviky: ${known.join(', ')}.`
        : `Cvik "${name}" nemám v historii — nejsou zapsané žádné série.`
    };
  }

  // Best set = the one with the highest Epley estimate, not simply the heaviest:
  // 100×3 beats 105×1 and the formula should reflect that.
  let bestSet = null;
  entry.sessions.forEach((s) => s.sets.forEach((x) => {
    const e = x.w * (1 + x.r / 30);
    if (!bestSet || e > bestSet.est) bestSet = { w: x.w, r: x.r, date: s.date, est: e };
  }));
  if (!bestSet) return { ok: false, error: `U cviku "${entry.name}" nejsou žádné platné série.` };

  const e1rm = r1(bestSet.est);
  const half = (x) => Math.round(x * 2) / 2;
  const today = todayOf(state);
  const age = daysBetween(bestSet.date, today);
  const warnings = [];
  if (bestSet.r > 10) warnings.push(`Série měla ${bestSet.r} opakování — Epley je nad 10 opakováními nepřesný, skutečné maximum bude nejspíš níž.`);
  if (age > 60) warnings.push(`Nejlepší série je stará ${age} dní, číslo nemusí platit.`);
  if (entry.sessions.length < 2) warnings.push('Je to z jediného tréninku, ber to jako hrubý odhad.');

  return {
    ok: true,
    exercise: entry.name,
    estimated1RM: e1rm,
    formula: 'Epley: váha × (1 + opakování / 30)',
    basedOn: { weight: bestSet.w, reps: bestSet.r, date: bestSet.date },
    calculation: `${cz(bestSet.w)} × (1 + ${bestSet.r}/30) = ${cz(e1rm)} kg`,
    workingWeights: {
      '95%': half(e1rm * 0.95), '90%': half(e1rm * 0.9), '85%': half(e1rm * 0.85),
      '80%': half(e1rm * 0.8), '75%': half(e1rm * 0.75), '70%': half(e1rm * 0.7)
    },
    weakSample: warnings.length > 0,
    warnings,
    note: `Odhad 1RM u ${entry.name} je ${cz(e1rm)} kg — počítáno z nejlepší série ${cz(bestSet.w)} kg × ${bestSet.r} z ${bestSet.date} (Epley).`
      + (warnings.length ? ' ' + warnings.join(' ') : '')
  };
}

function toolVolumeStats(a, state) {
  const days = clamp(r0(num(a.days, 28)), 1, 365);
  const today = todayOf(state);
  const from = shiftDate(today, -(days - 1));

  const rows = [];
  exerciseEntries(state).forEach((e) => {
    const inRange = e.sessions.filter((s) => s.date >= from && s.date <= today);
    if (!inRange.length) return;
    const volume = inRange.reduce((t, s) => t + sessionVolume(s), 0);
    const sets = inRange.reduce((t, s) => t + s.sets.length, 0);
    const heaviest = inRange.reduce((b, s) => {
      const t = topSetOf(s);
      return (!b || t.w > b.w) ? t : b;
    }, null);
    rows.push({
      exercise: e.name,
      volume: r0(volume),
      sessions: inRange.length,
      sets,
      topWeight: heaviest ? heaviest.w : 0,
      lastDate: inRange[inRange.length - 1].date
    });
  });
  rows.sort((x, y) => y.volume - x.volume);

  const total = rows.reduce((t, r) => t + r.volume, 0);
  const trainingDays = new Set();
  exerciseEntries(state).forEach((e) => e.sessions.forEach((s) => {
    if (s.date >= from && s.date <= today) trainingDays.add(s.date);
  }));

  if (!rows.length) {
    return {
      ok: true, days, from, to: today, hasData: false, exercises: [], totalVolume: 0,
      trainingDays: 0, weakSample: true,
      note: `Za posledních ${days} dní nejsou zapsané žádné série, objem se nedá spočítat.`
    };
  }

  const top = rows.slice(0, 3).map((r) => `${r.exercise} ${r.volume} kg`).join(', ');
  return {
    ok: true,
    days, from, to: today,
    hasData: true,
    exercises: rows,
    totalVolume: r0(total),
    trainingDays: trainingDays.size,
    weakSample: trainingDays.size < 3,
    note: `Za ${days} dní ${trainingDays.size} tréninkových dní a celkový objem ${r0(total)} kg. Nejvíc práce: ${top}.`
      + (trainingDays.size < 3 ? ' Jsou to jen dva až tři tréninky, na závěry je to málo.' : '')
  };
}

function toolDetectStagnation(a, state) {
  const minSessions = clamp(r0(num(a.minSessions, 3)), 2, 10);
  const today = todayOf(state);
  const stalled = [];
  const idle = [];

  exerciseEntries(state).forEach((e) => {
    const tops = e.sessions.map((s) => ({ date: s.date, w: topSetOf(s).w, reps: topSetOf(s).r }));
    const last = tops[tops.length - 1];
    const sinceDays = daysBetween(last.date, today);

    // An exercise nobody has touched for a month is not stalling, it is missing
    // from the plan — saying "stagnuješ" about it would be wrong.
    if (sinceDays > 30) {
      idle.push({ exercise: e.name, lastDate: last.date, daysSince: sinceDays, lastWeight: last.w });
      return;
    }

    let streak = 1;
    for (let i = tops.length - 2; i >= 0; i--) {
      if (tops[i].w === last.w) streak++;
      else break;
    }
    if (streak >= minSessions) {
      const firstOfStreak = tops[tops.length - streak];
      stalled.push({
        exercise: e.name,
        weight: last.w,
        sessions: streak,
        sinceDate: firstOfStreak.date,
        daysStuck: daysBetween(firstOfStreak.date, last.date),
        lastDate: last.date,
        lastReps: last.reps
      });
    }
  });

  stalled.sort((x, y) => y.sessions - x.sessions);

  const totalTracked = exerciseEntries(state).length;
  if (!totalTracked) {
    return {
      ok: true, hasData: false, stalled: [], notTrainedRecently: idle, minSessions, weakSample: true,
      note: 'Zatím nejsou zapsané žádné série, takže stagnaci není kde hledat.'
    };
  }
  if (!stalled.length) {
    return {
      ok: true, hasData: true, stalled: [], notTrainedRecently: idle, minSessions,
      trackedExercises: totalTracked, weakSample: false,
      note: `Žádný cvik nestojí na stejné váze ${minSessions} tréninky po sobě (kontrolováno ${totalTracked} cviků).`
        + (idle.length ? ` ${idle.length} cviků jsi netrénoval přes měsíc.` : '')
    };
  }

  const head = stalled.slice(0, 3)
    .map((s) => `${s.exercise} ${cz(s.weight)} kg (${s.sessions} ${plural(s.sessions, 'trénink', 'tréninky', 'tréninků')}, ${s.daysStuck} dní)`)
    .join(', ');
  return {
    ok: true,
    hasData: true,
    minSessions,
    trackedExercises: totalTracked,
    stalled,
    notTrainedRecently: idle,
    weakSample: false,
    note: `${plural(stalled.length, 'Stagnuje', 'Stagnují', 'Stagnuje')} ${stalled.length} ${plural(stalled.length, 'cvik', 'cviky', 'cviků')}: ${head}.`
  };
}

function toolPlanNextSession(a, state) {
  const today = todayOf(state);
  const key = a.dayKey ? normDayKey(a.dayKey) : dayKeyForDate(today);
  if (!key) return { ok: false, error: `Neznámý den "${a.dayKey}". Použij pondělí až neděle.` };
  const plan = state.workoutPlan;
  if (!plan || !plan.days || !plan.days[key]) {
    return { ok: false, error: 'Tréninkový plán zatím neexistuje, není z čeho navrhovat váhy.' };
  }
  const day = plan.days[key];
  const exercises = Array.isArray(day.exercises) ? day.exercises.filter((e) => e && e.name) : [];
  if (day.rest || !exercises.length) {
    return {
      ok: true, day: DAY_CZ[key], dayKey: key, rest: true, suggestions: [],
      note: `${DAY_CZ[key]} je v plánu volno, žádné váhy k návrhu.`
    };
  }

  const suggestions = exercises.map((ex) => {
    const range = parseRepRange(ex.reps);
    const entry = findExerciseEntry(state, ex.name);
    const big = isBigLift(ex.name);
    const step = big ? 5 : 2.5;

    if (!entry) {
      return {
        exercise: ex.name, reps: ex.reps || `${range.lo}-${range.hi}`,
        lastWeight: null, suggestedWeight: null, step, bigLift: big,
        reason: 'Žádná zapsaná historie — zvol váhu, kterou udržíš v technice, a zapiš ji.'
      };
    }

    const last = entry.sessions[entry.sessions.length - 1];
    const top = topSetOf(last);
    const setsAtTop = last.sets.filter((s) => s.w === top.w);
    const minRepsAtTop = Math.min.apply(null, setsAtTop.map((s) => s.r));

    // Stall check on the same data detect_stagnation uses, so the two tools
    // never contradict each other.
    let streak = 1;
    for (let i = entry.sessions.length - 2; i >= 0; i--) {
      if (topSetOf(entry.sessions[i]).w === top.w) streak++;
      else break;
    }

    let suggested = top.w;
    let reason;
    if (minRepsAtTop >= range.hi) {
      suggested = r1(top.w + step);
      reason = `Naposledy ${cz(top.w)} kg × ${minRepsAtTop} — horní hranice ${range.hi} splněna, přidej ${cz(step)} kg.`;
    } else if (streak >= 3) {
      reason = `Stojíš na ${cz(top.w)} kg už ${streak} ${plural(streak, 'trénink', 'tréninky', 'tréninků')} a na ${range.hi} opakování to nejde — zkus přidat sérii nebo zpomalit tempo, váhu zatím nech.`;
    } else if (minRepsAtTop < range.lo) {
      reason = `Naposledy jen ${minRepsAtTop} opakování při ${cz(top.w)} kg, což je pod rozsahem — zůstaň na váze a dojeď ${range.lo}-${range.hi}.`;
    } else {
      reason = `Naposledy ${cz(top.w)} kg × ${minRepsAtTop}, rozsah ${range.lo}-${range.hi} zatím nedojetý — stejná váha, přidej opakování.`;
    }

    return {
      exercise: ex.name,
      reps: ex.reps || `${range.lo}-${range.hi}`,
      sets: num(ex.sets, 3),
      lastWeight: top.w,
      lastReps: minRepsAtTop,
      lastDate: last.date,
      suggestedWeight: suggested,
      increase: r1(suggested - top.w),
      step,
      bigLift: big,
      sessionsAtThisWeight: streak,
      reason
    };
  });

  const withHistory = suggestions.filter((s) => s.lastWeight != null);
  const ups = suggestions.filter((s) => s.increase > 0);
  const headline = ups.length
    ? ups.map((s) => `${s.exercise} ${cz(s.lastWeight)}→${cz(s.suggestedWeight)} kg`).join(', ')
    : 'nikde se váha nezvedá, drž současné a dojeď opakování';

  return {
    ok: true,
    day: DAY_CZ[key],
    dayKey: key,
    title: day.title || 'Trénink',
    rest: false,
    suggestions,
    exercisesWithHistory: withHistory.length,
    weakSample: withHistory.length === 0,
    note: `${DAY_CZ[key]} (${day.title || 'Trénink'}): ${headline}.`
      + (withHistory.length === 0
        ? ' U žádného cviku není zapsaná historie, tak je to jen odhad podle plánu.'
        : ` Historii mám u ${withHistory.length} z ${suggestions.length} cviků.`)
  };
}

function toolWeightTrend(a, state) {
  const days = clamp(r0(num(a.days, 30)), 7, 365);
  const today = todayOf(state);
  const from = shiftDate(today, -(days - 1));
  const points = weighInsBetween(state, from, today);

  if (!points.length) {
    return {
      ok: true, days, from, to: today, hasData: false, weighIns: 0, points: [],
      weakSample: true,
      note: `Za posledních ${days} dní není žádné vážení, trend se spočítat nedá.`
    };
  }
  if (points.length === 1) {
    return {
      ok: true, days, from, to: today, hasData: true, weighIns: 1,
      points: [{ date: points[0].date, weight: points[0].weight, avg: points[0].weight, samples: 1 }],
      current: points[0].weight, ratePerWeek: null, weakSample: true,
      note: `Za ${days} dní je jen jedno vážení (${cz(points[0].weight)} kg z ${points[0].date}). Na trend potřebuju aspoň dvě, ideálně vážení jednou týdně.`
    };
  }

  const smoothed = movingAverage(points, 7);
  const rate = weeklyRate(smoothed);
  const raw = r1(points[points.length - 1].weight - points[0].weight);
  const weak = points.length < 4 || (rate && rate.spanDays < 14);

  let dirText;
  if (!rate || Math.abs(rate.rate) < 0.05) dirText = 'váha stojí';
  else dirText = rate.rate < 0 ? `dolů ${cz(Math.abs(rate.rate))} kg týdně` : `nahoru ${cz(rate.rate)} kg týdně`;

  return {
    ok: true,
    days, from, to: today,
    hasData: true,
    weighIns: points.length,
    points: smoothed,
    first: points[0],
    current: points[points.length - 1].weight,
    rawChangeKg: raw,
    smoothedChangeKg: rate ? r1(rate.to.avg - rate.from.avg) : null,
    ratePerWeek: rate ? rate.rate : null,
    spanDays: rate ? rate.spanDays : 0,
    weakSample: weak,
    note: `${points.length} vážení za ${days} dní, aktuálně ${cz(points[points.length - 1].weight)} kg, syrová změna ${raw > 0 ? '+' : ''}${cz(raw)} kg. Klouzavý sedmidenní průměr jde ${dirText}.`
      + (weak ? ' Vážení je zatím málo (nebo jsou moc blízko u sebe), takže je to slabý odhad.' : '')
  };
}

function toolPredictGoalDate(a, state) {
  const goal = goalWeightOf(state, a.targetWeightKg);
  if (goal == null) {
    return { ok: false, error: 'Neznám cílovou váhu — v datech aplikace není. Zeptej se uživatele, kolik chce vážit, a pošli to jako targetWeightKg.' };
  }
  const today = todayOf(state);
  const all = weighIns(state);
  if (all.length < 2) {
    return {
      ok: true, hasData: all.length > 0, canPredict: false, reason: 'málo vážení',
      goalWeight: goal, current: all.length ? all[all.length - 1].weight : null,
      weighIns: all.length, weakSample: true,
      note: all.length
        ? `Mám jen jedno vážení (${cz(all[all.length - 1].weight)} kg). Z jednoho čísla se tempo spočítat nedá — datum ti neřeknu, dokud se nezvážíš aspoň třikrát v rozmezí dvou týdnů.`
        : 'Zatím není zapsané žádné vážení, takže nejde odhadnout ani tempo, ani datum.'
    };
  }

  // Only the last eight weeks matter: an old crash diet must not shape the
  // prediction of where the current pace leads.
  const from = shiftDate(today, -55);
  const recent = all.filter((w) => w.date >= from);
  const points = recent.length >= 2 ? recent : all.slice(-2);
  const smoothed = movingAverage(points, 7);
  const rate = weeklyRate(smoothed);
  const current = points[points.length - 1].weight;
  const remaining = r1(goal - current);
  const spanDays = rate ? rate.spanDays : 0;

  const base = {
    ok: true, hasData: true, goalWeight: goal, current,
    remainingKg: remaining, weighIns: points.length, spanDays,
    ratePerWeek: rate ? rate.rate : null
  };

  if (Math.abs(remaining) < 0.3) {
    return Object.assign(base, {
      canPredict: false, reason: 'už jsi na cíli', weakSample: false,
      note: `Aktuálně ${cz(current)} kg, cíl ${cz(goal)} kg — jsi prakticky tam, není co předpovídat.`
    });
  }
  if (points.length < 3 || spanDays < 14) {
    return Object.assign(base, {
      canPredict: false, reason: 'krátká historie', weakSample: true,
      note: `Zatím mám ${points.length} vážení v rozmezí ${spanDays} dní. To je na odhad data málo — z takového vzorku bych ti řekl číslo, které nic neznamená. Zvaž se pravidelně dva až tři týdny a spočítám to.`
    });
  }
  if (!rate || Math.abs(rate.rate) < 0.05) {
    return Object.assign(base, {
      canPredict: false, reason: 'váha stojí', weakSample: false,
      note: `Váha se za posledních ${spanDays} dní prakticky nehýbe (${cz(rate ? rate.rate : 0)} kg/týden), takže při současném tempu na ${cz(goal)} kg nedojdeš vůbec. Datum vymýšlet nebudu — nejdřív je potřeba změnit příjem nebo aktivitu.`
    });
  }
  const wrongWay = (remaining < 0 && rate.rate > 0) || (remaining > 0 && rate.rate < 0);
  if (wrongWay) {
    return Object.assign(base, {
      canPredict: false, reason: 'opačný směr', weakSample: false,
      note: `Cíl je ${cz(goal)} kg, teď máš ${cz(current)} kg, ale váha jde ${rate.rate > 0 ? 'nahoru' : 'dolů'} o ${cz(Math.abs(rate.rate))} kg týdně — tedy od cíle pryč. Při tomhle tempu se tam nedostaneš, datum by byla lež.`
    });
  }

  const weeks = Math.abs(remaining / rate.rate);
  if (weeks > 260) {
    return Object.assign(base, {
      canPredict: false, reason: 'příliš pomalé tempo', weeksNeeded: Math.round(weeks), weakSample: false,
      note: `Při tempu ${cz(rate.rate)} kg/týden by ${cz(Math.abs(remaining))} kg trvalo přes pět let. To je prakticky nekonečno — dává smysl tempo zrychlit, ne čekat na datum.`
    });
  }
  const etaDays = Math.round(weeks * 7);
  const eta = shiftDate(today, etaDays);
  const weak = points.length < 5;

  return Object.assign(base, {
    canPredict: true,
    weeksNeeded: Math.round(weeks * 10) / 10,
    etaDays,
    etaDate: eta,
    weakSample: weak,
    note: `Z ${cz(current)} kg na ${cz(goal)} kg zbývá ${cz(Math.abs(remaining))} kg. Při současném tempu ${cz(rate.rate)} kg za týden (měřeno ${points.length} váženími za ${spanDays} dní) to vychází zhruba na ${Math.round(weeks)} týdnů, tedy kolem ${eta}.`
      + (weak ? ' Vážení je málo, ber datum jako hrubý odhad.' : '')
  });
}

function toolComparePeriods(a, state) {
  const days = clamp(r0(num(a.days, 7)), 1, 45);
  const today = todayOf(state);
  const curFrom = shiftDate(today, -(days - 1));
  const prevTo = shiftDate(curFrom, -1);
  const prevFrom = shiftDate(prevTo, -(days - 1));

  const summarize = (from, to) => {
    const dates = [];
    for (let d = from; d <= to; d = shiftDate(d, 1)) dates.push(d);
    const logged = dates.filter((d) => itemsOn(state, d).length > 0);
    const totals = logged.map((d) => totalsOn(state, d));
    const w = weighInsBetween(state, from, to);
    let volume = 0;
    exerciseEntries(state).forEach((e) => e.sessions.forEach((s) => {
      if (s.date >= from && s.date <= to) volume += sessionVolume(s);
    }));
    return {
      from, to,
      loggedDays: logged.length,
      calories: r0(avg(totals.map((x) => x.calories))),
      protein: r0(avg(totals.map((x) => x.protein))),
      carbs: r0(avg(totals.map((x) => x.carbs))),
      fat: r0(avg(totals.map((x) => x.fat))),
      weight: w.length ? w[w.length - 1].weight : null,
      weighIns: w.length,
      workouts: dates.filter((d) => trainedOn(state, d)).length,
      volume: r0(volume)
    };
  };

  const current = summarize(curFrom, today);
  const previous = summarize(prevFrom, prevTo);

  const diff = {
    calories: current.loggedDays && previous.loggedDays ? current.calories - previous.calories : null,
    protein: current.loggedDays && previous.loggedDays ? current.protein - previous.protein : null,
    weight: (current.weight != null && previous.weight != null) ? r1(current.weight - previous.weight) : null,
    workouts: current.workouts - previous.workouts,
    volume: current.volume - previous.volume,
    loggedDays: current.loggedDays - previous.loggedDays
  };

  const weak = current.loggedDays < 3 || previous.loggedDays < 3;
  const bits = [];
  if (diff.calories != null) {
    bits.push(`kalorie ${current.calories} vs ${previous.calories} kcal (${diff.calories > 0 ? '+' : ''}${diff.calories})`);
    bits.push(`bílkoviny ${current.protein} vs ${previous.protein} g (${diff.protein > 0 ? '+' : ''}${diff.protein})`);
  } else {
    bits.push('kalorie nejde porovnat, v jednom z období není zapsaný žádný den');
  }
  if (diff.weight != null) bits.push(`váha ${cz(current.weight)} vs ${cz(previous.weight)} kg (${diff.weight > 0 ? '+' : ''}${cz(diff.weight)})`);
  bits.push(`tréninky ${current.workouts} vs ${previous.workouts}`);

  return {
    ok: true,
    days,
    current,
    previous,
    diff,
    weakSample: weak,
    note: `Posledních ${days} dní proti předchozím ${days}: ${bits.join(', ')}.`
      + (weak ? ' V jednom z období je zapsáno míň než tři dny, takže je srovnání slabé.' : '')
  };
}

function toolAdherence(a, state) {
  const days = clamp(r0(num(a.days, 14)), 1, 90);
  const { today, dates, logged } = loggedWindow(state, days);
  const t = targetsOf(state);

  let inTarget = 0;
  let over = 0;
  let under = 0;
  logged.forEach((d) => {
    if (!t.calories) return;
    const c = totalsOn(state, d).calories;
    if (Math.abs(c - t.calories) <= KCAL_TOLERANCE) inTarget++;
    else if (c > t.calories) over++;
    else under++;
  });

  let plannedWorkouts = 0;
  let doneWorkouts = 0;
  dates.forEach((d) => {
    const res = plannedWorkoutDone(state, d);
    if (res === null) return;
    plannedWorkouts++;
    if (res) doneWorkouts++;
  });

  const hasPlan = !!(state.workoutPlan && state.workoutPlan.days);
  const weak = logged.length < 4;
  const parts = [];
  parts.push(`Zapsáno ${logged.length} z ${days} dní (${pct(logged.length, days)} %).`);
  if (t.calories && logged.length) {
    parts.push(`V cíli ±${KCAL_TOLERANCE} kcal bylo ${inTarget} z ${logged.length} zapsaných dní (${pct(inTarget, logged.length)} %), nad cílem ${over}, pod cílem ${under}.`);
  } else if (!t.calories) {
    parts.push('Kalorický cíl není nastavený, takže procenta dní v cíli nespočítám.');
  }
  if (hasPlan && plannedWorkouts) {
    parts.push(`Tréninků splněno ${doneWorkouts} z ${plannedWorkouts} naplánovaných (${pct(doneWorkouts, plannedWorkouts)} %).`);
  } else if (!hasPlan) {
    parts.push('Tréninkový plán neexistuje, dodržování tréninků nejde spočítat.');
  }
  if (weak) parts.push('Zapsaných dní je málo, ber procenta orientačně.');

  return {
    ok: true,
    days, from: dates[0], to: today,
    hasData: logged.length > 0,
    loggedDays: logged.length,
    loggingPct: pct(logged.length, days),
    calorieTarget: t.calories || null,
    toleranceKcal: KCAL_TOLERANCE,
    daysInTarget: inTarget,
    daysOver: over,
    daysUnder: under,
    inTargetPct: t.calories && logged.length ? pct(inTarget, logged.length) : null,
    plannedWorkouts,
    completedWorkouts: doneWorkouts,
    workoutPct: plannedWorkouts ? pct(doneWorkouts, plannedWorkouts) : null,
    weakSample: weak,
    note: parts.join(' ')
  };
}

function toolStreak(a, state) {
  const today = todayOf(state);

  // Logging streak. Today not being logged yet at 10:00 is normal, so the
  // streak is measured from yesterday in that case and we say so.
  const loggedToday = itemsOn(state, today).length > 0;
  let cursor = loggedToday ? today : shiftDate(today, -1);
  let streak = 0;
  for (let i = 0; i < 400; i++) {
    if (itemsOn(state, cursor).length === 0) break;
    streak++;
    cursor = shiftDate(cursor, -1);
  }

  // Longest streak within the 90 days the client keeps.
  let longest = 0;
  let run = 0;
  windowDates(today, 90).forEach((d) => {
    if (itemsOn(state, d).length > 0) { run++; if (run > longest) longest = run; }
    else run = 0;
  });

  // Workout streak: consecutive PLANNED training days that were actually done.
  // Rest days are skipped, otherwise every plan would break the streak weekly.
  const hasPlan = !!(state.workoutPlan && state.workoutPlan.days);
  let workoutStreak = 0;
  let missedOn = null;
  if (hasPlan) {
    let d = today;
    for (let i = 0; i < 120; i++) {
      const res = plannedWorkoutDone(state, d);
      if (res === true) workoutStreak++;
      else if (res === false) {
        // Today's training day is not a miss until the day is over.
        if (d !== today) { missedOn = d; break; }
      }
      d = shiftDate(d, -1);
    }
  }

  let lastWorkout = null;
  let d2 = today;
  for (let i = 0; i < 120; i++) {
    if (trainedOn(state, d2)) { lastWorkout = d2; break; }
    d2 = shiftDate(d2, -1);
  }
  const workouts30 = windowDates(today, 30).filter((d) => trainedOn(state, d)).length;

  const parts = [];
  parts.push(streak
    ? `Zapisuje ${streak} ${streak === 1 ? 'den' : 'dní'} v řadě${loggedToday ? '' : ' (dneska ještě nic nezapsal, počítáno do včerejška)'}, nejdelší série za 90 dní je ${longest} dní.`
    : 'Aktuálně žádná série zápisů — poslední dny chybí zápis jídla.');
  if (hasPlan) parts.push(`Naplánovaných tréninků po sobě splněných: ${workoutStreak}.`);
  parts.push(lastWorkout
    ? `Naposledy trénoval ${lastWorkout} (${agoDays(daysBetween(lastWorkout, today))}), za 30 dní ${workouts30} ${plural(workouts30, 'trénink', 'tréninky', 'tréninků')}.`
    : 'Za posledních 120 dní není zaznamenaný žádný trénink.');

  return {
    ok: true,
    today,
    loggedToday,
    loggingStreak: streak,
    longestLoggingStreak90d: longest,
    workoutStreak: hasPlan ? workoutStreak : null,
    firstMissedPlannedWorkout: missedOn,
    lastWorkoutDate: lastWorkout,
    daysSinceLastWorkout: lastWorkout ? daysBetween(lastWorkout, today) : null,
    workoutsLast30Days: workouts30,
    weakSample: false,
    note: parts.join(' ')
  };
}

function toolFindPatterns(a, state) {
  const days = clamp(r0(num(a.days, 30)), 7, 90);
  const { today, dates, logged } = loggedWindow(state, days);
  const t = targetsOf(state);
  const patterns = [];

  const isWeekend = (d) => ['sat', 'sun'].includes(dayKeyForDate(d));
  const weekendCals = logged.filter(isWeekend).map((d) => totalsOn(state, d).calories);
  const weekdayCals = logged.filter((d) => !isWeekend(d)).map((d) => totalsOn(state, d).calories);

  // Two data points on each side is not a pattern; three is the minimum here.
  if (weekendCals.length >= 3 && weekdayCals.length >= 3) {
    const we = r0(avg(weekendCals));
    const wd = r0(avg(weekdayCals));
    const diff = we - wd;
    if (Math.abs(diff) >= 100) {
      patterns.push({
        type: 'weekend',
        text: `O víkendu jíš v průměru ${we} kcal, ve všední dny ${wd} kcal — rozdíl ${diff > 0 ? '+' : ''}${diff} kcal.`,
        weekendAvg: we, weekdayAvg: wd, diff,
        support: `${weekendCals.length} víkendových a ${weekdayCals.length} všedních dní`
      });
    } else {
      patterns.push({
        type: 'weekend',
        text: `Víkend a všední dny jsou skoro stejné (${we} vs ${wd} kcal), víkendové ujetí se v datech neukazuje.`,
        weekendAvg: we, weekdayAvg: wd, diff,
        support: `${weekendCals.length} víkendových a ${weekdayCals.length} všedních dní`
      });
    }
  }

  // Which weekdays run over the calorie target.
  const overByDay = {};
  const loggedByDay = {};
  DAY_KEYS.forEach((k) => { overByDay[k] = 0; loggedByDay[k] = 0; });
  if (t.calories) {
    logged.forEach((d) => {
      const k = dayKeyForDate(d);
      loggedByDay[k]++;
      if (totalsOn(state, d).calories > t.calories + KCAL_TOLERANCE) overByDay[k]++;
    });
    const overDays = DAY_KEYS
      .filter((k) => loggedByDay[k] >= 2 && overByDay[k] >= 2 && overByDay[k] / loggedByDay[k] >= 0.6)
      .map((k) => ({ day: DAY_CZ[k], over: overByDay[k], logged: loggedByDay[k] }));
    if (overDays.length) {
      patterns.push({
        type: 'overTargetDays',
        text: `Přes cíl bývá nejčastěji: ${overDays.map((x) => `${x.day} (${x.over} z ${x.logged} dní)`).join(', ')}.`,
        days: overDays,
        support: `${logged.length} zapsaných dní`
      });
    }
  }

  // Which weekdays are missing a log entirely. Needs a few logged days to
  // compare against — "chybí zápis každý den" is not a pattern, it is an
  // empty account.
  const missByDay = {};
  DAY_KEYS.forEach((k) => { missByDay[k] = 0; });
  const totalByDay = {};
  DAY_KEYS.forEach((k) => { totalByDay[k] = 0; });
  dates.forEach((d) => {
    const k = dayKeyForDate(d);
    totalByDay[k]++;
    if (itemsOn(state, d).length === 0) missByDay[k]++;
  });
  const missDays = logged.length < 3 ? [] : DAY_KEYS
    .filter((k) => totalByDay[k] >= 2 && missByDay[k] >= 2 && missByDay[k] / totalByDay[k] >= 0.6)
    .map((k) => ({ day: DAY_CZ[k], missed: missByDay[k], of: totalByDay[k] }));
  if (missDays.length) {
    patterns.push({
      type: 'missingLogs',
      text: `Zápis nejčastěji chybí: ${missDays.map((x) => `${x.day} (${x.missed} z ${x.of})`).join(', ')}.`,
      days: missDays,
      support: `${days} dní okna`
    });
  }

  // Protein on training days vs rest days.
  const trainP = logged.filter((d) => trainedOn(state, d)).map((d) => totalsOn(state, d).protein);
  const restP = logged.filter((d) => !trainedOn(state, d)).map((d) => totalsOn(state, d).protein);
  if (trainP.length >= 3 && restP.length >= 3) {
    const a1 = r0(avg(trainP));
    const b1 = r0(avg(restP));
    if (Math.abs(a1 - b1) >= 10) {
      patterns.push({
        type: 'proteinByTraining',
        text: `V tréninkové dny máš ${a1} g bílkovin, v netréninkové ${b1} g — rozdíl ${a1 - b1 > 0 ? '+' : ''}${a1 - b1} g.`,
        trainingAvg: a1, restAvg: b1,
        support: `${trainP.length} tréninkových a ${restP.length} volných dní`
      });
    }
  }

  const weak = logged.length < 7;
  return {
    ok: true,
    days, from: dates[0], to: today,
    hasData: logged.length > 0,
    loggedDays: logged.length,
    patterns,
    weakSample: weak,
    note: patterns.length
      ? `Z ${logged.length} zapsaných dní za ${days} dní vyplývá: ${patterns.map((p) => p.text).join(' ')}`
        + (weak ? ' Dat je zatím málo, ber to jako náznak.' : '')
      : `Za ${days} dní (${logged.length} zapsaných) se žádný jasný vzorec nedá vyčíst — na to je potřeba víc zapsaných dní.`
  };
}

function toolMacroBreakdown(a, state) {
  const days = clamp(r0(num(a.days, 7)), 1, 90);
  const { today, dates, logged } = loggedWindow(state, days);
  const t = targetsOf(state);

  if (!logged.length) {
    return {
      ok: true, days, from: dates[0], to: today, hasData: false, loggedDays: 0, weakSample: true,
      note: `Za posledních ${days} dní není zapsaný žádný den, rozpad maker se nedá spočítat.`
    };
  }

  const totals = logged.map((d) => totalsOn(state, d));
  const g = {
    calories: r0(avg(totals.map((x) => x.calories))),
    protein: r0(avg(totals.map((x) => x.protein))),
    carbs: r0(avg(totals.map((x) => x.carbs))),
    fat: r0(avg(totals.map((x) => x.fat)))
  };
  // Percentages are computed from macro energy, not from the logged calorie
  // number — those two drift apart when food entries are rounded.
  const kcalFromMacros = g.protein * 4 + g.carbs * 4 + g.fat * 9;
  const share = {
    protein: pct(g.protein * 4, kcalFromMacros),
    carbs: pct(g.carbs * 4, kcalFromMacros),
    fat: pct(g.fat * 9, kcalFromMacros)
  };

  let targetShare = null;
  if (t.calories && (t.protein || t.carbs || t.fat)) {
    const tk = t.protein * 4 + t.carbs * 4 + t.fat * 9;
    targetShare = {
      protein: pct(t.protein * 4, tk),
      carbs: pct(t.carbs * 4, tk),
      fat: pct(t.fat * 9, tk)
    };
  }

  const warn = sampleWarning(logged.length, days);
  const diffTxt = t.protein
    ? ` Proti cíli: bílkoviny ${g.protein - t.protein > 0 ? '+' : ''}${g.protein - t.protein} g, sacharidy ${g.carbs - t.carbs > 0 ? '+' : ''}${g.carbs - t.carbs} g, tuky ${g.fat - t.fat > 0 ? '+' : ''}${g.fat - t.fat} g.`
    : ' Cíle na makra nejsou nastavené, tak srovnávat není s čím.';

  return {
    ok: true,
    days, from: dates[0], to: today,
    hasData: true,
    loggedDays: logged.length,
    averageGrams: g,
    sharePct: share,
    targets: t.protein ? t : null,
    targetSharePct: targetShare,
    diffGrams: t.protein ? {
      protein: g.protein - t.protein, carbs: g.carbs - t.carbs, fat: g.fat - t.fat,
      calories: t.calories ? g.calories - t.calories : null
    } : null,
    weakSample: !!warn,
    note: `Průměr za ${logged.length} zapsaných dní: ${g.calories} kcal — bílkoviny ${g.protein} g (${share.protein} %), sacharidy ${g.carbs} g (${share.carbs} %), tuky ${g.fat} g (${share.fat} %).${diffTxt}`
      + (warn ? ' ' + warn : '')
  };
}

function toolMostEaten(a, state) {
  const days = clamp(r0(num(a.days, 30)), 1, 90);
  const limit = clamp(r0(num(a.limit, 8)), 1, 20);
  const { today, dates, logged } = loggedWindow(state, days);

  const index = foodIndex(state, dates);
  const rows = [];
  index.forEach((e) => { if (e.count > 0) rows.push(foodStats(e)); });
  rows.sort((x, y) => y.count - x.count || y.calories - x.calories);
  const top = rows.slice(0, limit);

  if (!top.length) {
    return {
      ok: true, days, from: dates[0], to: today, hasData: false, foods: [], loggedDays: 0, weakSample: true,
      note: `Za posledních ${days} dní nejsou zapsaná žádná jídla.`
    };
  }

  const weak = logged.length < 5;
  const head = top.slice(0, 3).map((f) => `${f.name} ${f.count}×`).join(', ');
  return {
    ok: true,
    days, from: dates[0], to: today,
    hasData: true,
    loggedDays: logged.length,
    distinctFoods: rows.length,
    foods: top,
    weakSample: weak,
    note: `Za ${days} dní (${logged.length} zapsaných) je nejčastější: ${head}. Celkem ${rows.length} různých položek.`
      + (weak ? ' Zapsaných dní je zatím málo, takže to nemusí být typický jídelníček.' : '')
  };
}

function toolDayDetail(a, state) {
  const today = todayOf(state);
  const raw = String(a.date || '').trim().toLowerCase();
  let date = null;
  if (isDate(raw)) date = raw;
  else if (['dnes', 'today', 'dneska'].includes(raw)) date = today;
  else if (['vcera', 'včera', 'yesterday'].includes(raw)) date = shiftDate(today, -1);
  if (!date) return { ok: false, error: `Nerozumím datu "${a.date}". Pošli ho ve tvaru YYYY-MM-DD, případně "dnes" nebo "včera".` };
  if (date > today) return { ok: false, error: `Datum ${date} je v budoucnosti, o něm žádná data nejsou.` };

  const items = itemsOn(state, date).map((i) => ({
    time: i.time || null,
    category: i.category || null,
    name: String(i.name || 'bez názvu'),
    amount: i.amount || null,
    calories: r0(num(i.calories)),
    protein: r1(num(i.protein)),
    carbs: r1(num(i.carbs)),
    fat: r1(num(i.fat))
  }));
  const totals = totalsOn(state, date);
  const t = targetsOf(state);

  const plan = plannedDayFor(state, date);
  const doneIds = doneIdsOn(state, date);
  const doneNames = plan
    ? plan.exercises.filter((e) => doneIds.includes(e.id)).map((e) => e.name)
    : [];
  const loggedSets = exerciseEntries(state)
    .map((e) => {
      const s = e.sessions.find((x) => x.date === date);
      return s ? { exercise: e.name, sets: fmtSets(s), volume: r0(sessionVolume(s)) } : null;
    })
    .filter(Boolean);

  const weighIn = weighIns(state).find((w) => w.date === date) || null;
  const waterMl = num((state.water || {})[date], 0);

  const parts = [];
  if (items.length) {
    parts.push(`${date}: ${items.length} položek, ${r0(totals.calories)} kcal${t.calories ? ` (cíl ${t.calories}, ${r0(totals.calories) - t.calories > 0 ? '+' : ''}${r0(totals.calories) - t.calories})` : ''}, B ${r0(totals.protein)} g / S ${r0(totals.carbs)} g / T ${r0(totals.fat)} g.`);
  } else {
    parts.push(`${date}: žádné zapsané jídlo.`);
  }
  if (plan && !plan.rest) parts.push(`Plán: ${plan.title}, odškrtnuto ${doneIds.length} z ${plan.exercises.length} cviků.`);
  else if (plan) parts.push('V plánu bylo volno.');
  if (loggedSets.length) parts.push(`Zapsané série: ${loggedSets.map((x) => `${x.exercise} (${x.sets})`).join('; ')}.`);
  if (weighIn) parts.push(`Vážení ${cz(weighIn.weight)} kg.`);
  if (waterMl) parts.push(`Voda ${cz(r1(waterMl / 1000))} l.`);

  return {
    ok: true,
    date,
    dayName: DAY_CZ[dayKeyForDate(date)],
    hasData: items.length > 0 || loggedSets.length > 0 || doneIds.length > 0 || !!weighIn,
    items,
    totals: {
      calories: r0(totals.calories), protein: r0(totals.protein),
      carbs: r0(totals.carbs), fat: r0(totals.fat)
    },
    targets: t.calories ? t : null,
    calorieDiff: t.calories ? r0(totals.calories) - t.calories : null,
    workout: plan ? {
      planned: plan.rest ? 0 : plan.exercises.length,
      title: plan.rest ? 'Volno' : plan.title,
      rest: plan.rest,
      doneCount: doneIds.length,
      doneExercises: doneNames
    } : null,
    loggedSets,
    weight: weighIn ? weighIn.weight : null,
    waterLiters: waterMl ? r1(waterMl / 1000) : 0,
    weakSample: false,
    note: parts.join(' ')
  };
}

function toolFindBestDay(a, state) {
  const days = clamp(r0(num(a.days, 14)), 1, 90);
  const { today, dates, logged } = loggedWindow(state, days);
  const t = targetsOf(state);

  if (!logged.length) {
    return { ok: false, error: `Za posledních ${days} dní není zapsaný ani jeden den, nejlepší den nejde vybrat.` };
  }
  if (!t.calories) {
    return { ok: false, error: 'Kalorický cíl není nastavený, takže nejde říct, který den mu byl nejblíž. Nejdřív spočítej cíle.' };
  }

  const scored = logged.map((d) => {
    const tot = totalsOn(state, d);
    const cal = r0(tot.calories);
    const diff = Math.abs(cal - t.calories);
    const proteinHit = t.protein ? tot.protein >= t.protein * 0.95 : false;
    const trained = trainedOn(state, d);
    // Closeness to the calorie target is the backbone; protein and a finished
    // workout are bonuses, so a perfect-calorie day beats a trained blowout.
    const score = 100 - Math.min(60, diff / 10) + (proteinHit ? 15 : 0) + (trained ? 15 : 0);
    return {
      date: d,
      dayName: DAY_CZ[dayKeyForDate(d)],
      calories: cal,
      calorieDiff: cal - t.calories,
      protein: r0(tot.protein),
      proteinHit,
      trained,
      score: Math.round(score * 10) / 10
    };
  });
  scored.sort((x, y) => y.score - x.score || Math.abs(x.calorieDiff) - Math.abs(y.calorieDiff));

  const best = scored[0];
  const why = [];
  why.push(`${best.calories} kcal, ${best.calorieDiff === 0 ? 'přesně na cíli' : `${Math.abs(best.calorieDiff)} kcal ${best.calorieDiff > 0 ? 'nad' : 'pod'} cílem ${t.calories}`}`);
  if (best.proteinHit) why.push(`bílkoviny splněné (${best.protein} g z ${t.protein} g)`);
  else if (t.protein) why.push(`bílkoviny ${best.protein} g z ${t.protein} g`);
  if (best.trained) why.push('a odtrénováno');

  const weak = logged.length < 4;
  return {
    ok: true,
    days, from: dates[0], to: today,
    loggedDays: logged.length,
    best,
    topDays: scored.slice(0, 3),
    weakSample: weak,
    note: `Nejlepší den byl ${best.date} (${best.dayName}): ${why.join(', ')}.`
      + (weak ? ` Vybíráno jen z ${logged.length} zapsaných dní, takže konkurence byla malá.` : ` Vybíráno z ${logged.length} zapsaných dní.`)
  };
}

function toolEstimateTdee(a, state) {
  const today = todayOf(state);
  const w = weighIns(state).filter((x) => x.date >= shiftDate(today, -89));
  if (w.length < 2) {
    return { ok: false, error: `Na výpočet skutečného výdeje potřebuju aspoň dvě vážení, mám ${w.length}. Ať se uživatel zváží a za dva týdny to spočítám.` };
  }

  const from = w[0].date;
  const to = w[w.length - 1].date;
  const spanDays = daysBetween(from, to);
  if (spanDays < 14) {
    return { ok: false, error: `Vážení jsou od sebe jen ${spanDays} dní. Za tak krátkou dobu je změna váhy hlavně voda — potřebuju aspoň 14 dní mezi prvním a posledním vážením.` };
  }

  const dates = [];
  for (let d = from; d <= to; d = shiftDate(d, 1)) dates.push(d);
  const logged = dates.filter((d) => itemsOn(state, d).length > 0);
  if (logged.length < 14) {
    return { ok: false, error: `V období mezi váženími (${from} až ${to}) je zapsáno jen ${logged.length} dní jídla. Na odhad skutečného výdeje potřebuju aspoň 14 zapsaných dní.` };
  }

  const avgIntake = r0(avg(logged.map((d) => totalsOn(state, d).calories)));
  const changeKg = r1(w[w.length - 1].weight - w[0].weight);
  const dailyBalance = (changeKg * KCAL_PER_KG) / spanDays;
  const tdee = r0(avgIntake - dailyBalance);
  const coverage = pct(logged.length, dates.length);

  // Unlogged days almost never mean fasting, so patchy coverage biases the
  // measured intake down and the resulting TDEE with it.
  const warnings = [];
  if (coverage < 70) warnings.push(`Zapsáno je jen ${coverage} % dní období — nezapsané dny se počítají jako by v nich nebylo nic, takže skutečný výdej je nejspíš vyšší než ${tdee} kcal.`);
  if (w.length < 4) warnings.push(`Vážení jsou jen ${w.length}, takže změna váhy může být z velké části voda.`);

  let formulaTdee = null;
  const p = state.profile || {};
  if (p.weightKg && p.heightCm && p.age && p.sex) formulaTdee = targetsWithSteps(p).tdee;

  return {
    ok: true,
    from, to, spanDays,
    loggedDays: logged.length,
    coveragePct: coverage,
    avgIntake,
    weightChangeKg: changeKg,
    weeklyChangeKg: r1((changeKg / spanDays) * 7),
    dailyBalanceKcal: r0(dailyBalance),
    estimatedTDEE: tdee,
    formulaTDEE: formulaTdee,
    differenceFromFormula: formulaTdee ? tdee - formulaTdee : null,
    weakSample: warnings.length > 0,
    warnings,
    note: `Za ${spanDays} dní (${from} až ${to}) průměrný příjem ${avgIntake} kcal a změna váhy ${changeKg > 0 ? '+' : ''}${cz(changeKg)} kg. To je ${r0(dailyBalance)} kcal denně ${dailyBalance < 0 ? 'v deficitu' : 'v přebytku'}, takže skutečný výdej vychází na ${tdee} kcal.`
      + (formulaTdee ? ` Vzorec z profilu říká ${formulaTdee} kcal (rozdíl ${tdee - formulaTdee > 0 ? '+' : ''}${tdee - formulaTdee}).` : '')
      + (warnings.length ? ' ' + warnings.join(' ') : '')
  };
}

function toolExplainNumber(a, state) {
  const raw = normName(a.what);
  let what;
  if (['calories', 'kalorie', 'kcal', 'energie'].includes(raw)) what = 'calories';
  else if (['protein', 'bilkoviny', 'proteiny'].includes(raw)) what = 'protein';
  else if (['targets', 'cile', 'makra', 'all', 'vse', 'vsechno', 'carbs', 'sacharidy', 'fat', 'tuky'].includes(raw)) what = 'targets';
  else return { ok: false, error: `Nevím, co mám vysvětlit ("${a.what}"). Použij "calories", "protein" nebo "targets".` };

  const p = state.profile || {};
  const missing = [];
  if (!p.sex) missing.push('pohlaví');
  if (!num(p.age, 0)) missing.push('věk');
  if (!num(p.heightCm, 0)) missing.push('výška');
  if (!num(p.weightKg, 0)) missing.push('váha');
  if (missing.length) {
    return { ok: false, error: `Bez těchto údajů v profilu se čísla spočítat nedají: ${missing.join(', ')}.` };
  }

  const c = targetsWithSteps(p);
  const saved = targetsOf(state);
  const matches = saved.calories === c.calories && saved.protein === c.protein;
  const mode = state.calorieMode || null;

  let steps = c.steps;
  if (what === 'calories') steps = c.steps.filter((s) => !/^Bílkoviny|^Tuky|^Sacharidy/.test(s));
  if (what === 'protein') {
    steps = [
      `Bílkoviny se počítají z tělesné váhy, ne z kalorií: ${cz(num(p.weightKg))} kg × ${cz(GOAL_PROTEIN[c.goal])} g/kg (sazba pro ${GOAL_CZ[c.goal]}) = ${c.protein} g.`,
      'Při hubnutí je sazba nejvyšší (2,2 g/kg), protože v deficitu drží bílkovina svaly.'
    ];
  }

  const notes = [];
  if (what === 'protein') notes.push(`Cíl na bílkoviny ${c.protein} g je ${cz(GOAL_PROTEIN[c.goal])} g na kilo tělesné váhy (${cz(num(p.weightKg))} kg), sazba podle cíle ${GOAL_CZ[c.goal]}.`);
  else notes.push(`Kalorie ${c.calories} kcal: BMR ${c.bmr} → výdej ${c.tdee} (×${cz(c.activityFactor)} za ${c.trainingDaysPerWeek} ${plural(c.trainingDaysPerWeek, 'trénink', 'tréninky', 'tréninků')}) → ×${cz(GOAL_ADJUST[c.goal])} za cíl ${GOAL_CZ[c.goal]}.`);
  if (c.flooredForGrowth) notes.push(`Kalorie byly zvednuty na růstové minimum ${c.floor} kcal.`);
  if (mode) notes.push(`Pozor: teď běží dočasný režim "${mode.label}" do ${mode.until}, takže v aplikaci vidí ${saved.calories} kcal místo vypočítaných ${c.calories} kcal.`);
  else if (!matches && saved.calories) notes.push(`V aplikaci je ale uloženo ${saved.calories} kcal / ${saved.protein} g bílkovin — cíle byly ručně upravené oproti vzorci.`);

  return {
    ok: true,
    what,
    profileUsed: {
      sex: p.sex, age: num(p.age), heightCm: num(p.heightCm), weightKg: num(p.weightKg),
      goal: c.goal, trainingDaysPerWeek: c.trainingDaysPerWeek
    },
    bmr: c.bmr,
    activityFactor: c.activityFactor,
    tdee: c.tdee,
    goalAdjust: GOAL_ADJUST[c.goal],
    computed: { calories: c.calories, protein: c.protein, carbs: c.carbs, fat: c.fat },
    savedInApp: saved.calories ? saved : null,
    matchesSaved: matches,
    calorieMode: mode ? { label: mode.label, until: mode.until } : null,
    steps,
    weakSample: false,
    note: notes.join(' ')
  };
}

function toolCompareTwoFoods(a, state) {
  const nameA = String(a.nameA || '').trim();
  const nameB = String(a.nameB || '').trim();
  if (!nameA || !nameB) return { ok: false, error: 'Potřebuju názvy obou jídel (nameA a nameB).' };
  if (normName(nameA) === normName(nameB)) return { ok: false, error: 'Obě jména jsou stejné jídlo, není co porovnávat.' };

  const today = todayOf(state);
  const index = foodIndex(state, windowDates(today, 90));
  const eA = findFood(index, nameA);
  const eB = findFood(index, nameB);
  const missing = [];
  if (!eA) missing.push(nameA);
  if (!eB) missing.push(nameB);
  if (missing.length) {
    return { ok: false, error: `V historii ani v oblíbených nemám: ${missing.join(', ')}. Porovnávat můžu jen jídla, která už uživatel někdy zapsal.` };
  }

  const A = foodStats(eA);
  const B = foodStats(eB);

  // Per 100 g only when both portions carry a parsable weight — otherwise the
  // comparison would silently mix "150g" with "1 ks".
  const gA = parseGrams(A.typicalAmount);
  const gB = parseGrams(B.typicalAmount);
  let per100g = null;
  if (gA && gB) {
    const scale = (x, g) => ({
      calories: r0((x.calories / g) * 100),
      protein: r1((x.protein / g) * 100),
      carbs: r1((x.carbs / g) * 100),
      fat: r1((x.fat / g) * 100)
    });
    per100g = { a: scale(A, gA), b: scale(B, gB) };
  }

  const density = (x) => (x.calories > 0 ? r1((x.protein * 100) / x.calories) : 0);
  const dA = density(A);
  const dB = density(B);
  const goal = ['recomp', 'cut', 'bulk'].includes((state.profile || {}).goal) ? state.profile.goal : 'recomp';

  const reasons = [];
  let better;
  if (goal === 'bulk') {
    better = A.calories >= B.calories ? A.name : B.name;
    reasons.push(`Cíl je nabírání, takže se hodí spíš kaloričtější volba: ${A.name} ${A.calories} kcal vs ${B.name} ${B.calories} kcal.`);
  } else {
    // Protein per 100 kcal is what decides a cut, not the raw calorie count.
    if (dA === dB) {
      better = A.calories <= B.calories ? A.name : B.name;
      reasons.push(`Hustota bílkovin je stejná (${cz(dA)} g na 100 kcal), rozhoduje tedy nižší energie: ${A.name} ${A.calories} kcal vs ${B.name} ${B.calories} kcal.`);
    } else {
      better = dA > dB ? A.name : B.name;
      reasons.push(`${A.name} má ${cz(dA)} g bílkovin na 100 kcal, ${B.name} ${cz(dB)} g — na ${GOAL_CZ[goal]} je lepší ta hustší volba.`);
    }
  }
  reasons.push(`Porce: ${A.name} ${A.typicalAmount || 'neuvedeno'} = ${A.calories} kcal / B ${cz(A.protein)} g, ${B.name} ${B.typicalAmount || 'neuvedeno'} = ${B.calories} kcal / B ${cz(B.protein)} g.`);
  if (!per100g) reasons.push('Na 100 g to nejde přepočítat — u aspoň jednoho jídla není v porci uvedená gramáž.');

  const weak = (A.count + B.count) < 3;
  if (weak) reasons.push(`Průměry stojí na malém počtu zápisů (${A.name} ${A.count}×, ${B.name} ${B.count}×), takže makra nemusí sedět přesně.`);

  return {
    ok: true,
    a: A,
    b: B,
    per100g,
    proteinPer100kcal: { a: dA, b: dB },
    goal,
    better,
    weakSample: weak,
    note: `Lepší volba vzhledem k cíli (${GOAL_CZ[goal]}) je ${better}. ${reasons.join(' ')}`
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

// Applies one analytics tool call. Reads `state` only — nothing here mutates it.
function applyStatsTool(name, args, state) {
  const a = args || {};
  const s = (state && typeof state === 'object') ? state : {};

  switch (name) {
    case 'get_progress_summary': return toolProgressSummary(a, s);
    case 'get_exercise_history': return toolExerciseHistory(a, s);
    case 'estimate_1rm': return toolEstimate1rm(a, s);
    case 'get_volume_stats': return toolVolumeStats(a, s);
    case 'detect_stagnation': return toolDetectStagnation(a, s);
    case 'plan_next_session': return toolPlanNextSession(a, s);
    case 'get_weight_trend': return toolWeightTrend(a, s);
    case 'predict_goal_date': return toolPredictGoalDate(a, s);
    case 'compare_periods': return toolComparePeriods(a, s);
    case 'get_adherence': return toolAdherence(a, s);
    case 'get_streak': return toolStreak(a, s);
    case 'find_patterns': return toolFindPatterns(a, s);
    case 'get_macro_breakdown': return toolMacroBreakdown(a, s);
    case 'get_most_eaten': return toolMostEaten(a, s);
    case 'get_day_detail': return toolDayDetail(a, s);
    case 'find_best_day': return toolFindBestDay(a, s);
    case 'estimate_tdee_from_data': return toolEstimateTdee(a, s);
    case 'explain_number': return toolExplainNumber(a, s);
    case 'compare_two_foods': return toolCompareTwoFoods(a, s);
    default:
      return { ok: false, error: `Neznámý statistický nástroj "${name}".` };
  }
}

module.exports = {
  STATS_TOOLS,
  STATS_TOOL_NAMES,
  applyStatsTool
};
