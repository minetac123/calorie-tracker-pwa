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
      const dStr = args.date || todayStr();
      const k = dayKeyForDate(dStr);
      const dayData = state.workoutPlan?.days?.[k];
      if (!dayData) {
        return `Pro datum ${dStr} (${DAY_CZ[k] || k}) není nalezen žádný rozpis.`;
      }
      if (dayData.rest) {
        return `Dnes (${DAY_CZ[k]} ${dStr}) je REST DAY (volno na regeneraci). Odpočívej, doplň bílkoviny a naber sílu.`;
      }
      return JSON.stringify({
        datum: dStr,
        den: DAY_CZ[k],
        nazev: dayData.name || 'Trénink',
        pocetCviku: dayData.exercises?.length || 0,
        cviky: dayData.exercises || []
      }, null, 2);
    }
  );

  def(
    'set_workout_plan',
    'Kompletně nastaví nebo přepíše 7denní tréninkový plán (split od pondělí do neděle).',
    {
      required: ['days'],
      properties: {
        splitName: { type: 'string', description: 'Název splitu (např. Push-Pull-Legs, Upper-Lower, Arnold Split).' },
        days: {
          type: 'object',
          description: 'Objekt se 7 dny (mon, tue, wed, thu, fri, sat, sun). Každý den obsahuje name, rest (boolean) a pole exercises [{ name, sets, reps, weight?, restSec?, note? }].'
        }
      }
    },
    async (args) => {
      const state = await client.getState();
      const res = applyTool('set_workout_plan', { workoutPlan: { days: args.days, splitName: args.splitName } }, state);
      if (res && res.error) throw new Error(res.error);
      const sync = await client.saveState(state);
      return `Tréninkový plán byl úspěšně nastaven. ${sync.cloudSynced ? 'Synchronizováno s cloudem.' : 'Uloženo lokálně.'}`;
    }
  );

  def(
    'update_workout_day',
    'Upraví konkrétní tréninkový den v plánu (např. název, zda je rest day, nebo seznam cviků).',
    {
      required: ['day'],
      properties: {
        day: { type: 'string', description: 'Den v týdnu: mon, tue, wed, thu, fri, sat, sun (nebo česky Pondělí, Úterý...).' },
        name: { type: 'string', description: 'Nový název dne (např. Tlaky / Hrudník & Ramena).' },
        rest: { type: 'boolean', description: 'Zda je den dnem volna (rest day).' },
        exercises: {
          type: 'array',
          items: { type: 'object' },
          description: 'Nový kompletní seznam cviků pro daný den [{ name, sets, reps, weight?, restSec?, note? }].'
        }
      }
    },
    async (args) => {
      const state = await client.getState();
      const k = normDayKey(args.day);
      if (!k) throw new Error(`Neznámý den: ${args.day}`);
      const curDay = state.workoutPlan?.days?.[k] || { name: 'Trénink', rest: false, exercises: [] };
      const updatedDay = {
        name: args.name !== undefined ? args.name : curDay.name,
        rest: args.rest !== undefined ? args.rest : curDay.rest,
        exercises: args.exercises !== undefined ? args.exercises : curDay.exercises
      };
      const res = applyTool('update_workout_day', { day: k, ...updatedDay }, state);
      if (res && res.error) throw new Error(res.error);
      const sync = await client.saveState(state);
      return `Den ${DAY_CZ[k]} byl úspěšně upraven. ${sync.cloudSynced ? 'Synchronizováno s cloudem.' : 'Uloženo lokálně.'}`;
    }
  );

  def(
    'add_exercise_to_plan',
    'Přidá nový cvik do konkrétního dne v tréninkovém plánu.',
    {
      required: ['day', 'name', 'sets', 'reps'],
      properties: {
        day: { type: 'string', description: 'Klíč dne (mon, tue, wed, thu, fri, sat, sun).' },
        name: { type: 'string', description: 'Název cviku (např. Bench press, Dřep, Shyby, Rozpažky s jednoručkami).' },
        sets: { type: 'number', description: 'Počet pracovních sérií (např. 3 nebo 4).' },
        reps: { type: 'string', description: 'Počet opakování (např. "6-8", "8-10", "12").' },
        weight: { type: 'string', description: 'Cílová váha nebo poznámka (např. "80 kg", "vlastní váha").' },
        restSec: { type: 'number', description: 'Pauza mezi sériemi v sekundách (např. 90, 120).' },
        note: { type: 'string', description: 'Trenérská poznámka k provedení (RPE, tempo, úchop).' },
        position: { type: 'number', description: 'Pozice v tréninku (1 pro první cvik, atd.). Pokud není uvedeno, přidá se na konec.' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const k = normDayKey(args.day);
      const res = applyWorkoutOpsTool('add_exercise_to_plan_day', {
        day: k,
        name: args.name,
        sets: args.sets,
        reps: args.reps,
        weight: args.weight,
        restSec: args.restSec,
        note: args.note,
        position: args.position
      }, state);

      if (!res.ok) throw new Error(res.error);
      await client.saveState(state);
      return res.note || `Cvik "${args.name}" byl úspěšně přidán do ${DAY_CZ[k]}.`;
    }
  );

  def(
    'remove_exercise_from_plan',
    'Odebere cvik z konkrétního dne v tréninkovém plánu.',
    {
      required: ['day'],
      properties: {
        day: { type: 'string', description: 'Klíč dne (mon, tue, wed, thu, fri, sat, sun).' },
        exerciseName: { type: 'string', description: 'Název cviku, který se má odebrat.' },
        exerciseId: { type: 'string', description: 'ID cviku (pokud je známo).' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const k = normDayKey(args.day);
      const res = applyWorkoutOpsTool('remove_exercise_from_plan_day', {
        day: k,
        name: args.exerciseName,
        id: args.exerciseId
      }, state);

      if (!res.ok) throw new Error(res.error);
      await client.saveState(state);
      return res.note || `Cvik byl odebrán z ${DAY_CZ[k]}.`;
    }
  );

  def(
    'substitute_exercise',
    'Nahradí jeden cvik v tréninku jiným (např. z důvodu zranění, obsazeného stroje nebo pestrosti).',
    {
      required: ['day', 'oldExercise', 'newExercise'],
      properties: {
        day: { type: 'string', description: 'Klíč dne (mon, tue...).' },
        oldExercise: { type: 'string', description: 'Původní cvik k nahrazení.' },
        newExercise: { type: 'string', description: 'Nový náhradní cvik.' },
        sets: { type: 'number', description: 'Počet sérií nového cviku (výchozí zachová původní).' },
        reps: { type: 'string', description: 'Opakování nového cviku (výchozí zachová původní).' },
        reason: { type: 'string', description: 'Důvod výměny (poznámka pro uživatele).' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const k = normDayKey(args.day);
      const res = applyWorkoutOpsTool('substitute_exercise', {
        day: k,
        old_name: args.oldExercise,
        new_name: args.newExercise,
        sets: args.sets,
        reps: args.reps,
        reason: args.reason
      }, state);

      if (!res.ok) throw new Error(res.error);
      await client.saveState(state);
      return res.note || `Cvik "${args.oldExercise}" byl v ${DAY_CZ[k]} nahrazen za "${args.newExercise}".`;
    }
  );

  def(
    'reorder_plan_exercises',
    'Změní pořadí cviků v daném tréninkovém dni.',
    {
      required: ['day', 'exerciseName', 'newPosition'],
      properties: {
        day: { type: 'string', description: 'Klíč dne (mon, tue...).' },
        exerciseName: { type: 'string', description: 'Název cviku, který se má posunout.' },
        newPosition: { type: 'number', description: 'Nová pozice (1 pro první cvik).' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const k = normDayKey(args.day);
      const res = applyWorkoutOpsTool('reorder_plan_exercises', {
        day: k,
        name: args.exerciseName,
        position: args.newPosition
      }, state);

      if (!res.ok) throw new Error(res.error);
      await client.saveState(state);
      return res.note || `Pořadí cviku "${args.exerciseName}" bylo upraveno.`;
    }
  );

  def(
    'set_rest_day',
    'Nastaví zadaný den jako den volna (rest day) nebo naopak z něj udělá tréninkový den.',
    {
      required: ['day', 'rest'],
      properties: {
        day: { type: 'string', description: 'Klíč dne (mon, tue...).' },
        rest: { type: 'boolean', description: 'true pro den volna, false pro tréninkový den.' },
        note: { type: 'string', description: 'Volitelná poznámka.' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const k = normDayKey(args.day);
      const res = applyWorkoutOpsTool('set_rest_day', {
        day: k,
        rest: args.rest,
        note: args.note
      }, state);

      if (!res.ok) throw new Error(res.error);
      await client.saveState(state);
      return res.note || `Stav dne ${DAY_CZ[k]} byl nastaven na ${args.rest ? 'volno' : 'trénink'}.`;
    }
  );

  def(
    'copy_workout_day',
    'Zkopíruje trénink z jednoho dne do druhého (např. zopakovat pondělní trénink ve středu).',
    {
      required: ['fromDay', 'toDay'],
      properties: {
        fromDay: { type: 'string', description: 'Zdrojový den (mon, tue...).' },
        toDay: { type: 'string', description: 'Cílový den, který se přepíše (mon, tue...).' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const f = normDayKey(args.fromDay);
      const t = normDayKey(args.toDay);
      const res = applyTool('copy_workout_day', { from_day: f, to_day: t }, state);
      if (res && res.error) throw new Error(res.error);
      await client.saveState(state);
      return `Trénink z ${DAY_CZ[f]} byl úspěšně zkopírován do ${DAY_CZ[t]}.`;
    }
  );

  def(
    'swap_workout_days',
    'Prohodí tréninky mezi dvěma dny (např. přehodit čtvrteční nohy na pátek a naopak).',
    {
      required: ['dayA', 'dayB'],
      properties: {
        dayA: { type: 'string', description: 'První den (mon, tue...).' },
        dayB: { type: 'string', description: 'Druhý den (mon, tue...).' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const a = normDayKey(args.dayA);
      const b = normDayKey(args.dayB);
      const res = applyTool('swap_workout_days', { day_a: a, day_b: b }, state);
      if (res && res.error) throw new Error(res.error);
      await client.saveState(state);
      return `Tréninky mezi ${DAY_CZ[a]} a ${DAY_CZ[b]} byly úspěšně prohozeny.`;
    }
  );

  def(
    'progress_exercise',
    'Aplikuje progresivní přetížení (progressive overload) na cvik – navýší váhu nebo počet opakování.',
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
      return res.note || 'Deload týden byl úspěšně aplikován na tréninkový split.';
    }
  );

  def(
    'extend_or_shorten_workout',
    'Rychle přizpůsobí trénink času uživatele: buď ho zkrátí (vynechá doplňky a nechá hlavní cviky), nebo prodlouží o pumpovací doplňky.',
    {
      required: ['day', 'action'],
      properties: {
        day: { type: 'string', description: 'Klíč dne (mon, tue...).' },
        action: { type: 'string', enum: ['shorten', 'extend'], description: 'Zda trénink zkrátit nebo prodloužit.' },
        targetExerciseCount: { type: 'number', description: 'Cílový počet cviků po zkrácení/prodloužení.' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const k = normDayKey(args.day);
      const toolName = args.action === 'shorten' ? 'shorten_workout' : 'extend_workout';
      const res = applyWorkoutOpsTool(toolName, {
        day: k,
        target_count: args.targetExerciseCount
      }, state);

      if (!res.ok) throw new Error(res.error);
      await client.saveState(state);
      return res.note || `Trénink v ${DAY_CZ[k]} byl upraven (${args.action}).`;
    }
  );

  def(
    'set_exercise_tempo_and_notes',
    'Přidá k cviku tempo provedení (např. 3-0-1-0) nebo detailní trenérskou instrukci.',
    {
      required: ['day', 'exerciseName'],
      properties: {
        day: { type: 'string', description: 'Klíč dne (mon, tue...).' },
        exerciseName: { type: 'string', description: 'Název cviku.' },
        tempo: { type: 'string', description: 'Tempo např. 3-1-1-0 (excentrická fáze, pauza dole, koncentrická, pauza nahoře).' },
        note: { type: 'string', description: 'Trenérská instrukce k technice.' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const k = normDayKey(args.day);
      const res = applyWorkoutOpsTool('set_exercise_tempo', {
        day: k,
        name: args.exerciseName,
        tempo: args.tempo,
        note: args.note
      }, state);

      if (!res.ok) throw new Error(res.error);
      await client.saveState(state);
      return res.note || `Instrukce a tempo pro "${args.exerciseName}" byly uloženy.`;
    }
  );

  def(
    'get_exercise_history',
    'Získá kompletní historii odcvičených sérií a vah pro daný cvik, včetně osobního rekordu (PR) a posledních výkonů.',
    {
      required: ['exerciseName'],
      properties: {
        exerciseName: { type: 'string', description: 'Název cviku (např. Bench press, Dřep, Bicepsový zdvih).' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const exName = args.exerciseName || args.name;
      const res = applyStatsTool('get_exercise_history', { exerciseName: exName }, state);
      if (res && res.error) throw new Error(res.error);
      return JSON.stringify(res, null, 2);
    }
  );

  def(
    'list_all_known_exercises',
    'Vrátí katalog všech cviků, které uživatel kdy odcvičil nebo má v plánu, včetně osobních rekordů a počtu odjetých sérií.',
    {
      properties: {
        search: { type: 'string', description: 'Volitelný textový filtr pro vyhledání cviku.' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const logs = state.exerciseLogs || {};
      const plan = state.workoutPlan || {};
      const allNames = new Map();

      Object.values(plan.days || {}).forEach((d) => {
        (d.exercises || []).forEach((e) => {
          if (e && e.name) allNames.set(e.name.toLowerCase().trim(), e.name);
        });
      });

      Object.keys(logs).forEach((k) => {
        const item = logs[k];
        const name = (item && item.name) || k;
        allNames.set(name.toLowerCase().trim(), name);
      });

      let list = Array.from(allNames.values());
      if (args.search) {
        const q = args.search.toLowerCase().trim();
        list = list.filter((n) => n.toLowerCase().includes(q));
      }

      const results = list.map((name) => {
        const normKey = name.toLowerCase().replace(/[^a-z0-9]/g, '');
        const entry = logs[normKey] || logs[name];
        let maxWeight = 0;
        let lastDate = null;
        let totalSessions = 0;

        if (entry && Array.isArray(entry.sessions)) {
          totalSessions = entry.sessions.length;
          entry.sessions.forEach((s) => {
            if (s && s.date) lastDate = s.date;
            (s.sets || []).forEach((st) => {
              const w = Number(st.weight || 0);
              if (w > maxWeight) maxWeight = w;
            });
          });
        }

        return {
          name,
          prMaxWeightKg: maxWeight || null,
          lastSessionDate: lastDate,
          totalLoggedSessions: totalSessions
        };
      });

      return JSON.stringify({ count: results.length, exercises: results }, null, 2);
    }
  );

  def(
    'log_set',
    'Zapíše odcvičenou sérii do historie cviku (váha v kg, počet opakování, RPE).',
    {
      required: ['exerciseName', 'weightKg', 'reps'],
      properties: {
        exerciseName: { type: 'string', description: 'Název cviku.' },
        weightKg: { type: 'number', description: 'Zvednutá váha v kg.' },
        reps: { type: 'number', description: 'Počet provedených opakování.' },
        rpe: { type: 'number', description: 'Hodnocení RPE (1-10).' },
        date: { type: 'string', description: 'Datum ve formátu YYYY-MM-DD (výchozí dnešek).' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const d = args.date || todayStr();
      const res = applyTool('log_set', {
        exercise: args.exerciseName,
        date: d,
        sets: [{ weight: args.weightKg, reps: args.reps, rpe: args.rpe }]
      }, state);

      if (res && res.error) throw new Error(res.error);
      await client.saveState(state);
      return `Série zapsána: ${args.exerciseName} — ${args.weightKg} kg × ${args.reps} op. (${d}).`;
    }
  );

  def(
    'log_workout_session',
    'Zapíše celý dokončený trénink do historie (název tréninku, datum, délka v minutách, odcvičené cviky se sériemi).',
    {
      required: ['name', 'exercises'],
      properties: {
        name: { type: 'string', description: 'Název tréninku (např. Push A, Nohy, Zádový workout).' },
        date: { type: 'string', description: 'Datum ve formátu YYYY-MM-DD (výchozí dnešek).' },
        durationMinutes: { type: 'number', description: 'Délka tréninku v minutách.' },
        exercises: {
          type: 'array',
          description: 'Pole cviků [{ name: "Bench press", sets: [{ weight: 80, reps: 8 }, { weight: 85, reps: 6 }] }].'
        },
        notes: { type: 'string', description: 'Poznámka trenéra nebo pocity z tréninku.' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const d = args.date || todayStr();
      const sessionId = 'ses_' + Date.now().toString(36);

      const sessionEntry = {
        id: sessionId,
        date: d,
        name: args.name,
        durationMs: (args.durationMinutes || 60) * 60 * 1000,
        exercises: args.exercises || [],
        notes: args.notes || '',
        completedAt: Date.now()
      };

      if (!Array.isArray(state.sessionHistory)) state.sessionHistory = [];
      state.sessionHistory.unshift(sessionEntry);
      if (state.sessionHistory.length > 100) state.sessionHistory = state.sessionHistory.slice(0, 100);

      (args.exercises || []).forEach((ex) => {
        if (ex && ex.name && Array.isArray(ex.sets) && ex.sets.length) {
          applyTool('log_set', {
            exercise: ex.name,
            date: d,
            sets: ex.sets
          }, state);
        }
      });

      if (!state.workoutLogs) state.workoutLogs = {};
      state.workoutLogs[d] = {
        completed: true,
        workoutName: args.name,
        completedAt: Date.now(),
        notes: args.notes || ''
      };

      await client.saveState(state);
      return `Trénink "${args.name}" (${d}) byl úspěšně uložen do historie.`;
    }
  );

  def(
    'get_session_history',
    'Získá seznam nedávno odjetých celých tréninků z historie.',
    {
      properties: {
        limit: { type: 'number', description: 'Počet tréninků k zobrazení (výchozí 10).' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const hist = state.sessionHistory || [];
      const lim = args.limit || 10;
      return JSON.stringify(hist.slice(0, lim), null, 2);
    }
  );

  return tools;
}

module.exports = { registerWorkoutTools };