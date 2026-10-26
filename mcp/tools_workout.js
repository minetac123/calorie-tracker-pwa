// FitAI MCP Server - Workout & Training Tools Module
const {
  applyTool, fmtWorkoutPlan, dayKeyForDate, normDayKey, DAY_CZ
} = require('../api/_lib/plans');
const { applyWorkoutOpsTool } = require('../api/_lib/tools_workout');
const { applyStatsTool } = require('../api/_lib/tools_stats');

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function registerWorkoutTools(client) {
  const tools = [];

  function def(name, description, inputSchema, handler) {
    tools.push({
      name,
      description,
      inputSchema: {
        type: 'object',
        properties: inputSchema.properties || {},
        required: inputSchema.required || []
      },
      handler
    });
  }

  def(
    'get_workout_plan',
    'Získá kompletní týdenní tréninkový split (pondělí až neděle), včetně všech cviků, sérií, opakování, vah a pauz. Volitelně lze vyfiltrovat jen jeden den.',
    {
      properties: {
        day: {
          type: 'string',
          enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
          description: 'Volitelný klíč dne v týdnu (mon, tue, wed, thu, fri, sat, sun).'
        }
      }
    },
    async (args) => {
      const state = await client.getState();
      const plan = state.workoutPlan;
      if (!plan || !plan.days) {
        return 'V aplikaci zatím není nastaven žádný tréninkový plán.';
      }
      if (args.day) {
        const k = normDayKey(args.day);
        const dayData = plan.days[k];
        if (!dayData) return `Den "${args.day}" v plánu neexistuje.`;
        return JSON.stringify({ day: DAY_CZ[k] || k, ...dayData }, null, 2);
      }
      return fmtWorkoutPlan(plan);
    }
  );

  def(
    'get_today_workout',
    'Získá naplánovaný workout na dnešek (nebo zadané datum), včetně stavu zda je volno (rest day) a detailů cviků.',
    {
      properties: {
        date: {
          type: 'string',
          description: 'Datum ve formátu YYYY-MM-DD (výchozí je dnešek).'
        }
      }
    },
    async (args) => {
      const state = await client.getState();
      const d = args.date || todayStr();
      const k = dayKeyForDate(d);
      const dayData = state.workoutPlan?.days?.[k];
      if (!dayData) return `Pro den ${DAY_CZ[k] || k} (${d}) nebyl nalezen rozpis.`;
      return JSON.stringify({
        date: d,
        dayName: DAY_CZ[k] || k,
        isRestDay: !!dayData.rest,
        workoutName: dayData.name || '',
        exercisesCount: (dayData.exercises || []).length,
        exercises: dayData.exercises || []
      }, null, 2);
    }
  );

  def(
    'set_workout_plan',
    'Kompletně nastaví nebo přepíše týdenní tréninkový plán pro všech 7 dní (pondělí až neděle).',
    {
      required: ['plan'],
      properties: {
        plan: {
          type: 'object',
          description: 'Objekt plánu obsahující klíč days (mon, tue, wed, thu, fri, sat, sun).'
        }
      }
    },
    async (args) => {
      const state = await client.getState();
      const res = applyTool('save_workout_plan', args.plan, state);
      if (res && res.error) throw new Error(res.error);
      await client.saveState(state);
      return `Tréninkový plán byl úspěšně uložen!\n\n${fmtWorkoutPlan(state.workoutPlan)}`;
    }
  );

  def(
    'update_workout_day',
    'Upraví trénink pro jeden konkrétní den v týdnu (název dne, příznak rest day, seznam cviků).',
    {
      required: ['day'],
      properties: {
        day: {
          type: 'string',
          description: 'Den v týdnu (mon, tue, wed, thu, fri, sat, sun nebo pondělí-neděle).'
        },
        name: { type: 'string', description: 'Nový název dne (např. "Push - Hrudník & Ramena").' },
        rest: { type: 'boolean', description: 'Zda je den dnem volna (rest day).' },
        exercises: {
          type: 'array',
          items: { type: 'object' },
          description: 'Kompletní nové pole cviků pro tento den.'
        }
      }
    },
    async (args) => {
      const state = await client.getState();
      const k = normDayKey(args.day);
      if (!k) throw new Error(`Neznámý den "${args.day}"`);
      if (!state.workoutPlan) state.workoutPlan = { days: {} };
      if (!state.workoutPlan.days) state.workoutPlan.days = {};

      const current = state.workoutPlan.days[k] || { name: DAY_CZ[k], rest: false, exercises: [] };
      if (args.name !== undefined) current.name = args.name;
      if (args.rest !== undefined) current.rest = !!args.rest;
      if (Array.isArray(args.exercises)) current.exercises = args.exercises;

      state.workoutPlan.days[k] = current;
      await client.saveState(state);
      return `Den ${DAY_CZ[k]} byl úspěšně aktualizován. Počet cviků: ${current.exercises.length}, rest day: ${current.rest ? 'ano' : 'ne'}.`;
    }
  );

  def(
    'add_exercise_to_plan',
    'Přidá nový cvik do konkrétního tréninkového dne v plánu.',
    {
      required: ['day', 'name'],
      properties: {
        day: { type: 'string', description: 'Den v týdnu (mon, tue, wed, thu, fri, sat, sun).' },
        name: { type: 'string', description: 'Přesný název cviku (např. "Incline Dumbbell Press").' },
        sets: { type: 'number', description: 'Počet pracovních sérií (např. 3 nebo 4).' },
        reps: { type: 'string', description: 'Počet opakování nebo rozsah (např. "8-10", "12").' },
        weight: { type: 'string', description: 'Plánovaná váha (např. "32 kg", "vlastní váha").' },
        restSec: { type: 'number', description: 'Délka pauzy mezi sériemi v sekundách (výchozí 90).' },
        note: { type: 'string', description: 'Poznámka k provedení, tempu či technice.' },
        position: { type: 'number', description: 'Pozice v pořadí cviků (1 pro začátek, výchozí na konec).' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const res = applyWorkoutOpsTool('add_exercise', {
        day: normDayKey(args.day),
        name: args.name,
        sets: args.sets || 3,
        reps: String(args.reps || '10'),
        weight: args.weight,
        restSec: args.restSec || 90,
        note: args.note,
        position: args.position
      }, state);

      if (!res.ok) throw new Error(res.error);
      await client.saveState(state);
      return res.note || `Cvik "${args.name}" byl úspěšně přidán do dne ${args.day}.`;
    }
  );

  def(
    'remove_exercise_from_plan',
    'Odebere cvik z konkrétního tréninkového dne podle názvu nebo ID.',
    {
      required: ['day', 'exerciseRef'],
      properties: {
        day: { type: 'string', description: 'Den v týdnu (mon, tue...).' },
        exerciseRef: { type: 'string', description: 'Název nebo ID cviku k odebrání.' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const res = applyWorkoutOpsTool('remove_exercise', {
        day: normDayKey(args.day),
        exerciseRef: args.exerciseRef
      }, state);

      if (!res.ok) throw new Error(res.error);
      await client.saveState(state);
      return res.note || `Cvik "${args.exerciseRef}" byl odebrán ze dne ${args.day}.`;
    }
  );

  def(
    'substitute_exercise',
    'Nahradí existující cvik v tréninku alternativním cvikem se zachováním nebo úpravou sérií a vah.',
    {
      required: ['day', 'exerciseRef', 'newExerciseName'],
      properties: {
        day: { type: 'string', description: 'Den v týdnu.' },
        exerciseRef: { type: 'string', description: 'Původní cvik k nahrazení.' },
        newExerciseName: { type: 'string', description: 'Nový náhradní cvik.' },
        reason: { type: 'string', description: 'Důvod výměny (např. obsazený stroj, bolest ramene).' },
        sets: { type: 'number', description: 'Volitelný nový počet sérií.' },
        reps: { type: 'string', description: 'Volitelný nový rozsah opakování.' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const res = applyWorkoutOpsTool('substitute_exercise', {
        day: normDayKey(args.day),
        exerciseRef: args.exerciseRef,
        new_name: args.newExerciseName,
        reason: args.reason,
        sets: args.sets,
        reps: args.reps
      }, state);

      if (!res.ok) throw new Error(res.error);
      await client.saveState(state);
      return res.note || `Cvik byl úspěšně vyměněn za "${args.newExerciseName}".`;
    }
  );

  def(
    'reorder_plan_exercises',
    'Změní pořadí cviků v tréninkovém dni.',
    {
      required: ['day', 'exerciseOrder'],
      properties: {
        day: { type: 'string', description: 'Den v týdnu.' },
        exerciseOrder: {
          type: 'array',
          items: { type: 'string' },
          description: 'Seřazené pole názvů cviků přesně v pořadí, jak mají jít po sobě.'
        }
      }
    },
    async (args) => {
      const state = await client.getState();
      const res = applyWorkoutOpsTool('reorder_exercises', {
        day: normDayKey(args.day),
        order: args.exerciseOrder
      }, state);

      if (!res.ok) throw new Error(res.error);
      await client.saveState(state);
      return res.note || `Pořadí cviků ve dni ${args.day} bylo upraveno.`;
    }
  );

  def(
    'set_rest_day',
    'Nastaví daný den jako den volna (rest day) nebo naopak z něj udělá aktivní tréninkový den.',
    {
      required: ['day', 'rest'],
      properties: {
        day: { type: 'string', description: 'Den v týdnu.' },
        rest: { type: 'boolean', description: 'true pro rest day, false pro trénink.' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const res = applyWorkoutOpsTool('set_rest_day', {
        day: normDayKey(args.day),
        rest: args.rest
      }, state);

      if (!res.ok) throw new Error(res.error);
      await client.saveState(state);
      return res.note || `Den ${args.day} byl upraven (rest day: ${args.rest}).`;
    }
  );

  def(
    'copy_workout_day',
    'Zkopíruje trénink z jednoho dne do druhého dne v týdnu.',
    {
      required: ['fromDay', 'toDay'],
      properties: {
        fromDay: { type: 'string', description: 'Zdrojový den (mon, tue...).' },
        toDay: { type: 'string', description: 'Cílový den (mon, tue...).' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const res = applyWorkoutOpsTool('copy_day', {
        fromDay: normDayKey(args.fromDay),
        toDay: normDayKey(args.toDay)
      }, state);

      if (!res.ok) throw new Error(res.error);
      await client.saveState(state);
      return res.note || `Trénink z ${args.fromDay} zkopírován do ${args.toDay}.`;
    }
  );

  def(
    'swap_workout_days',
    'Prohodí kompletní tréninky mezi dvěma dny v týdnu.',
    {
      required: ['dayA', 'dayB'],
      properties: {
        dayA: { type: 'string', description: 'První den (např. pondělí).' },
        dayB: { type: 'string', description: 'Druhý den (např. sobota).' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const res = applyWorkoutOpsTool('swap_days', {
        dayA: normDayKey(args.dayA),
        dayB: normDayKey(args.dayB)
      }, state);

      if (!res.ok) throw new Error(res.error);
      await client.saveState(state);
      return res.note || `Dny ${args.dayA} a ${args.dayB} byly prohozeny.`;
    }
  );

  def(
    'progress_exercise',
    'Zvýší cílovou váhu nebo počet opakování u cviku pro progresivní přetížení (např. +2.5 kg).',
    {
      required: ['exerciseName'],
      properties: {
        exerciseName: { type: 'string', description: 'Název cviku k progresu.' },
        addWeightKg: { type: 'number', description: 'Kolik kg přidat (např. 2.5).' },
        addReps: { type: 'number', description: 'Kolik opakování přidat (např. 1 nebo 2).' },
        day: { type: 'string', description: 'Volitelný den v plánu (mon, tue...); pokud není zadán, prohledá celý split.' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const res = applyWorkoutOpsTool('progress_exercise', {
        name: args.exerciseName,
        add_weight: args.addWeightKg,
        add_reps: args.addReps,
        day: args.day ? normDayKey(args.day) : undefined
      }, state);

      if (!res.ok) throw new Error(res.error);
      await client.saveState(state);
      return res.note || `Progres cviku "${args.exerciseName}" byl úspěšně zaznamenán.`;
    }
  );

  def(
    'suggest_warmup_sets',
    'Spočítá přesnou pyramidu rozcvičkových sérií pro daný cvik podle plánované pracovní váhy.',
    {
      properties: {
        exerciseName: { type: 'string', description: 'Název cviku (např. Dřep, Bench press).' },
        targetWeightKg: { type: 'number', description: 'Pracovní váha v kg (např. 90).' },
        day: { type: 'string', description: 'Volitelný klíč dne v plánu (mon, tue...).' }
      }
    },
    async (args) => {
      const targetWeight = Number(args.targetWeightKg || 0);
      if (targetWeight > 0) {
        const warmup = [
          { percent: 40, weight: Math.max(20, Math.round((targetWeight * 0.4) / 2.5) * 2.5), reps: 8, restSec: 60 },
          { percent: 60, weight: Math.max(20, Math.round((targetWeight * 0.6) / 2.5) * 2.5), reps: 5, restSec: 90 },
          { percent: 80, weight: Math.max(20, Math.round((targetWeight * 0.8) / 2.5) * 2.5), reps: 3, restSec: 120 }
        ];
        return JSON.stringify({
          exercise: args.exerciseName || 'Cvik',
          workingWeightKg: targetWeight,
          warmupSets: warmup,
          tip: 'Rozcvička připraví CNS a klouby bez vyčerpání svalových glykogenových zásob.'
        }, null, 2);
      }

      const state = await client.getState();
      const dayKey = args.day ? normDayKey(args.day) : 'mon';
      const res = applyWorkoutOpsTool('suggest_warmup_sets', {
        day: dayKey,
        exerciseRef: args.exerciseName
      }, state);

      if (!res.ok) throw new Error(res.error);
      return JSON.stringify(res, null, 2);
    }
  );

  def(
    'deload_week',
    'Nastaví odlehčovací deload týden: sníží pracovní váhy a počet sérií pro regeneraci svalů a kloubů.',
    {
      properties: {
        intensityReductionPct: { type: 'number', description: 'O kolik % snížit váhy (výchozí 10-15%).' },
        volumeReductionPct: { type: 'number', description: 'O kolik % snížit počet sérií (výchozí 30-40%).' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const res = applyWorkoutOpsTool('deload_week', {
        intensity_pct: args.intensityReductionPct,
        volume_pct: args.volumeReductionPct
      }, state);

      if (!res.ok) throw new Error(res.error);
      await client.saveState(state);
      return res.note || 'Deload týden byl úspěšně aplikován.';
    }
  );

  def(
    'extend_or_shorten_workout',
    'Přizpůsobí délku tréninku (přidá doplňky nebo naopak ořeže méně podstatné cviky, pokud uživatel spěchá).',
    {
      required: ['day', 'mode'],
      properties: {
        day: { type: 'string', description: 'Den v týdnu.' },
        mode: {
          type: 'string',
          enum: ['shorten', 'extend'],
          description: 'Zda trénink zkrátit (odstranit doplňky) nebo prodloužit (přidat pumpovací cvik).'
        },
        targetMinutes: { type: 'number', description: 'Cílový čas v minutách (např. 45 min pro rychlý trénink).' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const res = applyWorkoutOpsTool('extend_or_shorten_workout', {
        day: normDayKey(args.day),
        mode: args.mode,
        target_minutes: args.targetMinutes
      }, state);

      if (!res.ok) throw new Error(res.error);
      await client.saveState(state);
      return res.note || `Trénink byl upraven dle požadavku na čas.`;
    }
  );

  def(
    'set_exercise_tempo_and_notes',
    'Nastaví tréninkové tempo (např. 3-0-1-0 pro hypertrofii) a poznámky k technice pro konkrétní cvik.',
    {
      required: ['day', 'exerciseRef'],
      properties: {
        day: { type: 'string', description: 'Den v týdnu.' },
        exerciseRef: { type: 'string', description: 'Název nebo ID cviku.' },
        tempo: { type: 'string', description: 'Tempo provádění (např. "3-1-1-0", "kontrolovaná excentrika 3s").' },
        note: { type: 'string', description: 'Trenérská instrukce k technice či pocitu.' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const res = applyWorkoutOpsTool('set_exercise_notes', {
        day: normDayKey(args.day),
        exerciseRef: args.exerciseRef,
        tempo: args.tempo,
        note: args.note
      }, state);

      if (!res.ok) throw new Error(res.error);
      await client.saveState(state);
      return res.note || 'Poznámky a tempo cviku byly uloženy.';
    }
  );

  def(
    'get_exercise_history',
    'Získá kompletní historii sérií, vah a opakování pro konkrétní cvik včetně osobního rekordu (PR).',
    {
      required: ['exerciseName'],
      properties: {
        exerciseName: { type: 'string', description: 'Název cviku.' },
        limit: { type: 'number', description: 'Počet posledních tréninků (výchozí 10).' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const res = applyStatsTool('get_exercise_history', {
        exerciseName: args.exerciseName,
        limit: args.limit || 10
      }, state);
      return JSON.stringify(res, null, 2);
    }
  );

  def(
    'list_all_known_exercises',
    'Vrátí seznam všech cviků, které uživatel kdy odcvičil, s jejich maximální váhou (PR) a datem posledního tréninku.',
    {},
    async () => {
      const state = await client.getState();
      const exLogs = state.exerciseLogs || {};
      const list = Object.entries(exLogs).map(([name, log]) => ({
        name,
        prWeight: log.prWeight || null,
        prReps: log.prReps || null,
        lastDate: log.lastDate || null,
        totalSetsLogged: (log.history || []).length
      }));
      return JSON.stringify(list, null, 2);
    }
  );

  def(
    'log_set',
    'Zapíše jednu odcvičenou sérii (váha v kg, počet opakování, volitelně RPE a poznámka) do historie cviku.',
    {
      required: ['exerciseName', 'weightKg', 'reps'],
      properties: {
        exerciseName: { type: 'string', description: 'Název odcvičeného cviku.' },
        weightKg: { type: 'number', description: 'Váha na čince / stroji v kg.' },
        reps: { type: 'number', description: 'Počet provedených opakování.' },
        rpe: { type: 'number', description: 'Míra vnímaného úsilí RPE 1-10 (např. 8.5).' },
        note: { type: 'string', description: 'Poznámka k sérii.' },
        date: { type: 'string', description: 'Datum ve formátu YYYY-MM-DD (výchozí dnešek).' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const d = args.date || todayStr();
      const res = applyStatsTool('log_set', {
        exerciseName: args.exerciseName,
        weight: args.weightKg,
        reps: args.reps,
        rpe: args.rpe,
        note: args.note,
        date: d
      }, state);

      if (!res.ok) throw new Error(res.error);
      await client.saveState(state);
      return res.note || `Série zapsána: ${args.exerciseName} — ${args.weightKg} kg × ${args.reps} op. (${d}).`;
    }
  );

  def(
    'log_workout_session',
    'Zapíše kompletně odjetý trénink (datum, název, trvání, poznámka trenéra a odcvičené cviky).',
    {
      required: ['workoutName'],
      properties: {
        workoutName: { type: 'string', description: 'Název tréninku (např. "Push A").' },
        durationMinutes: { type: 'number', description: 'Doba trvání tréninku v minutách.' },
        rating: { type: 'number', description: 'Hodnocení tréninku 1-5.' },
        notes: { type: 'string', description: 'Shrnutí pocitu, pumpy a trenérské postřehy.' },
        date: { type: 'string', description: 'Datum YYYY-MM-DD (výchozí dnešek).' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const d = args.date || todayStr();
      if (!Array.isArray(state.sessionHistory)) state.sessionHistory = [];

      const session = {
        id: 'sess_' + Date.now().toString(36),
        date: d,
        workoutName: args.workoutName,
        durationMinutes: args.durationMinutes || 60,
        rating: args.rating || 5,
        notes: args.notes || '',
        createdAt: new Date().toISOString()
      };

      state.sessionHistory.unshift(session);
      await client.saveState(state);
      return `Tréninková session "${args.workoutName}" byla uložena do historie (${d}, ${session.durationMinutes} min).`;
    }
  );

  def(
    'get_session_history',
    'Získá historii dokončených tréninkových jednotek (sessions).',
    {
      properties: {
        limit: { type: 'number', description: 'Počet posledních sessions (výchozí 10).' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const hist = (state.sessionHistory || []).slice(0, args.limit || 10);
      return JSON.stringify(hist, null, 2);
    }
  );

  return tools;
}

module.exports = { registerWorkoutTools };
