// ---------------------------------------------------------------------------
// Nástroje kouče pro živý trénink
// ---------------------------------------------------------------------------
// The live session lives in the browser and the user keeps mutating it while a
// coach request is in flight — logging a set takes a second, a coach round trip
// takes several. So the server never returns a whole session snapshot: it works
// on a copy purely so the model can be told what happened, and returns a list
// of small declarative ACTIONS that the client replays against whatever the
// session looks like by the time the answer lands. A set logged mid-request
// survives; a returned snapshot would have silently eaten it.
//
// Exercises are addressed by id, never by position, for the same reason.

const { normalizeExerciseName } = require('./plans');

const MAX_EXERCISES = 20;

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

// The model is told the ids, but it still sometimes answers with the name it
// just read. Accept both rather than failing on a technicality.
function findExercise(s, ref) {
  const want = String(ref || '').trim();
  if (!want) return -1;
  let i = s.exercises.findIndex((e) => e.id === want);
  if (i !== -1) return i;
  const norm = normalizeExerciseName(want);
  if (!norm) return -1;
  i = s.exercises.findIndex((e) => normalizeExerciseName(e.name) === norm);
  if (i !== -1) return i;
  return s.exercises.findIndex((e) => normalizeExerciseName(e.name).includes(norm));
}

function exerciseList(s) {
  return s.exercises.map((e, i) => ({
    id: e.id,
    poradi: i + 1,
    nazev: e.name,
    cil: `${e.targetSets} × ${e.targetReps}`,
    zapsano: (e.sets || []).length
  }));
}

const SESSION_TOOLS = [
  {
    name: 'edit_exercise',
    description: 'Upraví cvik v probíhajícím tréninku — název, počet sérií, opakování, pauzu nebo poznámku. Zapsané série zůstanou. Použij, když uživatel chce vyměnit cvik za jiný, ubrat sérii, změnit rozsah opakování nebo si prodloužit pauzu.',
    parameters: {
      type: 'OBJECT',
      properties: {
        exerciseId: { type: 'STRING', description: 'ID cviku ze seznamu CVIKY V TRÉNINKU' },
        name: { type: 'STRING', description: 'Nový název cviku (jen když ho měníš)' },
        sets: { type: 'INTEGER', description: 'Nový počet cílových sérií 1-12' },
        reps: { type: 'STRING', description: 'Nový rozsah opakování, např. "8-12"' },
        restSec: { type: 'INTEGER', description: 'Nová délka pauzy mezi sériemi v sekundách 15-600' },
        note: { type: 'STRING', description: 'Krátká poznámka k technice' }
      },
      required: ['exerciseId']
    }
  },
  {
    name: 'add_exercise',
    description: 'Přidá do probíhajícího tréninku nový cvik. Ve výchozím stavu hned za ten, na kterém uživatel právě je.',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING', description: 'Český název cviku' },
        sets: { type: 'INTEGER', description: 'Počet sérií 1-12' },
        reps: { type: 'STRING', description: 'Rozsah opakování, např. "10-12"' },
        restSec: { type: 'INTEGER', description: 'Pauza mezi sériemi v sekundách' },
        note: { type: 'STRING', description: 'Krátká technická poznámka' },
        position: { type: 'STRING', description: '"next" = hned za aktuální cvik (výchozí), "end" = na konec tréninku' }
      },
      required: ['name', 'sets', 'reps']
    }
  },
  {
    name: 'remove_exercise',
    description: 'Vyhodí cvik z probíhajícího tréninku. Použij, když ho uživatel nechce dělat nebo mu došel čas.',
    parameters: {
      type: 'OBJECT',
      properties: {
        exerciseId: { type: 'STRING', description: 'ID cviku ze seznamu CVIKY V TRÉNINKU' }
      },
      required: ['exerciseId']
    }
  },
  {
    name: 'move_exercise',
    description: 'Přehodí pořadí cviků v probíhajícím tréninku.',
    parameters: {
      type: 'OBJECT',
      properties: {
        exerciseId: { type: 'STRING', description: 'ID cviku, kterým hýbeš' },
        direction: { type: 'STRING', description: '"up" o jedno dopředu, "down" o jedno dozadu' }
      },
      required: ['exerciseId', 'direction']
    }
  },
  {
    name: 'goto_exercise',
    description: 'Přepne uživateli obrazovku na jiný cvik z tréninku. Použij, když říká, že jde dělat něco jiného.',
    parameters: {
      type: 'OBJECT',
      properties: {
        exerciseId: { type: 'STRING', description: 'ID cviku, na který se má přepnout' }
      },
      required: ['exerciseId']
    }
  },
  {
    name: 'log_session_set',
    description: 'Zapíše uživateli sérii do probíhajícího tréninku. Použij, když ti nadiktuje, co udělal, místo aby to naťukal.',
    parameters: {
      type: 'OBJECT',
      properties: {
        exerciseId: { type: 'STRING', description: 'ID cviku (když neuvedeš, bere se aktuální)' },
        weight: { type: 'NUMBER', description: 'Váha v kg' },
        reps: { type: 'INTEGER', description: 'Počet opakování' }
      },
      required: ['weight', 'reps']
    }
  },
  {
    name: 'edit_logged_set',
    description: 'Opraví už zapsanou sérii — váhu, opakování, nebo obojí. Použij, když se uživatel přepsal.',
    parameters: {
      type: 'OBJECT',
      properties: {
        exerciseId: { type: 'STRING', description: 'ID cviku' },
        setNumber: { type: 'INTEGER', description: 'Pořadí série, počítáno od 1' },
        weight: { type: 'NUMBER', description: 'Opravená váha v kg' },
        reps: { type: 'INTEGER', description: 'Opravený počet opakování' }
      },
      required: ['exerciseId', 'setNumber']
    }
  },
  {
    name: 'delete_logged_set',
    description: 'Smaže zapsanou sérii. Použij, když ji uživatel zapsal omylem.',
    parameters: {
      type: 'OBJECT',
      properties: {
        exerciseId: { type: 'STRING', description: 'ID cviku' },
        setNumber: { type: 'INTEGER', description: 'Pořadí série, počítáno od 1' }
      },
      required: ['exerciseId', 'setNumber']
    }
  },
  {
    name: 'set_rest_timer',
    description: 'Nastaví, zkrátí nebo zruší běžící pauzu mezi sériemi. seconds=0 pauzu rovnou ukončí.',
    parameters: {
      type: 'OBJECT',
      properties: {
        seconds: { type: 'INTEGER', description: 'Kolik sekund pauzy zbývá od teď. 0 = pauza končí hned.' }
      },
      required: ['seconds']
    }
  }
];

const SESSION_TOOL_NAMES = new Set(SESSION_TOOLS.map((t) => t.name));

// Applies one tool to the working copy and records the action the client will
// replay. Returns the usual { ok, ... } result the tool loop feeds back.
function applySessionTool(name, args, s, actions) {
  const a = args || {};

  if (name === 'set_rest_timer') {
    const sec = clamp(Math.round(num(a.seconds, 0)), 0, 900);
    actions.push({ op: 'set_rest', seconds: sec });
    return { ok: true, note: sec === 0 ? 'Pauza ukončena.' : `Pauza nastavena na ${sec}s.` };
  }

  if (name === 'add_exercise') {
    if (s.exercises.length >= MAX_EXERCISES) {
      return { ok: false, error: `V tréninku už je ${MAX_EXERCISES} cviků, víc nejde.` };
    }
    const exName = String(a.name || '').trim().slice(0, 80);
    if (!exName) return { ok: false, error: 'Cvik potřebuje název.' };
    const ex = {
      id: 'ex_c' + Math.random().toString(36).slice(2, 9),
      name: exName,
      targetSets: clamp(Math.round(num(a.sets, 3)), 1, 12),
      targetReps: String(a.reps || '8-12').slice(0, 20),
      restSec: clamp(Math.round(num(a.restSec, 90)), 15, 600),
      note: a.note ? String(a.note).slice(0, 140) : '',
      sets: []
    };
    const atEnd = String(a.position || 'next') === 'end';
    const at = atEnd ? s.exercises.length : Math.min(s.idx + 1, s.exercises.length);
    s.exercises.splice(at, 0, ex);
    actions.push({
      op: 'add_exercise', id: ex.id, name: ex.name, targetSets: ex.targetSets,
      targetReps: ex.targetReps, restSec: ex.restSec, note: ex.note, position: atEnd ? 'end' : 'next'
    });
    return { ok: true, id: ex.id, note: `Cvik "${ex.name}" přidán ${atEnd ? 'na konec' : 'hned za aktuální'}.` };
  }

  // Everything below addresses an existing exercise.
  const ref = a.exerciseId != null ? a.exerciseId : null;
  let i = ref == null ? s.idx : findExercise(s, ref);
  if (name === 'log_session_set' && ref == null) i = s.idx;
  if (i < 0 || i >= s.exercises.length) {
    return { ok: false, error: 'Takový cvik v tréninku není.', cviky: exerciseList(s) };
  }
  const ex = s.exercises[i];
  if (!Array.isArray(ex.sets)) ex.sets = [];

  if (name === 'edit_exercise') {
    const changed = [];
    if (a.name != null && String(a.name).trim()) {
      ex.name = String(a.name).trim().slice(0, 80);
      changed.push(`název na "${ex.name}"`);
    }
    if (a.sets != null) { ex.targetSets = clamp(Math.round(num(a.sets, ex.targetSets)), 1, 12); changed.push(`${ex.targetSets} sérií`); }
    if (a.reps != null && String(a.reps).trim()) { ex.targetReps = String(a.reps).trim().slice(0, 20); changed.push(`${ex.targetReps} opakování`); }
    if (a.restSec != null) { ex.restSec = clamp(Math.round(num(a.restSec, ex.restSec)), 15, 600); changed.push(`pauzu ${ex.restSec}s`); }
    if (a.note != null) { ex.note = String(a.note).slice(0, 140); changed.push('poznámku'); }
    if (!changed.length) return { ok: false, error: 'Neuvedl jsi, co se má na cviku změnit.' };
    actions.push({
      op: 'edit_exercise', id: ex.id, name: ex.name, targetSets: ex.targetSets,
      targetReps: ex.targetReps, restSec: ex.restSec, note: ex.note
    });
    return { ok: true, note: `Upraveno: ${changed.join(', ')}. Zapsané série zůstaly (${ex.sets.length}).` };
  }

  if (name === 'remove_exercise') {
    if (s.exercises.length <= 1) {
      return { ok: false, error: 'Tohle je poslední cvik tréninku, smazat nejde — nabídni uživateli, ať trénink ukončí.' };
    }
    s.exercises.splice(i, 1);
    if (s.idx >= s.exercises.length) s.idx = s.exercises.length - 1;
    else if (s.idx > i) s.idx--;
    actions.push({ op: 'remove_exercise', id: ex.id });
    return {
      ok: true,
      note: `Cvik "${ex.name}" vyhozen${ex.sets.length ? ` i se ${ex.sets.length} zapsanými sériemi` : ''}.`,
      zbyva: s.exercises.map((e) => e.name)
    };
  }

  if (name === 'move_exercise') {
    const delta = String(a.direction || '').toLowerCase() === 'up' ? -1 : 1;
    const j = i + delta;
    if (j < 0 || j >= s.exercises.length) {
      return { ok: false, error: delta < 0 ? 'Cvik už je první.' : 'Cvik už je poslední.' };
    }
    const [moved] = s.exercises.splice(i, 1);
    s.exercises.splice(j, 0, moved);
    if (s.idx === i) s.idx = j;
    else if (s.idx === j) s.idx = i;
    actions.push({ op: 'move_exercise', id: ex.id, delta });
    return { ok: true, note: `Nové pořadí: ${s.exercises.map((e) => e.name).join(', ')}.` };
  }

  if (name === 'goto_exercise') {
    s.idx = i;
    actions.push({ op: 'goto_exercise', id: ex.id });
    return { ok: true, note: `Uživatel je teď na cviku "${ex.name}".` };
  }

  if (name === 'log_session_set') {
    const w = Math.round(num(a.weight, 0) * 10) / 10;
    const r = Math.round(num(a.reps, 0));
    if (!(w > 0) || !(r > 0)) return { ok: false, error: 'Série potřebuje kladnou váhu i počet opakování.' };
    if (ex.sets.length >= 20) return { ok: false, error: 'U tohohle cviku je už 20 sérií.' };
    ex.sets.push({ w, r });
    actions.push({ op: 'log_set', id: ex.id, w, r });
    return { ok: true, note: `Zapsáno k "${ex.name}": ${w} kg × ${r} (${ex.sets.length}. série).` };
  }

  // edit_logged_set / delete_logged_set
  const idx = Math.round(num(a.setNumber, 0)) - 1;
  if (idx < 0 || idx >= ex.sets.length) {
    return {
      ok: false,
      error: `U cviku "${ex.name}" je ${ex.sets.length} zapsaných sérií, série číslo ${a.setNumber} neexistuje.`,
      serie: ex.sets.map((x, k) => `${k + 1}. ${x.w}kg×${x.r}`)
    };
  }

  if (name === 'delete_logged_set') {
    const gone = ex.sets.splice(idx, 1)[0];
    actions.push({ op: 'delete_set', id: ex.id, index: idx });
    return { ok: true, note: `Smazána ${idx + 1}. série (${gone.w} kg × ${gone.r}). Zbývá ${ex.sets.length}.` };
  }

  if (name === 'edit_logged_set') {
    if (a.weight == null && a.reps == null) {
      return { ok: false, error: 'Neuvedl jsi, co se má na sérii opravit.' };
    }
    if (a.weight != null) {
      const w = Math.round(num(a.weight, ex.sets[idx].w) * 10) / 10;
      if (!(w > 0)) return { ok: false, error: 'Váha musí být kladná.' };
      ex.sets[idx].w = w;
    }
    if (a.reps != null) {
      const r = Math.round(num(a.reps, ex.sets[idx].r));
      if (!(r > 0)) return { ok: false, error: 'Opakování musí být kladná.' };
      ex.sets[idx].r = r;
    }
    actions.push({ op: 'edit_set', id: ex.id, index: idx, w: ex.sets[idx].w, r: ex.sets[idx].r });
    return { ok: true, note: `${idx + 1}. série je teď ${ex.sets[idx].w} kg × ${ex.sets[idx].r}.` };
  }

  return { ok: false, error: 'Neznámý nástroj: ' + name };
}

// Shapes whatever the client sent into something the tools can safely chew on.
function normSessionState(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const exercises = (Array.isArray(src.exercises) ? src.exercises : [])
    .slice(0, MAX_EXERCISES)
    .map((e, i) => ({
      id: String((e && e.id) || 'ex_' + i),
      name: String((e && e.name) || 'Cvik').slice(0, 80),
      targetSets: clamp(Math.round(num(e && e.targetSets, 3)), 1, 12),
      targetReps: String((e && e.targetReps) || '8-12').slice(0, 20),
      restSec: clamp(Math.round(num(e && e.restSec, 90)), 15, 600),
      note: (e && e.note) ? String(e.note).slice(0, 140) : '',
      sets: (Array.isArray(e && e.sets) ? e.sets : []).slice(0, 20)
        .map((x) => ({ w: num(x && x.w, 0), r: Math.round(num(x && x.r, 0)) }))
    }));
  return {
    exercises,
    idx: clamp(Math.round(num(src.idx, 0)), 0, Math.max(0, exercises.length - 1))
  };
}

// The id list the model needs in order to address anything at all.
function fmtSessionExercises(s) {
  if (!s || !s.exercises.length) return 'Trénink nemá žádné cviky.';
  return s.exercises.map((e, i) => {
    const done = e.sets.length ? e.sets.map((x, k) => `${k + 1}. ${x.w}kg×${x.r}`).join(', ') : 'zatím nic';
    const here = i === s.idx ? '  ← TADY JE TEĎ' : '';
    return `${i + 1}. [${e.id}] ${e.name} — cíl ${e.targetSets}×${e.targetReps}, pauza ${e.restSec}s${e.note ? `, pozn.: ${e.note}` : ''}\n   zapsáno: ${done}${here}`;
  }).join('\n');
}

module.exports = {
  SESSION_TOOLS, SESSION_TOOL_NAMES, applySessionTool,
  normSessionState, fmtSessionExercises
};
