// ---------------------------------------------------------------------------
// Detekce toho, co se v datech opravdu děje
// ---------------------------------------------------------------------------
// The daily check-in used to fire every morning with a generic line, which is
// noise: a message that arrives whether or not anything happened trains you to
// ignore it. This finds the things actually worth interrupting someone for —
// deterministically, from their own numbers — and ranks them. When nothing
// scores, nothing gets sent. Silence is a valid outcome and the common one.
//
// The model only phrases what is found here. It never decides what is true.

const DAY = 86400000;

function toDate(s) {
  const d = new Date(String(s) + 'T12:00:00Z');
  return isNaN(d) ? null : d;
}

function daysBetween(a, b) {
  const x = toDate(a), y = toDate(b);
  if (!x || !y) return null;
  return Math.round((y - x) / DAY);
}

function topSet(session) {
  if (!session || !Array.isArray(session.sets)) return null;
  // Entries can be null or missing their numbers when storage was written by an
  // older build or half-corrupted. A set without a real weight is not a set —
  // letting one through produced "nový osobák: 60 undefined kg" in a push.
  const valid = session.sets.filter((s) =>
    s && Number.isFinite(Number(s.w)) && Number(s.w) > 0);
  if (!valid.length) return null;
  return valid.reduce((best, s) => (Number(s.w) > Number(best.w) ? s : best), valid[0]);
}

function recentDates(today, n) {
  const out = [];
  const base = toDate(today);
  if (!base) return out;
  for (let i = 1; i <= n; i++) {
    out.push(new Date(base.getTime() - i * DAY).toISOString().slice(0, 10));
  }
  return out;
}

function dayKeyForDate(dateStr) {
  const d = toDate(dateStr);
  if (!d) return null;
  return ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'][(d.getUTCDay() + 6) % 7];
}

// --- jednotlivé detektory ---------------------------------------------------
// Each returns a signal object or null. `weight` is the priority: higher wins
// when several fire at once, because only one gets sent.

function sigStagnation(d) {
  const logs = d.exerciseLogs || {};
  let worst = null;
  Object.keys(logs).forEach((k) => {
    const ex = logs[k];
    const sessions = (ex && ex.sessions) || [];
    if (sessions.length < 3) return;
    const last3 = sessions.slice(-3);
    const tops = last3.map(topSet).filter(Boolean);
    if (tops.length < 3) return;
    const best = Math.max.apply(null, tops.map((t) => t.w));
    if (tops.some((t) => t.w < best)) return; // not flat, it moved
    const span = daysBetween(last3[0].date, last3[2].date);
    if (span == null || span < 14) return;    // flat but too recent to matter
    if (!worst || span > worst.span) {
      worst = { name: ex.name || k, weight: best, span, sessions: last3.length };
    }
  });
  if (!worst) return null;
  return {
    id: 'stagnace',
    weight: 70,
    fact: `${worst.name} stojí na ${worst.weight} kg už ${worst.sessions} tréninky v řadě (${worst.span} dní)`,
    hint: 'navrhni deload asi o 10 % na týden, nebo výměnu cviku'
  };
}

function sigPersonalBest(d, today) {
  const logs = d.exerciseLogs || {};
  let best = null;
  Object.keys(logs).forEach((k) => {
    const ex = logs[k];
    const sessions = (ex && ex.sessions) || [];
    if (sessions.length < 3) return;
    const last = sessions[sessions.length - 1];
    const age = daysBetween(last.date, today);
    if (age == null || age > 2) return;      // only a fresh one is news
    const t = topSet(last);
    if (!t) return;
    const prior = sessions.slice(0, -1).map(topSet).filter(Boolean);
    if (!prior.length) return;
    const priorBest = Math.max.apply(null, prior.map((x) => x.w));
    if (t.w <= priorBest) return;
    const gain = Math.round((t.w - priorBest) * 10) / 10;
    if (!best || gain > best.gain) {
      best = { name: ex.name || k, w: t.w, r: t.r, gain };
    }
  });
  if (!best) return null;
  return {
    id: 'osobak',
    weight: 85,
    fact: `nový osobák: ${best.name} ${best.w} kg × ${best.r}, o ${best.gain} kg víc než kdy předtím`,
    hint: 'pochval ho konkrétně za tohle číslo, jednou větou'
  };
}

function sigNoWeighIn(d, today) {
  const wl = (Array.isArray(d.weightLogs) ? d.weightLogs : [])
    .filter((x) => x && x.date != null && Number.isFinite(Number(x.weight)));
  if (!wl.length) return null;
  wl.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const last = wl[wl.length - 1];
  const age = daysBetween(last.date, today);
  // Same idea: remind on day 8, 12, 16 — not every morning forever.
  if (age == null || age < 8 || age % 4 !== 0) return null;
  return {
    id: 'vazeni',
    weight: 50,
    fact: `naposledy se vážil před ${age} dny (${last.weight} kg)`,
    hint: 'připomeň mu vážení, bez kázání'
  };
}

function sigMissedTraining(d, today) {
  const plan = d.workoutPlan;
  if (!plan || !plan.days) return null;
  const last7 = recentDates(today, 7);
  let planned = 0, done = 0;
  last7.forEach((date) => {
    const day = plan.days[dayKeyForDate(date)];
    if (!day || day.rest || !Array.isArray(day.exercises) || !day.exercises.length) return;
    planned++;
    const log = (d.workoutLogs || {})[date];
    const doneIds = (log && Array.isArray(log.done)) ? log.done : [];
    if (doneIds.length >= Math.ceil(day.exercises.length / 2)) done++;
  });
  if (planned < 2 || done >= planned) return null;
  const missed = planned - done;
  if (missed < 2) return null;
  return {
    id: 'vynechane',
    weight: 60,
    fact: `za posledních 7 dní odcvičil ${done} ze ${planned} naplánovaných tréninků`,
    hint: 'zeptej se bez výčitek, jestli plán sedí, nebo ho má zvolnit'
  };
}

function sigStreak(d, today) {
  const plan = d.workoutPlan;
  if (!plan || !plan.days) return null;
  const last14 = recentDates(today, 14);
  let streak = 0;
  for (const date of last14) {
    const day = plan.days[dayKeyForDate(date)];
    if (!day || day.rest || !Array.isArray(day.exercises) || !day.exercises.length) continue;
    const log = (d.workoutLogs || {})[date];
    const doneIds = (log && Array.isArray(log.done)) ? log.done : [];
    if (doneIds.length >= Math.ceil(day.exercises.length / 2)) streak++;
    else break;
  }
  // Every day of a run is not news. Milestones are: fire at 4, 8, 12…
  if (streak < 4 || streak % 4 !== 0) return null;
  return {
    id: 'serie',
    weight: 55,
    fact: `${streak} naplánovaných tréninků po sobě bez vynechání`,
    hint: 'krátce oceň, žádné fanfáry'
  };
}

function sigProtein(d, today) {
  const goal = d.goals && Number(d.goals.protein);
  if (!goal) return null;
  const days = recentDates(today, 5);
  const vals = [];
  days.forEach((date) => {
    const items = (d.logs || {})[date];
    if (!Array.isArray(items) || !items.length) return;
    vals.push(items.reduce((s, i) => s + (Number(i.protein) || 0), 0));
  });
  if (vals.length < 3) return null;
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  if (avg >= goal * 0.8) return null;
  return {
    id: 'bilkoviny',
    weight: 45,
    fact: `za poslední ${vals.length} dny má průměr bílkovin ${Math.round(avg)} g při cíli ${goal} g`,
    hint: 'nabídni jednu konkrétní věc, kterou to dožene'
  };
}

function sigNothingLogged(d, today) {
  const days = recentDates(today, 3);
  const empty = days.every((date) => {
    const items = (d.logs || {})[date];
    return !Array.isArray(items) || !items.length;
  });
  if (!empty) return null;
  // Fire on exactly the third empty day: the day before the gap must have had
  // a log, otherwise this repeats every morning of a long break.
  const dayBefore = recentDates(today, 4)[3];
  const beforeItems = (d.logs || {})[dayBefore];
  if (!Array.isArray(beforeItems) || !beforeItems.length) return null;
  // Someone who never logged at all is a different situation — that is
  // onboarding, not a lapse, and a nag would be the wrong first contact.
  const everLogged = Object.keys(d.logs || {}).some((k) => (d.logs[k] || []).length);
  if (!everLogged) return null;
  return {
    id: 'nezapisuje',
    weight: 40,
    fact: 'tři dny po sobě nezapsal žádné jídlo, i když předtím zapisoval',
    hint: 'jednou větou se zeptej, jestli je všechno ok — nehuč do něj'
  };
}

function detectSignals(userData, today) {
  const d = userData || {};
  const found = [
    sigPersonalBest(d, today),
    sigStagnation(d),
    sigMissedTraining(d, today),
    sigStreak(d, today),
    sigNoWeighIn(d, today),
    sigProtein(d, today),
    sigNothingLogged(d, today)
  ].filter(Boolean);
  found.sort((a, b) => b.weight - a.weight);
  return found;
}

module.exports = { detectSignals, dayKeyForDate, daysBetween, topSet };
