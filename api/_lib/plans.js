// Coach plan layer: profile, targets, workout plan and meal plan.
//
// The nutrition math is deterministic JS (Mifflin-St Jeor + activity factor),
// NOT left to the model — the AI only fills in plan *content* around numbers
// this file computes. Tool calls from Gemini are applied here as pure
// functions over a plan-state object, so api/chat.js stays stateless.

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_CZ = {
  mon: 'Pondělí', tue: 'Úterý', wed: 'Středa', thu: 'Čtvrtek',
  fri: 'Pátek', sat: 'Sobota', sun: 'Neděle'
};
const MEAL_CATEGORIES = [
  'Snídaně', 'Dopolední svačina', 'Oběd', 'Odpolední svačina', 'Večeře', 'Druhá večeře'
];

// Activity multipliers keyed by weekly training sessions.
const ACTIVITY_FACTORS = { 0: 1.2, 1: 1.32, 2: 1.4, 3: 1.48, 4: 1.55, 5: 1.63, 6: 1.72, 7: 1.8 };

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

// ---------------------------------------------------------------------------
// Nutrition math
// ---------------------------------------------------------------------------

// Mifflin-St Jeor basal metabolic rate.
function mifflinStJeor({ sex, weightKg, heightCm, age }) {
  const base = 10 * num(weightKg, 70) + 6.25 * num(heightCm, 175) - 5 * num(age, 25);
  return Math.round(base + (sex === 'female' ? -161 : 5));
}

// Full target computation. Returns the numbers plus the reasoning trail so the
// coach can explain them instead of inventing its own math.
function computeTargets(profile) {
  const p = profile || {};
  const weightKg = num(p.weightKg, 70);
  const age = num(p.age, 25);
  const goal = ['recomp', 'cut', 'bulk'].includes(p.goal) ? p.goal : 'recomp';

  const bmr = mifflinStJeor(p);
  const days = clamp(Math.round(num(p.trainingDaysPerWeek, 3)), 0, 7);
  const factor = num(p.activityFactor, 0) || ACTIVITY_FACTORS[days] || 1.5;
  const tdee = Math.round(bmr * factor);

  // Goal adjustment. Deliberately mild for recomp.
  const adjust = { recomp: 0.92, cut: 0.82, bulk: 1.10 }[goal];
  let calories = Math.round(tdee * adjust);

  // Growth floor: an adolescent must never be pushed into an aggressive
  // deficit, so clamp to at least 1.3x BMR while still under 18.
  const isTeen = age > 0 && age < 18;
  const floor = isTeen ? Math.round(bmr * 1.3) : Math.round(bmr * 1.1);
  const floored = calories < floor;
  if (floored) calories = floor;
  calories = Math.round(calories / 10) * 10;

  // Protein: higher when cutting (muscle retention), solid for recomp.
  const proteinPerKg = { recomp: 2.0, cut: 2.2, bulk: 1.8 }[goal];
  const protein = Math.round(weightKg * proteinPerKg);

  // Fat: never below 0.8 g/kg — hormone production, doubly important for teens.
  const fat = Math.round(weightKg * 0.9);

  // Carbs take whatever is left.
  const carbs = Math.max(50, Math.round((calories - protein * 4 - fat * 9) / 4));

  return {
    calories, protein, carbs, fat,
    bmr, tdee, activityFactor: factor, goal,
    flooredForGrowth: floored,
    note: floored
      ? `Kalorie zvednuty na růstové minimum (${floor} kcal) — v ${age} letech se agresivní deficit nedělá.`
      : null
  };
}

// ---------------------------------------------------------------------------
// Normalisation — model output is untrusted, so everything is shaped here
// ---------------------------------------------------------------------------

function normExercise(e) {
  if (!e || !e.name) return null;
  return {
    id: e.id || genId('ex'),
    name: String(e.name).slice(0, 80),
    sets: clamp(Math.round(num(e.sets, 3)), 1, 12),
    reps: String(e.reps || '8-12').slice(0, 20),
    restSec: clamp(Math.round(num(e.restSec, 90)), 15, 600),
    note: e.note ? String(e.note).slice(0, 140) : ''
  };
}

function normWorkoutDay(d) {
  const rest = d && (d.rest === true || d.rest === 'true');
  const exercises = rest ? [] : ((d && d.exercises) || []).map(normExercise).filter(Boolean).slice(0, 14);
  return {
    title: String((d && d.title) || (rest ? 'Volno' : 'Trénink')).slice(0, 50),
    rest: rest || exercises.length === 0,
    focus: d && d.focus ? String(d.focus).slice(0, 60) : '',
    exercises
  };
}

function normFoodItem(i) {
  if (!i || !i.name) return null;
  return {
    name: String(i.name).slice(0, 80),
    amount: String(i.amount || '100g').slice(0, 30),
    calories: Math.round(num(i.calories)),
    protein: Math.round(num(i.protein) * 10) / 10,
    carbs: Math.round(num(i.carbs) * 10) / 10,
    fat: Math.round(num(i.fat) * 10) / 10
  };
}

function normMeal(m) {
  if (!m) return null;
  const items = (m.items || []).map(normFoodItem).filter(Boolean).slice(0, 12);
  if (!items.length && !m.name) return null;
  const totals = items.reduce((s, i) => ({
    calories: s.calories + i.calories,
    protein: s.protein + i.protein,
    carbs: s.carbs + i.carbs,
    fat: s.fat + i.fat
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
  const category = MEAL_CATEGORIES.includes(m.category) ? m.category : 'Oběd';
  return {
    id: m.id || genId('meal'),
    category,
    name: String(m.name || items.map((i) => i.name).join(', ')).slice(0, 90),
    items,
    calories: Math.round(totals.calories),
    protein: Math.round(totals.protein * 10) / 10,
    carbs: Math.round(totals.carbs * 10) / 10,
    fat: Math.round(totals.fat * 10) / 10
  };
}

function normMealDay(d) {
  const meals = ((d && d.meals) || []).map(normMeal).filter(Boolean).slice(0, 8);
  // Keep meals in the app's canonical category order.
  meals.sort((a, b) => MEAL_CATEGORIES.indexOf(a.category) - MEAL_CATEGORIES.indexOf(b.category));
  return { meals };
}

// Exercise history is keyed by the normalised name so it survives the coach
// regenerating the workout plan (which mints new exercise ids).
function normalizeExerciseName(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function emptyWeek(factory) {
  const out = {};
  DAY_KEYS.forEach((k) => { out[k] = factory(); });
  return out;
}

function normDayKey(k) {
  if (!k) return null;
  const s = String(k).toLowerCase().trim();
  if (DAY_KEYS.includes(s)) return s;
  const cz = {
    'pondeli': 'mon', 'pondělí': 'mon', 'po': 'mon',
    'utery': 'tue', 'úterý': 'tue', 'ut': 'tue', 'út': 'tue',
    'streda': 'wed', 'středa': 'wed', 'st': 'wed',
    'ctvrtek': 'thu', 'čtvrtek': 'thu', 'ct': 'thu', 'čt': 'thu',
    'patek': 'fri', 'pátek': 'fri', 'pa': 'fri', 'pá': 'fri',
    'sobota': 'sat', 'so': 'sat',
    'nedele': 'sun', 'neděle': 'sun', 'ne': 'sun'
  };
  return cz[s] || null;
}

// ---------------------------------------------------------------------------
// Gemini tool declarations
// ---------------------------------------------------------------------------

const EXERCISE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    name: { type: 'STRING', description: 'Český název cviku, např. "Bench press s velkou činkou"' },
    sets: { type: 'INTEGER', description: 'Počet sérií' },
    reps: { type: 'STRING', description: 'Rozsah opakování, např. "8-12" nebo "5"' },
    restSec: { type: 'INTEGER', description: 'Pauza mezi sériemi v sekundách' },
    note: { type: 'STRING', description: 'Krátká technická poznámka (volitelné)' }
  },
  required: ['name', 'sets', 'reps']
};

const FOOD_ITEM_SCHEMA = {
  type: 'OBJECT',
  properties: {
    name: { type: 'STRING', description: 'Český název potraviny' },
    amount: { type: 'STRING', description: 'Množství v gramech/ml, např. "150g"' },
    calories: { type: 'NUMBER' },
    protein: { type: 'NUMBER' },
    carbs: { type: 'NUMBER' },
    fat: { type: 'NUMBER' }
  },
  required: ['name', 'amount', 'calories', 'protein', 'carbs', 'fat']
};

const MEAL_SCHEMA = {
  type: 'OBJECT',
  properties: {
    category: { type: 'STRING', enum: MEAL_CATEGORIES, description: 'Do které denní kategorie jídlo patří' },
    name: { type: 'STRING', description: 'Název celého jídla, např. "Kuřecí prso s rýží a brokolicí"' },
    items: { type: 'ARRAY', items: FOOD_ITEM_SCHEMA, description: 'Jednotlivé suroviny s gramáží a makry' }
  },
  required: ['category', 'name', 'items']
};

const WORKOUT_DAY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    day: { type: 'STRING', enum: DAY_KEYS, description: 'Den v týdnu' },
    title: { type: 'STRING', description: 'Název dne, např. "Push A" nebo "Nohy"' },
    focus: { type: 'STRING', description: 'Zaměření, např. "hrudník + triceps"' },
    rest: { type: 'BOOLEAN', description: 'true = volno / odpočinkový den' },
    exercises: { type: 'ARRAY', items: EXERCISE_SCHEMA }
  },
  required: ['day', 'title']
};

const MEAL_DAY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    day: { type: 'STRING', enum: DAY_KEYS },
    meals: { type: 'ARRAY', items: MEAL_SCHEMA }
  },
  required: ['day', 'meals']
};

const TOOL_DECLARATIONS = [
  {
    name: 'save_profile',
    description: 'Ulož nebo aktualizuj profil uživatele. Volej průběžně během onboardingu, jakmile se dozvíš novou informaci. Posílej jen ta pole, která znáš — ostatní se zachovají.',
    parameters: {
      type: 'OBJECT',
      properties: {
        goal: { type: 'STRING', enum: ['recomp', 'cut', 'bulk'], description: 'recomp = zpevnit/víc svalů a míň tuku, cut = hubnutí, bulk = nabírání' },
        sex: { type: 'STRING', enum: ['male', 'female'] },
        age: { type: 'INTEGER' },
        heightCm: { type: 'NUMBER' },
        weightKg: { type: 'NUMBER' },
        trainingDaysPerWeek: { type: 'INTEGER', description: 'Kolikrát týdně trénuje' },
        sessionMinutes: { type: 'INTEGER', description: 'Délka jednoho tréninku v minutách' },
        experience: { type: 'STRING', enum: ['beginner', 'intermediate', 'advanced'] },
        equipment: { type: 'STRING', enum: ['gym', 'home', 'minimal'], description: 'gym = posilovna, home = domácí vybavení, minimal = jen vlastní váha' },
        dietaryRestrictions: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Např. vegetarián, bez laktózy' },
        dislikes: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Jídla, která nemá rád' },
        allergies: { type: 'ARRAY', items: { type: 'STRING' } }
      }
    }
  },
  {
    name: 'compute_targets',
    description: 'Spočítá denní kalorie a makra z uloženého profilu (Mifflin-St Jeor + aktivitní faktor + úprava podle cíle). Volej TEPRVE až máš v profilu pohlaví, věk, výšku, váhu, cíl a počet tréninků. Vrátí konkrétní čísla, která pak použij v jídelníčku.',
    parameters: { type: 'OBJECT', properties: {} }
  },
  {
    name: 'set_targets',
    description: 'Ručně přepiš denní cíle (kalorie/makra). Použij, když si uživatel řekne o konkrétní změnu, např. "chci víc bílkovin". Posílej jen měněná pole.',
    parameters: {
      type: 'OBJECT',
      properties: {
        calories: { type: 'INTEGER' },
        protein: { type: 'INTEGER' },
        carbs: { type: 'INTEGER' },
        fat: { type: 'INTEGER' },
        reason: { type: 'STRING', description: 'Krátký důvod změny' }
      }
    }
  },
  {
    name: 'set_workout_plan',
    description: 'Nastav kompletní týdenní tréninkový split (všech 7 dní). Netréninkové dny označ rest:true. Použij při prvním vygenerování plánu nebo při velké přestavbě.',
    parameters: {
      type: 'OBJECT',
      properties: {
        split: { type: 'STRING', description: 'Název splitu, např. "Push/Pull/Legs + Upper"' },
        days: { type: 'ARRAY', items: WORKOUT_DAY_SCHEMA, description: 'Všech 7 dní' }
      },
      required: ['split', 'days']
    }
  },
  {
    name: 'update_workout_day',
    description: 'Přepiš jeden konkrétní tréninkový den. Použij pro drobné úpravy, např. výměnu cviků nebo změnu dne na volno.',
    parameters: WORKOUT_DAY_SCHEMA
  },
  {
    name: 'swap_workout_days',
    description: 'Prohoď obsah dvou dnů v tréninkovém plánu. Použij když uživatel řekne "dnes nemám čas na nohy, přehoď to na zítra".',
    parameters: {
      type: 'OBJECT',
      properties: {
        dayA: { type: 'STRING', enum: DAY_KEYS },
        dayB: { type: 'STRING', enum: DAY_KEYS }
      },
      required: ['dayA', 'dayB']
    }
  },
  {
    name: 'set_meal_plan',
    description: 'Ulož jídelníček pro zadané dny. SLUČUJE — dny, které nepošleš, zůstanou beze změny, takže můžeš volat víckrát po částech. DŮLEŽITÉ: pošli NANEJVÝŠ 3 dny na jedno volání, jinak se odpověď nevejde do limitu a propadne. Každý den musí makry zhruba sedět na denní cíle.',
    parameters: {
      type: 'OBJECT',
      properties: {
        days: { type: 'ARRAY', items: MEAL_DAY_SCHEMA, description: 'Max 3 dny na jedno volání' }
      },
      required: ['days']
    }
  },
  {
    name: 'update_meal_plan_day',
    description: 'Přepiš jídelníček jednoho konkrétního dne.',
    parameters: MEAL_DAY_SCHEMA
  },
  {
    name: 'log_set',
    description: 'Zapiš odcvičenou sérii do historie cviku. Volej, když uživatel v chatu nahlásí, co zvedl (např. „dal jsem dneska bench 3x8 na 42,5"). Pro každou sérii jedna položka v poli sets. Když uživatel uvede jen jednu sérii, pošli jednu.',
    parameters: {
      type: 'OBJECT',
      properties: {
        exercise: { type: 'STRING', description: 'Název cviku česky, pokud možno přesně jak je v tréninkovém plánu' },
        date: { type: 'STRING', description: 'YYYY-MM-DD. Vynech pro dnešek.' },
        sets: {
          type: 'ARRAY',
          description: 'Odcvičené série',
          items: {
            type: 'OBJECT',
            properties: {
              weight: { type: 'NUMBER', description: 'Váha v kg' },
              reps: { type: 'INTEGER', description: 'Počet opakování' }
            },
            required: ['weight', 'reps']
          }
        }
      },
      required: ['exercise', 'sets']
    }
  },
  {
    name: 'replace_meal',
    description: 'Vyměň jedno konkrétní jídlo v jídelníčku za jiné. Použij když uživatel řekne "nemám rád losos, dej mi něco jinýho". Nové jídlo musí mít podobná makra jako to původní.',
    parameters: {
      type: 'OBJECT',
      properties: {
        day: { type: 'STRING', enum: DAY_KEYS },
        mealId: { type: 'STRING', description: 'ID jídla z kontextu jídelníčku' },
        meal: MEAL_SCHEMA
      },
      required: ['day', 'mealId', 'meal']
    }
  }
];

// ---------------------------------------------------------------------------
// Tool execution — pure over the plan state
// ---------------------------------------------------------------------------

function emptyPlanState() {
  return {
    profile: {},
    targets: null,
    workoutPlan: null,
    mealPlan: null
  };
}

// Applies one tool call. Mutates `state` and returns a result object that is
// fed back to the model (so it can confirm precisely what changed).
function applyTool(name, args, state) {
  const a = args || {};

  switch (name) {
    case 'save_profile': {
      const p = state.profile || (state.profile = {});
      ['goal', 'sex', 'experience', 'equipment'].forEach((k) => {
        if (a[k]) p[k] = String(a[k]);
      });
      ['age', 'heightCm', 'weightKg', 'trainingDaysPerWeek', 'sessionMinutes'].forEach((k) => {
        if (a[k] != null && Number.isFinite(Number(a[k]))) p[k] = Number(a[k]);
      });
      ['dietaryRestrictions', 'dislikes', 'allergies'].forEach((k) => {
        if (Array.isArray(a[k])) p[k] = a[k].map((s) => String(s).slice(0, 60)).slice(0, 20);
      });
      const missing = [];
      if (!p.sex) missing.push('pohlaví');
      if (!p.age) missing.push('věk');
      if (!p.heightCm) missing.push('výška');
      if (!p.weightKg) missing.push('váha');
      if (!p.goal) missing.push('cíl');
      if (p.trainingDaysPerWeek == null) missing.push('počet tréninků týdně');
      if (!p.equipment) missing.push('vybavení');
      if (!p.experience) missing.push('zkušenost');
      return {
        ok: true,
        profile: p,
        missingFields: missing,
        readyForTargets: missing.length === 0
      };
    }

    case 'compute_targets': {
      const p = state.profile || {};
      if (!p.weightKg || !p.heightCm || !p.age || !p.sex) {
        return { ok: false, error: 'Chybí základní údaje (pohlaví, věk, výška, váha) — nejdřív je zjisti a ulož přes save_profile.' };
      }
      const t = computeTargets(p);
      state.targets = { calories: t.calories, protein: t.protein, carbs: t.carbs, fat: t.fat };
      return { ok: true, ...t };
    }

    case 'set_targets': {
      const cur = state.targets || (state.profile && state.profile.weightKg ? computeTargets(state.profile) : null) || {};
      const t = {
        calories: a.calories != null ? Math.round(num(a.calories)) : num(cur.calories, 2000),
        protein: a.protein != null ? Math.round(num(a.protein)) : num(cur.protein, 130),
        carbs: a.carbs != null ? Math.round(num(a.carbs)) : num(cur.carbs, 220),
        fat: a.fat != null ? Math.round(num(a.fat)) : num(cur.fat, 65)
      };
      // If macros were changed but calories weren't, recompute calories to stay
      // internally consistent instead of leaving a contradictory target.
      if (a.calories == null && (a.protein != null || a.carbs != null || a.fat != null)) {
        t.calories = Math.round((t.protein * 4 + t.carbs * 4 + t.fat * 9) / 10) * 10;
      }
      state.targets = t;
      return { ok: true, targets: t, reason: a.reason || null };
    }

    case 'set_workout_plan': {
      const days = emptyWeek(() => ({ title: 'Volno', rest: true, focus: '', exercises: [] }));
      (a.days || []).forEach((d) => {
        const key = normDayKey(d && d.day);
        if (key) days[key] = normWorkoutDay(d);
      });
      const trainingDays = DAY_KEYS.filter((k) => !days[k].rest);
      state.workoutPlan = {
        split: String(a.split || 'Vlastní split').slice(0, 60),
        days,
        createdAt: (state.workoutPlan && state.workoutPlan.createdAt) || Date.now(),
        updatedAt: Date.now()
      };
      return {
        ok: true,
        split: state.workoutPlan.split,
        trainingDays: trainingDays.map((k) => `${DAY_CZ[k]}: ${days[k].title}`),
        restDays: DAY_KEYS.filter((k) => days[k].rest).map((k) => DAY_CZ[k])
      };
    }

    case 'update_workout_day': {
      const key = normDayKey(a.day);
      if (!key) return { ok: false, error: 'Neplatný den.' };
      if (!state.workoutPlan) {
        state.workoutPlan = {
          split: 'Vlastní split',
          days: emptyWeek(() => ({ title: 'Volno', rest: true, focus: '', exercises: [] })),
          createdAt: Date.now(), updatedAt: Date.now()
        };
      }
      state.workoutPlan.days[key] = normWorkoutDay(a);
      state.workoutPlan.updatedAt = Date.now();
      const d = state.workoutPlan.days[key];
      return {
        ok: true, day: DAY_CZ[key], title: d.title, rest: d.rest,
        exercises: d.exercises.map((e) => `${e.name} ${e.sets}×${e.reps}`)
      };
    }

    case 'swap_workout_days': {
      const A = normDayKey(a.dayA);
      const B = normDayKey(a.dayB);
      if (!A || !B) return { ok: false, error: 'Neplatné dny.' };
      if (!state.workoutPlan) return { ok: false, error: 'Tréninkový plán zatím neexistuje.' };
      const days = state.workoutPlan.days;
      const tmp = days[A];
      days[A] = days[B];
      days[B] = tmp;
      state.workoutPlan.updatedAt = Date.now();
      return {
        ok: true,
        swapped: `${DAY_CZ[A]} ↔ ${DAY_CZ[B]}`,
        [DAY_CZ[A]]: days[A].title,
        [DAY_CZ[B]]: days[B].title
      };
    }

    case 'set_meal_plan': {
      // MERGES rather than replaces: a full week of meals with per-ingredient
      // macros easily overruns the model's output-token limit, so the model is
      // told to deliver it in small batches. Only the days it sends are touched.
      const days = (state.mealPlan && state.mealPlan.days) || emptyWeek(() => ({ meals: [] }));
      const touched = [];
      (a.days || []).forEach((d) => {
        const key = normDayKey(d && d.day);
        if (key) { days[key] = normMealDay(d); touched.push(key); }
      });
      state.mealPlan = {
        days,
        createdAt: (state.mealPlan && state.mealPlan.createdAt) || Date.now(),
        updatedAt: Date.now()
      };
      const summary = {};
      touched.forEach((k) => {
        const kcal = days[k].meals.reduce((s, m) => s + m.calories, 0);
        summary[DAY_CZ[k]] = `${days[k].meals.length} jídel, ${kcal} kcal`;
      });
      const missing = DAY_KEYS.filter((k) => !days[k].meals.length);
      return {
        ok: true,
        savedDays: summary,
        emptyDays: missing.map((k) => DAY_CZ[k]),
        targets: state.targets
      };
    }

    case 'update_meal_plan_day': {
      const key = normDayKey(a.day);
      if (!key) return { ok: false, error: 'Neplatný den.' };
      if (!state.mealPlan) {
        state.mealPlan = { days: emptyWeek(() => ({ meals: [] })), createdAt: Date.now(), updatedAt: Date.now() };
      }
      state.mealPlan.days[key] = normMealDay(a);
      state.mealPlan.updatedAt = Date.now();
      const meals = state.mealPlan.days[key].meals;
      return {
        ok: true, day: DAY_CZ[key],
        meals: meals.map((m) => `${m.category}: ${m.name} (${m.calories} kcal)`),
        totalCalories: meals.reduce((s, m) => s + m.calories, 0)
      };
    }

    case 'log_set': {
      const exName = String(a.exercise || '').trim();
      if (!exName) return { ok: false, error: 'Chybí název cviku.' };
      const key = normalizeExerciseName(exName);
      if (!key) return { ok: false, error: 'Neplatný název cviku.' };

      const sets = (a.sets || [])
        .map((x) => ({
          w: Math.round(num(x && x.weight) * 10) / 10,
          r: Math.round(num(x && x.reps))
        }))
        .filter((x) => x.w > 0 && x.r > 0)
        .slice(0, 12);
      if (!sets.length) return { ok: false, error: 'Žádná platná série (váha i opakování musí být větší než nula).' };

      const date = (a.date && /^\d{4}-\d{2}-\d{2}$/.test(a.date)) ? a.date : todayPrague();

      if (!state.exerciseLogs || typeof state.exerciseLogs !== 'object') state.exerciseLogs = {};
      const logs = state.exerciseLogs;
      if (!logs[key]) logs[key] = { name: exName, sessions: [] };
      logs[key].name = exName;
      if (!Array.isArray(logs[key].sessions)) logs[key].sessions = [];

      const existed = logs[key].sessions.some((x) => x.date === date);
      logs[key].sessions = logs[key].sessions.filter((x) => x.date !== date);
      logs[key].sessions.push({ date, sets });
      logs[key].sessions.sort((x, y) => x.date.localeCompare(y.date));
      if (logs[key].sessions.length > 200) logs[key].sessions = logs[key].sessions.slice(-200);

      const volume = sets.reduce((t, x) => t + x.w * x.r, 0);
      const top = sets.reduce((b, x) => (x.w > b.w ? x : b), sets[0]);
      return {
        ok: true,
        exercise: exName,
        date,
        replacedExisting: existed,
        sets: sets.map((x) => `${x.w}kg×${x.r}`),
        topSet: `${top.w}kg×${top.r}`,
        volume: Math.round(volume)
      };
    }

    case 'replace_meal': {
      const key = normDayKey(a.day);
      if (!key) return { ok: false, error: 'Neplatný den.' };
      if (!state.mealPlan || !state.mealPlan.days[key]) return { ok: false, error: 'Jídelníček zatím neexistuje.' };
      const meals = state.mealPlan.days[key].meals;
      const idx = meals.findIndex((m) => m.id === a.mealId);
      if (idx === -1) return { ok: false, error: `Jídlo s id ${a.mealId} nenalezeno v ${DAY_CZ[key]}.` };
      const fresh = normMeal(a.meal);
      if (!fresh) return { ok: false, error: 'Nové jídlo je prázdné.' };
      const old = meals[idx];
      fresh.id = old.id; // keep the id stable so "eaten" checkmarks survive
      meals[idx] = fresh;
      meals.sort((x, y) => MEAL_CATEGORIES.indexOf(x.category) - MEAL_CATEGORIES.indexOf(y.category));
      state.mealPlan.updatedAt = Date.now();
      return {
        ok: true, day: DAY_CZ[key],
        replaced: `${old.name} (${old.calories} kcal)`,
        withMeal: `${fresh.name} (${fresh.calories} kcal)`,
        calorieDelta: fresh.calories - old.calories
      };
    }

    default:
      return { ok: false, error: `Neznámý nástroj: ${name}` };
  }
}

// ---------------------------------------------------------------------------
// Context formatters for the system prompt
// ---------------------------------------------------------------------------

function fmtProfile(p) {
  if (!p || !Object.keys(p).length) return 'Profil ještě není vyplněný — uživatel je nový.';
  const goalCz = { recomp: 'rekompozice (víc svalů, míň tuku)', cut: 'hubnutí', bulk: 'nabírání' };
  const expCz = { beginner: 'začátečník', intermediate: 'pokročilý', advanced: 'zkušený' };
  const eqCz = { gym: 'posilovna', home: 'domácí vybavení', minimal: 'jen vlastní váha' };
  const l = [];
  if (p.sex) l.push(`- Pohlaví: ${p.sex === 'female' ? 'žena' : 'muž'}`);
  if (p.age) l.push(`- Věk: ${p.age} let`);
  if (p.heightCm) l.push(`- Výška: ${p.heightCm} cm`);
  if (p.weightKg) l.push(`- Váha: ${p.weightKg} kg`);
  if (p.goal) l.push(`- Cíl: ${goalCz[p.goal] || p.goal}`);
  if (p.trainingDaysPerWeek != null) l.push(`- Tréninků týdně: ${p.trainingDaysPerWeek}${p.sessionMinutes ? ` (${p.sessionMinutes} min)` : ''}`);
  if (p.experience) l.push(`- Zkušenost: ${expCz[p.experience] || p.experience}`);
  if (p.equipment) l.push(`- Vybavení: ${eqCz[p.equipment] || p.equipment}`);
  if (p.dietaryRestrictions && p.dietaryRestrictions.length) l.push(`- Dietní omezení: ${p.dietaryRestrictions.join(', ')}`);
  if (p.dislikes && p.dislikes.length) l.push(`- Nemá rád: ${p.dislikes.join(', ')}`);
  if (p.allergies && p.allergies.length) l.push(`- ALERGIE (nikdy nenavrhuj): ${p.allergies.join(', ')}`);
  return l.join('\n');
}

function fmtTargets(t) {
  if (!t) return 'Cíle ještě nejsou spočítané.';
  return `${t.calories} kcal · B ${t.protein} g · S ${t.carbs} g · T ${t.fat} g`;
}

function fmtWorkoutPlan(plan, todayKey) {
  if (!plan || !plan.days) return 'Tréninkový plán zatím neexistuje.';
  const l = [`Split: ${plan.split}`];
  DAY_KEYS.forEach((k) => {
    const d = plan.days[k];
    if (!d) return;
    const mark = k === todayKey ? ' ← DNES' : '';
    if (d.rest) {
      l.push(`${DAY_CZ[k]}: volno${mark}`);
    } else {
      const ex = d.exercises.map((e) => `${e.name} ${e.sets}×${e.reps}`).join(', ');
      l.push(`${DAY_CZ[k]}: ${d.title}${mark} — ${ex}`);
    }
  });
  return l.join('\n');
}

function fmtMealPlan(plan, todayKey) {
  if (!plan || !plan.days) return 'Jídelníček zatím neexistuje.';
  const l = [];
  DAY_KEYS.forEach((k) => {
    const d = plan.days[k];
    if (!d || !d.meals.length) return;
    const mark = k === todayKey ? ' ← DNES' : '';
    const kcal = d.meals.reduce((s, m) => s + m.calories, 0);
    l.push(`${DAY_CZ[k]}${mark} (${kcal} kcal):`);
    d.meals.forEach((m) => {
      l.push(`  • [id:${m.id}] ${m.category} — ${m.name} (${m.calories} kcal, B ${m.protein})`);
    });
  });
  return l.length ? l.join('\n') : 'Jídelníček zatím neexistuje.';
}

// Fill any day with no meals by rotating the days that do have them.
//
// Generating seven genuinely distinct days of food in one shot is what used to
// blow the output-token limit. The model now writes a few solid days and the
// rotation gives the user a complete week straight away; they can still ask the
// coach to regenerate any single day afterwards. Returns the days it filled.
function fillMealWeek(mealPlan) {
  if (!mealPlan || !mealPlan.days) return [];
  const source = DAY_KEYS.filter((k) => mealPlan.days[k] && mealPlan.days[k].meals.length);
  if (!source.length || source.length === DAY_KEYS.length) return [];

  const filled = [];
  let i = 0;
  DAY_KEYS.forEach((k) => {
    if (mealPlan.days[k] && mealPlan.days[k].meals.length) return;
    const template = mealPlan.days[source[i % source.length]];
    i++;
    // Fresh ids so ticking a meal off on Tuesday doesn't tick Monday too.
    mealPlan.days[k] = {
      meals: template.meals.map((m) => Object.assign({}, m, {
        id: genId('meal'),
        items: m.items.map((it) => Object.assign({}, it))
      }))
    };
    filled.push(k);
  });
  if (filled.length) mealPlan.updatedAt = Date.now();
  return filled;
}

// Today's date in Prague, matching the key the app stores logs under.
function todayPrague() {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
  } catch (e) {
    return new Date().toISOString().split('T')[0];
  }
}

// Recent lifting history, so the coach can push progression and spot stalls.
function fmtExerciseHistory(list) {
  if (!Array.isArray(list) || !list.length) return 'Zatím žádná historie vah.';
  return list.map((e) => {
    const rows = (e.recent || [])
      .map((r) => `    ${r.date}: ${r.sets} (objem ${r.volume} kg)`)
      .join('\n');
    return `- ${e.name}${e.stalled ? ' [STAGNUJE — 3 tréninky bez posunu]' : ''}\n${rows}`;
  }).join('\n');
}

// Weekday key for a YYYY-MM-DD date string (or today in Prague).
function dayKeyForDate(dateStr) {
  let d;
  if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    d = new Date(`${dateStr}T12:00:00Z`);
  } else {
    d = new Date();
  }
  // getUTCDay: 0=Sun..6=Sat → our array starts Monday.
  const idx = (d.getUTCDay() + 6) % 7;
  return DAY_KEYS[idx];
}

module.exports = {
  DAY_KEYS, DAY_CZ, MEAL_CATEGORIES, ACTIVITY_FACTORS,
  mifflinStJeor, computeTargets,
  TOOL_DECLARATIONS, applyTool, emptyPlanState, fillMealWeek,
  fmtProfile, fmtTargets, fmtWorkoutPlan, fmtMealPlan, fmtExerciseHistory,
  normalizeExerciseName, todayPrague,
  dayKeyForDate, normDayKey
};
