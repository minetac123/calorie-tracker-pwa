// Coach body & health layer: weight, water, measurements, cardio, steps,
// sleep, mood and injuries.
//
// Everything here is a *record* of what the user's body did — never a change to
// their plan. Plan edits live in plans.js and stay behind their own tools, so a
// passing mention of a sore knee cannot silently rebuild someone's training
// week (see log_injury).
//
// Same contract as plans.js: synchronous, mutates `state`, returns an object
// the model reads back to the user, so notes carry concrete numbers in Czech.

const MEASURE_FIELDS = ['waist', 'chest', 'arm', 'thigh', 'hips', 'neck'];
const MEASURE_CZ = {
  waist: 'pas', chest: 'hrudník', arm: 'paže', thigh: 'stehno', hips: 'boky', neck: 'krk'
};

// MET values for steady-state recreational effort. Deliberately mid-range —
// the point is a believable ballpark the coach can say out loud, not lab
// accuracy, and overstating burn is how people end up eating back more than
// they spent.
const CARDIO_MET = {
  run: 9.8,
  walk: 3.5,
  bike: 7.5,
  swim: 7.0,
  row: 7.0,
  elliptical: 5.0,
  hike: 6.0,
  jumprope: 11.0,
  stairs: 8.0,
  other: 6.0
};
const CARDIO_CZ = {
  run: 'běh', walk: 'chůze', bike: 'kolo', swim: 'plavání', row: 'veslování',
  elliptical: 'eliptical', hike: 'turistika', jumprope: 'švihadlo',
  stairs: 'schody', other: 'kardio'
};
const INTENSITY_FACTOR = { low: 0.8, medium: 1.0, high: 1.25 };
const INTENSITY_CZ = { low: 'lehká', medium: 'střední', high: 'vysoká' };

// ---------------------------------------------------------------------------
// Small local helpers — intentionally not imported from plans.js so the two
// tool modules stay independently loadable.
// ---------------------------------------------------------------------------

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

function round1(n) {
  return Math.round(n * 10) / 10;
}

// Diacritics-insensitive key, so "záda" and "zada" from the model match the
// same stored injury.
function fold(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Noon UTC survives any timezone shift, so day arithmetic never slips a day.
function parseDate(s) {
  return new Date(`${s}T12:00:00Z`);
}

function daysBetween(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / 86400000);
}

// A regex alone accepts 2026-02-31; round-tripping through Date rejects it.
function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = parseDate(s);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function todayOf(state) {
  const t = state && state.today;
  return isValidDate(t) ? t : new Date().toISOString().slice(0, 10);
}

// Resolves an optional model-supplied date against state.today. Returns either
// { date } or { error } — callers just forward the error.
function resolveDate(raw, state) {
  const today = todayOf(state);
  if (raw == null || raw === '') return { date: today };
  const s = String(raw).trim();
  if (!isValidDate(s)) {
    return { error: `Neplatné datum "${s}" — použij formát YYYY-MM-DD, nebo datum vynech pro dnešek (${today}).` };
  }
  // One day of slack absorbs any client/server timezone edge; anything further
  // ahead is the model hallucinating a date, and logging a body record into the
  // future would quietly poison every trend.
  if (daysBetween(today, s) > 1) {
    return { error: `Datum ${s} je v budoucnosti (dnes je ${today}) — zapisuj jen dnešek nebo minulost.` };
  }
  return { date: s };
}

// Numeric range check with a Czech error the model can read out verbatim.
function checkNum(value, lo, hi, label, unit) {
  if (value == null || value === '') return { error: `Chybí ${label}.` };
  const n = Number(value);
  if (!Number.isFinite(n)) return { error: `${label} musí být číslo, dostal jsem "${value}".` };
  if (n < lo || n > hi) {
    return { error: `${label} ${round1(n)} ${unit} je mimo rozsah ${lo}–${hi} ${unit} — zkontroluj, co uživatel řekl.` };
  }
  return { value: n };
}

function ensureArray(state, key) {
  if (!Array.isArray(state[key])) state[key] = [];
  return state[key];
}

function ensureMap(state, key) {
  if (!state[key] || typeof state[key] !== 'object' || Array.isArray(state[key])) state[key] = {};
  return state[key];
}

// weightLogs is newest-first everywhere in the app (client renders it as-is),
// so every write re-sorts instead of trusting insertion order.
function sortNewestFirst(list) {
  list.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
  return list;
}

function normCardioType(raw) {
  const s = fold(raw);
  if (!s) return 'other';
  const table = [
    [/(\bbeh|bezec|\brun|\bjogg|\bjog\b|\bklus|sprint)/, 'run'],
    [/(chuz|chodi|walk|prochaz)/, 'walk'],
    [/(\bkol[oaey]m?\b|cykl|bike|spinning|rotoped)/, 'bike'],
    [/(plav|swim|bazen)/, 'swim'],
    [/(vesl|row|ergo)/, 'row'],
    [/(elipt|ellipt|orbitrek|cross ?train)/, 'elliptical'],
    [/(turist|hike|tura)/, 'hike'],
    [/(svihadl|jump ?rope|skip)/, 'jumprope'],
    [/(schod|stair|stepper)/, 'stairs']
  ];
  for (const [re, key] of table) if (re.test(s)) return key;
  return 'other';
}

function normIntensity(raw) {
  const s = fold(raw);
  if (/(low|lehk|volne|klid|easy)/.test(s)) return 'low';
  if (/(high|vysok|tvrd|hard|intenz|naplno)/.test(s)) return 'high';
  return 'medium';
}

// ---------------------------------------------------------------------------
// Gemini tool declarations
// ---------------------------------------------------------------------------

const DATE_PARAM = {
  type: 'STRING',
  description: 'Datum ve formátu YYYY-MM-DD. Vynech pro dnešek. Do budoucnosti se zapisovat nedá.'
};

const BODY_TOOLS = [
  {
    name: 'log_weight',
    description: 'Zapiš naměřenou tělesnou váhu. Volej, když uživatel řekne, kolik váží ("dneska ráno 82,4"). Jedno vážení na den — když už pro to datum záznam je, přepíše se (žádné duplikáty). Zároveň se aktualizuje váha v profilu, takže po tomhle NEVOLEJ save_profile kvůli váze.',
    parameters: {
      type: 'OBJECT',
      properties: {
        weight: { type: 'NUMBER', description: 'Váha v kilogramech, 20–400' },
        date: DATE_PARAM
      },
      required: ['weight']
    }
  },
  {
    name: 'delete_weight',
    description: 'Smaž vážení k jednomu konkrétnímu datu. Použij jen když uživatel výslovně řekne, že se přepsal nebo že se ten záznam má smazat ("to včerejší vážení smaž, měřil jsem po jídle"). Na opravu hodnoty stačí log_weight se stejným datem — ten záznam přepíše.',
    parameters: {
      type: 'OBJECT',
      properties: { date: DATE_PARAM },
      required: ['date']
    }
  },
  {
    name: 'log_water',
    description: 'PŘIČTI vypitou vodu ke dni. Použij na "vypil jsem půl litru" — hodnota se přidá k tomu, co už za ten den je. Když chce uživatel opravit celkový součet za den ("dneska mám celkem 2 litry, ne 3"), použij set_water.',
    parameters: {
      type: 'OBJECT',
      properties: {
        ml: { type: 'NUMBER', description: 'Kolik mililitrů přidat, 50–3000 na jeden zápis' },
        date: DATE_PARAM
      },
      required: ['ml']
    }
  },
  {
    name: 'set_water',
    description: 'NASTAV celkový příjem vody za den natvrdo — přepíše, co tam bylo. Použij na opravu překlepu nebo když uživatel hlásí celkový součet ("dneska jsem měl dohromady 2,5 litru"). Na běžné průběžné zapisování používej log_water, ten přičítá.',
    parameters: {
      type: 'OBJECT',
      properties: {
        ml: { type: 'NUMBER', description: 'Celkový denní součet v mililitrech, 0–15000' },
        date: DATE_PARAM
      },
      required: ['ml']
    }
  },
  {
    name: 'log_body_measurement',
    description: 'Zapiš tělesné obvody v centimetrech. Posílej jen míry, které uživatel opravdu řekl — ostatní míry ze stejného dne zůstanou zachované, takže můžeš volat i opakovaně během konverzace.',
    parameters: {
      type: 'OBJECT',
      properties: {
        date: DATE_PARAM,
        waist: { type: 'NUMBER', description: 'Pas v cm' },
        chest: { type: 'NUMBER', description: 'Hrudník v cm' },
        arm: { type: 'NUMBER', description: 'Paže (biceps) v cm' },
        thigh: { type: 'NUMBER', description: 'Stehno v cm' },
        hips: { type: 'NUMBER', description: 'Boky v cm' },
        neck: { type: 'NUMBER', description: 'Krk v cm' }
      }
    }
  },
  {
    name: 'get_measurements_trend',
    description: 'JEN ČTE, nic nemění: vývoj jedné tělesné míry v čase a celková změna v cm. Použij, když se uživatel ptá "jak mi jde pas" nebo než mu budeš hodnotit postup.',
    parameters: {
      type: 'OBJECT',
      properties: {
        field: { type: 'STRING', enum: MEASURE_FIELDS, description: 'Která míra' },
        days: { type: 'INTEGER', description: 'Kolik dní zpátky se dívat, výchozí 90' }
      },
      required: ['field']
    }
  },
  {
    name: 'log_cardio',
    description: 'Zapiš kardio aktivitu (běh, chůze, kolo, plavání, veslování, eliptical…). Spálené kalorie se dopočítají z MET tabulky a váhy uživatele — je to ODHAD, nikdy ho neprezentuj jako přesné měření. Na silový trénink tohle NEPOUŽÍVEJ, od toho je log_set.',
    parameters: {
      type: 'OBJECT',
      properties: {
        type: { type: 'STRING', description: 'Typ aktivity česky, např. "běh", "kolo", "plavání"' },
        minutes: { type: 'INTEGER', description: 'Délka v minutách, 1–600' },
        date: DATE_PARAM,
        distanceKm: { type: 'NUMBER', description: 'Vzdálenost v km (volitelné)' },
        intensity: { type: 'STRING', enum: ['low', 'medium', 'high'], description: 'Intenzita, výchozí medium' }
      },
      required: ['type', 'minutes']
    }
  },
  {
    name: 'log_steps',
    description: 'Zapiš počet kroků za den (přepíše dosavadní hodnotu za to datum — hlásí se celkový denní součet z hodinek, ne přírůstky).',
    parameters: {
      type: 'OBJECT',
      properties: {
        steps: { type: 'INTEGER', description: 'Počet kroků, 0–100000' },
        date: DATE_PARAM
      },
      required: ['steps']
    }
  },
  {
    name: 'log_sleep',
    description: 'Zapiš spánek za noc. Jeden záznam na den — stejné datum se přepíše. Datum = den, ke kterému se spánek počítá (obvykle ráno, kdy se probudil).',
    parameters: {
      type: 'OBJECT',
      properties: {
        hours: { type: 'NUMBER', description: 'Kolik hodin spal, 0–24' },
        date: DATE_PARAM,
        quality: { type: 'INTEGER', description: 'Kvalita spánku 1–5 (1 = mizerná, 5 = výborná), volitelné' }
      },
      required: ['hours']
    }
  },
  {
    name: 'log_mood',
    description: 'Zapiš náladu a energii na škále 1–5. Použij, když uživatel sám popíše, jak se cítí ("jsem vyšťavenej", "dneska mi to fakt jde"). Jeden záznam na den, stejné datum se přepíše.',
    parameters: {
      type: 'OBJECT',
      properties: {
        mood: { type: 'INTEGER', description: 'Nálada 1–5 (1 = mizerná, 5 = výborná)' },
        energy: { type: 'INTEGER', description: 'Energie 1–5 (1 = vyčerpaný, 5 = plný sil)' },
        date: DATE_PARAM,
        note: { type: 'STRING', description: 'Krátká poznámka vlastními slovy uživatele (volitelné)' }
      },
      required: ['mood', 'energy']
    }
  },
  {
    name: 'log_injury',
    description: 'Zaznamenej zranění nebo bolest (koleno, záda, rameno…). POUZE zapíše — tréninkový plán tenhle nástroj NEMĚNÍ. Po zavolání se uživatele zeptej, jestli má plán upravit, a teprve když souhlasí, použij update_workout_day nebo set_workout_plan.',
    parameters: {
      type: 'OBJECT',
      properties: {
        bodyPart: { type: 'STRING', description: 'Část těla česky, např. "levé koleno", "spodní záda"' },
        severity: { type: 'INTEGER', description: 'Závažnost 1–5 (1 = mírné, 5 = nemůže se hýbat)' },
        note: { type: 'STRING', description: 'Co se stalo a co bolí, vlastními slovy uživatele' },
        date: DATE_PARAM
      },
      required: ['bodyPart', 'severity']
    }
  },
  {
    name: 'resolve_injury',
    description: 'Označ zranění za vyléčené. Volej, když uživatel řekne, že už ho to nebolí ("koleno je v pohodě"). Záznam v historii zůstane, jen se přestane brát jako aktivní. Plán se tím sám nevrátí zpátky — na to se uživatele zeptej zvlášť.',
    parameters: {
      type: 'OBJECT',
      properties: {
        bodyPart: { type: 'STRING', description: 'Část těla tak, jak byla zapsaná při log_injury' }
      },
      required: ['bodyPart']
    }
  }
];

const BODY_TOOL_NAMES = new Set(BODY_TOOLS.map((t) => t.name));

// ---------------------------------------------------------------------------
// Tool execution — synchronous, mutates state
// ---------------------------------------------------------------------------

function applyBodyTool(name, args, state) {
  const a = args || {};
  if (!state || typeof state !== 'object') return { ok: false, error: 'Chybí stav uživatele.' };
  const today = todayOf(state);

  switch (name) {
    case 'log_weight': {
      const w = checkNum(a.weight, 20, 400, 'Váha', 'kg');
      if (w.error) return { ok: false, error: w.error };
      const d = resolveDate(a.date, state);
      if (d.error) return { ok: false, error: d.error };

      const weight = round1(w.value);
      const logs = ensureArray(state, 'weightLogs');

      // Previous weighing = nearest *older* record, looked up before the write
      // so re-logging the same day still compares against the day before.
      const older = logs
        .filter((r) => r && isValidDate(r.date) && r.date < d.date)
        .sort((x, y) => (x.date < y.date ? 1 : -1))[0] || null;

      const existing = logs.find((r) => r && r.date === d.date);
      const previousSameDay = existing ? num(existing.weight) : null;
      if (existing) existing.weight = weight;
      else logs.push({ date: d.date, weight });
      sortNewestFirst(logs);

      // Profile weight drives target math, so it must follow the newest known
      // value — but an old back-filled weighing must not overwrite it.
      const isNewest = logs.length > 0 && logs[0].date === d.date;
      let profileUpdated = false;
      if (d.date >= today || isNewest) {
        if (!state.profile || typeof state.profile !== 'object') state.profile = {};
        state.profile.weightKg = weight;
        profileUpdated = true;
      }

      const diff = older ? round1(weight - num(older.weight)) : null;
      let note = `Váha ${weight} kg zapsaná k ${d.date}.`;
      if (previousSameDay != null) note += ` Přepsán předchozí záznam ze stejného dne (${round1(previousSameDay)} kg).`;
      if (diff != null) {
        const dayGap = daysBetween(older.date, d.date);
        const dir = diff === 0 ? 'beze změny' : (diff > 0 ? `+${diff} kg` : `${diff} kg`);
        note += ` Proti minulému vážení ${older.date} (${round1(num(older.weight))} kg) ${dir} za ${dayGap} dní.`;
      } else {
        note += ' Je to první zaznamenané vážení, zatím není s čím porovnat.';
      }
      if (profileUpdated) note += ' Váha v profilu aktualizovaná.';

      return {
        ok: true,
        date: d.date,
        weight,
        previousWeight: older ? round1(num(older.weight)) : null,
        previousDate: older ? older.date : null,
        diffKg: diff,
        replacedSameDay: previousSameDay != null,
        profileUpdated,
        totalRecords: logs.length,
        note
      };
    }

    case 'delete_weight': {
      const d = resolveDate(a.date, state);
      if (d.error) return { ok: false, error: d.error };
      const logs = ensureArray(state, 'weightLogs');
      const idx = logs.findIndex((r) => r && r.date === d.date);
      if (idx === -1) {
        return { ok: false, error: `K datu ${d.date} žádné vážení není, mazat nemám co. Zapsaná vážení: ${logs.length}.` };
      }
      const removed = logs.splice(idx, 1)[0];

      // Profile weight would otherwise keep showing a number that no longer
      // exists anywhere in the history.
      let profileUpdated = false;
      if (logs.length && state.profile && typeof state.profile === 'object') {
        state.profile.weightKg = round1(num(logs[0].weight));
        profileUpdated = true;
      }
      return {
        ok: true,
        deleted: { date: removed.date, weight: round1(num(removed.weight)) },
        remaining: logs.length,
        profileUpdated,
        note: `Vážení ${round1(num(removed.weight))} kg k ${removed.date} smazáno, zbývá ${logs.length} záznamů.`
          + (profileUpdated ? ` Váha v profilu vrácena na ${state.profile.weightKg} kg (${logs[0].date}).` : '')
      };
    }

    case 'log_water': {
      const m = checkNum(a.ml, 50, 3000, 'Množství vody', 'ml');
      if (m.error) return { ok: false, error: m.error };
      const d = resolveDate(a.date, state);
      if (d.error) return { ok: false, error: d.error };

      const water = ensureMap(state, 'water');
      const before = Math.max(0, Math.round(num(water[d.date], 0)));
      const added = Math.round(m.value);
      const total = before + added;
      water[d.date] = total;

      return {
        ok: true,
        date: d.date,
        added,
        previousTotal: before,
        total,
        totalLiters: round1(total / 1000),
        note: `Přidáno ${added} ml vody k ${d.date}. Celkem za den ${total} ml (${round1(total / 1000)} l).`
      };
    }

    case 'set_water': {
      const m = checkNum(a.ml, 0, 15000, 'Denní příjem vody', 'ml');
      if (m.error) return { ok: false, error: m.error };
      const d = resolveDate(a.date, state);
      if (d.error) return { ok: false, error: d.error };

      const water = ensureMap(state, 'water');
      const before = Math.max(0, Math.round(num(water[d.date], 0)));
      const total = Math.round(m.value);
      water[d.date] = total;

      return {
        ok: true,
        date: d.date,
        previousTotal: before,
        total,
        totalLiters: round1(total / 1000),
        note: `Voda za ${d.date} přepsána z ${before} ml na ${total} ml (${round1(total / 1000)} l).`
      };
    }

    case 'log_body_measurement': {
      const d = resolveDate(a.date, state);
      if (d.error) return { ok: false, error: d.error };

      const given = {};
      for (const f of MEASURE_FIELDS) {
        if (a[f] == null || a[f] === '') continue;
        const c = checkNum(a[f], 10, 300, `Míra ${MEASURE_CZ[f]}`, 'cm');
        if (c.error) return { ok: false, error: c.error };
        given[f] = round1(c.value);
      }
      const fields = Object.keys(given);
      if (!fields.length) {
        return { ok: false, error: `Nedostal jsem žádnou míru. Pošli aspoň jednu z: ${MEASURE_FIELDS.join(', ')}.` };
      }

      const list = ensureArray(state, 'measurements');
      let rec = list.find((r) => r && r.date === d.date);
      const isNew = !rec;
      if (!rec) {
        rec = { date: d.date };
        list.push(rec);
      }
      // Per-field merge, NOT a record replace: the user usually reports one
      // measurement at a time, and overwriting the whole record would wipe the
      // other circumferences taken the same morning.
      const changed = [];
      for (const f of fields) {
        const prev = rec[f] != null ? num(rec[f]) : null;
        rec[f] = given[f];
        changed.push(prev != null && prev !== given[f]
          ? `${MEASURE_CZ[f]} ${given[f]} cm (bylo ${round1(prev)} cm)`
          : `${MEASURE_CZ[f]} ${given[f]} cm`);
      }
      sortNewestFirst(list);

      const kept = MEASURE_FIELDS.filter((f) => !fields.includes(f) && rec[f] != null);
      let note = `Míry k ${d.date}: ${changed.join(', ')}.`;
      if (kept.length) note += ` Beze změny zůstává ${kept.map((f) => `${MEASURE_CZ[f]} ${rec[f]} cm`).join(', ')}.`;
      if (isNew) note += ' Nový záznam měření.';

      return {
        ok: true,
        date: d.date,
        updatedFields: fields,
        keptFields: kept,
        measurement: Object.assign({}, rec),
        totalRecords: list.length,
        note
      };
    }

    case 'get_measurements_trend': {
      const field = fold(a.field);
      if (!MEASURE_FIELDS.includes(field)) {
        return { ok: false, error: `Neznámá míra "${a.field}". Vyber jednu z: ${MEASURE_FIELDS.join(', ')}.` };
      }
      const days = clamp(Math.round(num(a.days, 90)), 1, 3650);
      const list = Array.isArray(state.measurements) ? state.measurements : [];

      const points = list
        .filter((r) => r && isValidDate(r.date) && r[field] != null && Number.isFinite(Number(r[field])))
        .filter((r) => daysBetween(r.date, today) <= days)
        .map((r) => ({ date: r.date, value: round1(num(r[field])) }))
        .sort((x, y) => (x.date < y.date ? -1 : 1)); // oldest → newest for a readable trend

      if (!points.length) {
        return { ok: false, error: `Za posledních ${days} dní nemám žádné měření pro ${MEASURE_CZ[field]}. Nech uživatele změřit a zapiš to přes log_body_measurement.` };
      }
      if (points.length === 1) {
        return {
          ok: true, field, fieldCz: MEASURE_CZ[field], days, points, changeCm: null,
          note: `${MEASURE_CZ[field]}: zatím jen jedno měření — ${points[0].value} cm (${points[0].date}). Na trend je potřeba aspoň druhé.`
        };
      }

      const first = points[0];
      const last = points[points.length - 1];
      const change = round1(last.value - first.value);
      const span = daysBetween(first.date, last.date);
      const dir = change === 0 ? 'beze změny' : (change > 0 ? `+${change} cm` : `${change} cm`);
      return {
        ok: true,
        field,
        fieldCz: MEASURE_CZ[field],
        days,
        points,
        first,
        last,
        changeCm: change,
        spanDays: span,
        note: `${MEASURE_CZ[field]}: ${first.value} cm (${first.date}) → ${last.value} cm (${last.date}), tedy ${dir} za ${span} dní z ${points.length} měření.`
      };
    }

    case 'log_cardio': {
      const mins = checkNum(a.minutes, 1, 600, 'Délka kardia', 'min');
      if (mins.error) return { ok: false, error: mins.error };
      const d = resolveDate(a.date, state);
      if (d.error) return { ok: false, error: d.error };
      if (!a.type || !String(a.type).trim()) return { ok: false, error: 'Chybí typ aktivity (běh, kolo, plavání…).' };

      let distanceKm = null;
      if (a.distanceKm != null && a.distanceKm !== '') {
        const dist = checkNum(a.distanceKm, 0.1, 500, 'Vzdálenost', 'km');
        if (dist.error) return { ok: false, error: dist.error };
        distanceKm = round1(dist.value);
      }

      const type = normCardioType(a.type);
      const intensity = normIntensity(a.intensity);
      const minutes = Math.round(mins.value);
      // Body weight drives the burn; fall back to an average adult rather than
      // failing, and say so in the note so the number is not oversold.
      const weightKg = clamp(num(state.profile && state.profile.weightKg, 0) || 75, 30, 300);
      const kcal = Math.round(CARDIO_MET[type] * INTENSITY_FACTOR[intensity] * weightKg * (minutes / 60));

      const logs = ensureArray(state, 'cardioLogs');
      const entry = {
        id: genId('cardio'),
        date: d.date,
        type,
        typeCz: CARDIO_CZ[type],
        minutes,
        distanceKm,
        intensity,
        kcal
      };
      logs.push(entry);
      sortNewestFirst(logs);

      const dayTotal = logs.filter((r) => r.date === d.date).reduce((s, r) => s + num(r.kcal), 0);
      let note = `Zapsáno: ${CARDIO_CZ[type]} ${minutes} min`;
      if (distanceKm != null) note += `, ${distanceKm} km`;
      note += ` (${INTENSITY_CZ[intensity]} intenzita) k ${d.date}. Odhadovaný výdej ${kcal} kcal`;
      note += ` — je to ODHAD z MET tabulky a váhy ${weightKg} kg, ne měření, reálně to může být o 20 % vedle.`;
      if (dayTotal !== kcal) note += ` Celkem za ${d.date} ${Math.round(dayTotal)} kcal z kardia.`;

      return {
        ok: true,
        entry,
        dayTotalKcal: Math.round(dayTotal),
        estimated: true,
        note
      };
    }

    case 'log_steps': {
      const s = checkNum(a.steps, 0, 100000, 'Počet kroků', 'kroků');
      if (s.error) return { ok: false, error: s.error };
      const d = resolveDate(a.date, state);
      if (d.error) return { ok: false, error: d.error };

      const steps = ensureMap(state, 'steps');
      const before = steps[d.date] != null ? Math.round(num(steps[d.date])) : null;
      const value = Math.round(s.value);
      steps[d.date] = value;

      return {
        ok: true,
        date: d.date,
        steps: value,
        previousSteps: before,
        note: `Kroky k ${d.date}: ${value}.`
          + (before != null && before !== value ? ` Přepsána předchozí hodnota ${before}.` : '')
      };
    }

    case 'log_sleep': {
      const h = checkNum(a.hours, 0, 24, 'Délka spánku', 'h');
      if (h.error) return { ok: false, error: h.error };
      const d = resolveDate(a.date, state);
      if (d.error) return { ok: false, error: d.error };

      let quality = null;
      if (a.quality != null && a.quality !== '') {
        const q = checkNum(a.quality, 1, 5, 'Kvalita spánku', 'b.');
        if (q.error) return { ok: false, error: q.error };
        quality = clamp(Math.round(q.value), 1, 5);
      }

      const logs = ensureArray(state, 'sleepLogs');
      const hours = round1(h.value);
      const existing = logs.find((r) => r && r.date === d.date);
      const before = existing ? round1(num(existing.hours)) : null;
      if (existing) {
        existing.hours = hours;
        // Only overwrite quality when a new one came in — otherwise a plain
        // "spal jsem 7 hodin" correction would erase the rating from earlier.
        if (quality != null) existing.quality = quality;
      } else {
        logs.push({ date: d.date, hours, quality });
      }
      sortNewestFirst(logs);

      const rec = logs.find((r) => r.date === d.date);
      const recent = logs.slice(0, 7);
      const avg = recent.length ? round1(recent.reduce((s, r) => s + num(r.hours), 0) / recent.length) : hours;

      return {
        ok: true,
        date: d.date,
        hours,
        quality: rec.quality != null ? rec.quality : null,
        replaced: before != null,
        avg7: avg,
        note: `Spánek ${hours} h k ${d.date}`
          + (rec.quality != null ? `, kvalita ${rec.quality}/5` : '')
          + (before != null ? ` (přepsáno z ${before} h)` : '')
          + `. Průměr z posledních ${recent.length} záznamů je ${avg} h.`
      };
    }

    case 'log_mood': {
      const m = checkNum(a.mood, 1, 5, 'Nálada', 'b.');
      if (m.error) return { ok: false, error: m.error };
      const e = checkNum(a.energy, 1, 5, 'Energie', 'b.');
      if (e.error) return { ok: false, error: e.error };
      const d = resolveDate(a.date, state);
      if (d.error) return { ok: false, error: d.error };

      const mood = clamp(Math.round(m.value), 1, 5);
      const energy = clamp(Math.round(e.value), 1, 5);
      const note = a.note ? String(a.note).slice(0, 200) : '';

      const logs = ensureArray(state, 'moodLogs');
      const existing = logs.find((r) => r && r.date === d.date);
      const before = existing ? { mood: existing.mood, energy: existing.energy } : null;
      if (existing) {
        existing.mood = mood;
        existing.energy = energy;
        if (note) existing.note = note; // keep an older note when none was sent
      } else {
        logs.push({ date: d.date, mood, energy, note });
      }
      sortNewestFirst(logs);

      return {
        ok: true,
        date: d.date,
        mood,
        energy,
        replaced: !!before,
        previous: before,
        note: `Nálada ${mood}/5 a energie ${energy}/5 zapsané k ${d.date}`
          + (before ? ` (přepsáno z nálady ${before.mood}/5, energie ${before.energy}/5)` : '')
          + '.'
          + (energy <= 2 ? ' Energie je nízká — stojí za to probrat spánek a příjem kalorií.' : '')
      };
    }

    // Records only. Rebuilding someone's training week off a single mention of
    // pain would be a big, silent change to a plan they never asked to touch —
    // and the coach cannot tell "tvrdlo mě rameno" from a real injury. So the
    // note tells the model to ASK, and the plan tools stay the explicit,
    // separate step.
    case 'log_injury': {
      const part = String(a.bodyPart || '').trim().slice(0, 60);
      if (!part) return { ok: false, error: 'Chybí část těla — napiš, co uživatele bolí.' };
      const s = checkNum(a.severity, 1, 5, 'Závažnost zranění', 'b.');
      if (s.error) return { ok: false, error: s.error };
      const d = resolveDate(a.date, state);
      if (d.error) return { ok: false, error: d.error };

      const severity = clamp(Math.round(s.value), 1, 5);
      const injuries = ensureArray(state, 'injuries');
      const key = fold(part);

      // Re-reporting the same body part updates the open record instead of
      // stacking duplicates the user would have to resolve one by one.
      const open = injuries.find((r) => r && r.active !== false && fold(r.bodyPart) === key);
      let entry;
      let updated = false;
      if (open) {
        updated = true;
        open.severity = severity;
        open.date = d.date;
        if (a.note) open.note = String(a.note).slice(0, 300);
        entry = open;
      } else {
        entry = {
          id: genId('inj'),
          date: d.date,
          bodyPart: part,
          severity: severity,
          note: a.note ? String(a.note).slice(0, 300) : '',
          active: true
        };
        injuries.push(entry);
      }
      sortNewestFirst(injuries);

      const activeCount = injuries.filter((r) => r.active !== false).length;
      return {
        ok: true,
        injury: Object.assign({}, entry),
        updated,
        activeInjuries: activeCount,
        planChanged: false,
        note: `Zaznamenáno zranění: ${part}, závažnost ${severity}/5, datum ${d.date}`
          + (updated ? ' (aktualizován už evidovaný záznam)' : '')
          + '. TRÉNINKOVÝ PLÁN JSEM NEMĚNIL. Zeptej se uživatele, jestli má plán upravit (vynechat zatěžující cviky, nahradit je), a teprve po jeho souhlasu použij update_workout_day nebo set_workout_plan.'
          + (severity >= 4 ? ' Při závažnosti 4-5 doporuč návštěvu lékaře nebo fyzioterapeuta — tohle nemá řešit trenér přes chat.' : '')
      };
    }

    case 'resolve_injury': {
      const part = String(a.bodyPart || '').trim();
      if (!part) return { ok: false, error: 'Chybí část těla — napiš, co se vyléčilo.' };
      const injuries = ensureArray(state, 'injuries');
      const key = fold(part);

      let hit = injuries.find((r) => r && r.active !== false && fold(r.bodyPart) === key);
      // Loose fallback: the user rarely repeats "levé koleno" word for word.
      if (!hit) hit = injuries.find((r) => r && r.active !== false
        && (fold(r.bodyPart).includes(key) || key.includes(fold(r.bodyPart))));

      if (!hit) {
        const openList = injuries.filter((r) => r.active !== false).map((r) => r.bodyPart);
        return {
          ok: false,
          error: openList.length
            ? `Aktivní zranění "${part}" nemám. Evidovaná aktivní zranění: ${openList.join(', ')}.`
            : 'Žádné aktivní zranění není evidované, nemám co uzavřít.'
        };
      }

      hit.active = false;
      hit.resolvedDate = today; // history stays, it is just no longer active
      const remaining = injuries.filter((r) => r.active !== false);
      return {
        ok: true,
        resolved: Object.assign({}, hit),
        activeInjuries: remaining.length,
        note: `Zranění "${hit.bodyPart}" (závažnost ${hit.severity}/5, od ${hit.date}) označeno za vyléčené k ${today}.`
          + (remaining.length
            ? ` Aktivní zůstává: ${remaining.map((r) => r.bodyPart).join(', ')}.`
            : ' Žádné další aktivní zranění není.')
          + ' Plán jsem nevracel zpátky — pokud byl kvůli tomu upravený, nabídni uživateli návrat k původním cvikům.'
      };
    }

    default:
      return { ok: false, error: `Neznámý nástroj ${name}.` };
  }
}

module.exports = {
  BODY_TOOLS,
  BODY_TOOL_NAMES,
  applyBodyTool,
  // exported for tests / reuse
  CARDIO_MET,
  MEASURE_FIELDS
};
