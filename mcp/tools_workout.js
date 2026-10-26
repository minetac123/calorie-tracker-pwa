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
        workoutName: dayData.title || dayData.name || '',
        focus: dayData.focus || '',
        exercisesCount: (dayData.exercises || []).length,
        exercises: dayData.exercises || []
      }, null, 2);
    }
  );

  def(
    'set_workout_plan',
    'Kompletně nastaví nebo přepíše týdenní tréninkový plán pro všech 7 dní (pondělí až neděle).',
    {
      required: ['days'],
      properties: {
        split: {
          type: 'string',
          description: 'Název splitu (např. "Push/Pull/Legs + Upper").'
        },
        days: {
          type: 'array',
          description: 'Pole objektů pro dny (day: mon..sun, title, focus, rest, exercises).',
          items: { type: 'object' }
        }
      }
    },
    async (args) => {
      const state = await client.getState();
      let daysArr = args.days;
      if (!Array.isArray(daysArr) && args.plan?.days) {
        if (Array.isArray(args.plan.days)) {
          daysArr = args.plan.days;
        } else if (typeof args.plan.days === 'object') {
          daysArr = Object.entries(args.plan.days).map(([day, val]) => ({
            day,
            title: val.title || val.name || 'Trénink',
            focus: val.focus || '',
            rest: !!val.rest,
            exercises: val.exercises || []
          }));
        }
      }
      const res = applyTool('set_workout_plan', {
        split: args.split || args.plan?.split || 'Vlastní split',
        days: daysArr || []
      }, state);
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
        title: { type: 'string', description: 'Nový název dne (např. "Push - Hrudník & Ramena").' },
        name: { type: 'string', description: 'Alternativní pole pro název dne.' },
        focus: { type: 'string', description: 'Zaměření tréninku (např. "hrudník, ramena, triceps").' },
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
      const current = state.workoutPlan?.days?.[k] || {};
      const res = applyTool('update_workout_day', {
        day: k,
        title: args.title || args.name || current.title || current.name || DAY_CZ[k],
        focus: args.focus !== undefined ? args.focus : (current.focus || ''),
        rest: args.rest !== undefined ? !!args.rest : !!current.rest,
        exercises: Array.isArray(args.exercises) ? args.exercises : (current.exercises || [])
      }, state);
      if (res && res.error) throw new Error(res.error);
      await client.saveState(state);
      return `Den ${DAY_CZ[k]} byl úspěšně aktualizován: "${res.title}", počet cviků: ${(res.exercises || []).length}, rest day: ${res.rest ? 'ano' : 'ne'}.`;
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
        position: { type: 'string', description: 'Pozice ("start", "end" nebo index od 0).' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const noteParts = [];
      if (args.weight) noteParts.push(`cíl ${args.weight}`);
      if (args.note) noteParts.push(args.note);
      const res = applyWorkoutOpsTool('add_exercise_to_plan_day', {
        day: normDayKey(args.day) || args.day,
        name: args.name,
        sets: args.sets || 3,
        reps: String(args.reps || '8-12'),
        restSec: args.restSec || 90,
        note: noteParts.join(' · '),
        position: args.position !== undefined ? String(args.position) : undefined
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
      const res = applyWorkoutOpsTool('remove_exercise_from_plan_day', {
        day: normDayKey(args.day) || args.day,
        exerciseRef: args.exerciseRef
      }, state);

      if (!res.ok) throw new Error(res.error);
      await client.saveState(state);
      return res.note || `Cvik "${args.exerciseRef}" byl odebrán ze dne ${args.day}.`;
    }
  );

  def(
    'substitute_exercise',
    'Nahradí existující cvik v tréninku alternativním cvikem se zachováním sérií a opakování.',
    {
      required: ['day', 'exerciseRef', 'newExerciseName'],
      properties: {
        day: { type: 'string', description: 'Den v týdnu.' },
        exerciseRef: { type: 'string', description: 'Původní cvik k nahrazení.' },
        newExerciseName: { type: 'string', description: 'Nový náhradní cvik.' },
        reason: { type: 'string', description: 'Důvod výměny / poznámka (např. obsazený stroj, bolest ramene).' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const res = applyWorkoutOpsTool('substitute_exercise', {
        day: normDayKey(args.day) || args.day,
        exerciseRef: args.exerciseRef,
        newName: args.newExerciseName || args.newName,
        note: args.reason || args.note
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
          description: 'Seřazené pole názvů nebo ID cviků přesně v pořadí, jak mají jít po sobě.'
        }
      }
    },
    async (args) => {
      const state = await client.getState();
      const res = applyWorkoutOpsTool('reorder_plan_exercises', {
        day: normDayKey(args.day) || args.day,
        order: args.exerciseOrder || args.order
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
      required: ['day'],
      properties: {
        day: { type: 'string', description: 'Den v týdnu.' },
        rest: { type: 'boolean', description: 'true pro rest day (výchozí true), false pro trénink.' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const k = normDayKey(args.day);
      if (args.rest === false) {
        if (!state.workoutPlan?.days?.[k]) throw new Error(`Den ${args.day} nenalezen.`);
        state.workoutPlan.days[k].rest = false;
        if (!state.workoutPlan.days[k].title || state.workoutPlan.days[k].title === 'Volno') {
          state.workoutPlan.days[k].title = 'Trénink';
        }
        await client.saveState(state);
        return `Den ${DAY_CZ[k] || args.day} je nyní nastaven jako tréninkový den.`;
      }
      const res = applyWorkoutOpsTool('set_rest_day', {
        day: k || args.day
      }, state);

      if (!res.ok) throw new Error(res.error);
      await client.saveState(state);
      return res.note || `Den ${args.day} byl nastaven jako volno.`;
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
      const res = applyTool('copy_workout_day', {
        from: normDayKey(args.fromDay || args.from),
        to: normDayKey(args.toDay || args.to)
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
        dayA: { type: 'string', description: 'První den (např. mon).' },
        dayB: { type: 'string', description: 'Druhý den (např. sat).' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const res = applyTool('swap_workout_days', {
        dayA: normDayKey(args.dayA),
        dayB: normDayKey(args.dayB)
      }, state);

      if (!res.ok) throw new Error(res.error);
      await client.saveState(state);
      return `Dny ${res.swapped} byly prohozeny.`;
    }
  );

  def(
    'progress_exercise',
    'Zvýší cílovou váhu u cviku pro progresivní přetížení (např. +2.5 kg).',
    {
      required: ['exerciseName'],
      properties: {
        exerciseName: { type: 'string', description: 'Název cviku k progresu.' },
        addWeightKg: { type: 'number', description: 'Kolik kg přidat (výchozí 2.5).' },
        day: { type: 'string', description: 'Den v plánu (mon, tue...; výchozí mon).' }
      }
    },
    async (args) => {
      const state = await client.getState();
      let dayKey = args.day ? normDayKey(args.day) : null;
      if (!dayKey && state.workoutPlan?.days) {
        const foundKey = Object.keys(state.workoutPlan.days).find((k) =>
          (state.workoutPlan.days[k].exercises || []).some((e) =>
            e.name.toLowerCase().includes(String(args.exerciseName).toLowerCase())
          )
        );
        dayKey = foundKey || 'mon';
      }
      const res = applyWorkoutOpsTool('progress_exercise', {
        day: dayKey || 'mon',
        exerciseRef: args.exerciseName || args.exerciseRef,
        kgStep: args.addWeightKg || args.kgStep || 2.5
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
    'Nastaví odlehčovací deload týden: sníží počet sérií napříč tréninkovým týdnem pro regeneraci.',
    {
      properties: {
        volumeReductionPct: { type: 'number', description: 'O kolik % snížit počet sérií (5-50%, výchozí 20%).' },
        intensityReductionPct: { type: 'number', description: 'Volitelné % snížení intenzity.' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const pct = args.volumeReductionPct || args.percent || args.intensityReductionPct || 20;
      const res = applyWorkoutOpsTool('deload_week', {
        percent: pct
      }, state);

      if (!res.ok) throw new Error(res.error);
      await client.saveState(state);
      return res.note || 'Deload týden byl úspěšně aplikován.';
    }
  );

  def(
    'extend_or_shorten_workout',
    'Přizpůsobí délku tréninku (přidá doplňkové cviky nebo naopak ořeže méně podstatné cviky, pokud uživatel spěchá).',
    {
      required: ['day', 'mode'],
      properties: {
        day: { type: 'string', description: 'Den v týdnu.' },
        mode: {
          type: 'string',
          enum: ['shorten', 'extend'],
          description: 'Zda trénink zkrátit (shorten) nebo prodloužit (extend).'
        },
        count: { type: 'number', description: 'Pro extend: kolik cviků přidat (1-5). Pro shorten: kolik cviků má v tréninku zbýt.' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const k = normDayKey(args.day) || args.day;
      let res;
      if (args.mode === 'shorten') {
        res = applyWorkoutOpsTool('shorten_workout', {
          day: k,
          targetCount: args.count || 3
        }, state);
      } else {
        res = applyWorkoutOpsTool('extend_workout', {
          day: k,
          count: args.count || 2
        }, state);
      }

      if (!res.ok) throw new Error(res.error);
      await client.saveState(state);
      return res.note || 'Trénink byl upraven dle požadavku.';
    }
  );

  def(
    'set_exercise_tempo_and_notes',
    'Nastaví tréninkové tempo (např. 3-1-1-0 pro hypertrofii) a poznámky k technice pro konkrétní cvik.',
    {
      required: ['day', 'exerciseRef'],
      properties: {
        day: { type: 'string', description: 'Den v týdnu.' },
        exerciseRef: { type: 'string', description: 'Název nebo ID cviku.' },
        tempo: { type: 'string', description: 'Tempo provádění (čtyři čísla oddělená pomlčkou, např. "3-1-1-0").' },
        note: { type: 'string', description: 'Trenérská instrukce k technice či pocitu.' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const k = normDayKey(args.day) || args.day;
      let msg = '';
      if (args.tempo) {
        const res = applyWorkoutOpsTool('set_exercise_tempo', {
          day: k,
          exerciseRef: args.exerciseRef,
          tempo: args.tempo
        }, state);
        if (!res.ok) throw new Error(res.error);
        msg = res.note;
      }
      if (args.note && state.workoutPlan?.days?.[k]) {
        const ex = (state.workoutPlan.days[k].exercises || []).find((e) =>
          e.id === args.exerciseRef || e.name.toLowerCase().includes(String(args.exerciseRef).toLowerCase())
        );
        if (ex) {
          ex.note = ex.note ? `${ex.note} · ${args.note}` : args.note;
        }
      }
      await client.saveState(state);
      return msg || 'Poznámky a tempo cviku byly uloženy.';
    }
  );

  def(
    'get_exercise_history',
    'Získá kompletní historii sérií, vah a opakování pro konkrétní cvik včetně osobního rekordu (PR).',
    {
      required: ['exerciseName'],
      properties: {
        exerciseName: { type: 'string', description: 'Název cviku.' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const res = applyStatsTool('get_exercise_history', {
        exerciseName: args.exerciseName
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
      const list = Object.entries(exLogs).map(([key, log]) => {
        const sessions = Array.isArray(log.sessions) ? log.sessions : [];
        let prWeight = 0;
        let prReps = 0;
        sessions.forEach((s) => {
          (s.sets || []).forEach((st) => {
            if (Number(st.w) > prWeight) {
              prWeight = Number(st.w);
              prReps = Number(st.r);
            }
          });
        });
        const lastSes = sessions[sessions.length - 1];
        return {
          key,
          name: log.name || key,
          prWeight: prWeight || null,
          prReps: prReps || null,
          lastDate: lastSes ? lastSes.date : null,
          totalSessionsLogged: sessions.length
        };
      });
      return JSON.stringify(list, null, 2);
    }
  );

  def(
    'log_set',
    'Zapíše odcvičenou sérii nebo více sérií (váha v kg, počet opakování) do historie cviku.',
    {
      required: ['exerciseName', 'weightKg', 'reps'],
      properties: {
        exerciseName: { type: 'string', description: 'Název odcvičeného cviku.' },
        weightKg: { type: 'number', description: 'Váha na čince / stroji v kg.' },
        reps: { type: 'number', description: 'Počet provedených opakování.' },
        setsCount: { type: 'number', description: 'Kolik takových sérií zapsat (výchozí 1).' },
        rpe: { type: 'number', description: 'Míra vnímaného úsilí RPE 1-10 (např. 8.5).' },
        date: { type: 'string', description: 'Datum ve formátu YYYY-MM-DD (výchozí dnešek).' }
      }
    },
    async (args) => {
      const state = await client.getState();
      const d = args.date || todayStr();
      const count = Math.max(1, Math.min(10, Number(args.setsCount || 1)));
      const newSets = Array.from({ length: count }, () => ({
        weight: Number(args.weightKg),
        reps: Number(args.reps)
      }));

      const res = applyTool('log_set', {
        exercise: args.exerciseName,
        date: d,
        sets: newSets
      }, state);

      if (!res.ok) throw new Error(res.error);
      await client.saveState(state);
      return `Série zapsána: ${res.exercise} — ${res.sets.join(', ')} (datum ${res.date}, objem ${res.volume} kg).`;
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
