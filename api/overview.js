// AI overview for the dashboard card.
//
// The app already computes a deterministic version of this line locally, and
// that one is what the user sees first. This endpoint exists to say something
// the prewritten branches can't — connecting the day's food, training and any
// running calorie mode into one read. It is therefore allowed to fail: the
// client falls back to its local line and nothing breaks.
//
// Deliberately narrow: no tools, no state mutation, no chat history. It gets
// today's numbers and returns two short strings.
const { extractUsername } = require('./_lib/auth');
const { fmtFood } = require('./_lib/coach');

const COACH_API_KEY = process.env.COACH_API_KEY || process.env.GEMINI_API_KEY || '';
const COACH_MODEL = process.env.COACH_MODEL || 'gemini-2.5-flash';

const ACTIONS = ['workout', 'meals', 'add', 'session'];

function buildPrompt(ctx) {
  const mode = ctx.calorieMode;
  return `Jsi AI kouč v appce FitAI. Píšeš JEDEN dvouřádkový přehled dne, který uživatel vidí
jako kartu nahoře na hlavní obrazovce. Není to konverzace — nikdo ti neodpovídá.

FORMÁT ODPOVĚDI — vrať PŘESNĚ tohle, nic víc:
{"text":"hlavní řádek","sub":"druhý řádek","action":null}

PRAVIDLA:
- "text" je max 32 znaků, malým písmenem, bez tečky na konci. To hlavní, co se dneska děje
- "sub" je max 42 znaků, malým písmenem, bez tečky. Doplnění nebo konkrétní další krok
- Mluv v číslech, co fakt máš níž. Nikdy si nevymýšlej kalorie, váhy ani jídla
- Žádné emoji, žádné vykřičníky, žádné oslovení jménem
- Nikdy nepiš otázku. Tohle je cedule, ne dotaz
- Buď konkrétní. "dneska to jde" je k ničemu, "zbývá 420 kcal a 30 g bílkovin" je užitečné
- "action" smí být jen jedna z: "workout" (má rozdělaný trénink), "meals" (ať kouká
  do jídelníčku), "add" (ať si zapíše jídlo), "session" (běží mu trénink), nebo null
${mode ? `
BĚŽÍ DOČASNÝ REŽIM: „${mode.label}" do ${mode.until}.
Cíle jsou kvůli tomu dočasně jinde a je to tak správně. NEPIŠ, že je přes cíl nebo že
to má dohánět — tohle je plánovaná pauza. Klidně to zmiň jménem („dovolená, ${ctx.targets && ctx.targets.calories ? ctx.targets.calories + ' kcal' : 'vyšší cíl'}").
` : ''}
=== DNEŠNÍ ČÍSLA ===
${fmtFood(ctx.foodContext)}

=== DNEŠNÍ TRÉNINK ===
${ctx.workoutStatus || 'Není info o tréninku.'}

=== CO VÍŠ O UŽIVATELI ===
${ctx.memBlock}

Teď je ${ctx.nowTime || '?'}, dnes je ${ctx.todayDate}.
Ber denní dobu v potaz — ráno je celý den před ním, večer už se toho moc nezmění.

Vrať jen ten JSON objekt.`;
}

// The model is told to return bare JSON but will sometimes wrap it in a code
// fence or add a sentence around it. Pull the first balanced object out.
function parseOverview(raw) {
  const s = String(raw || '');
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metoda není povolena' });

  const username = await extractUsername(req.headers.authorization);
  if (!username) return res.status(401).json({ error: 'Nepřihlášen' });
  if (!COACH_API_KEY) return res.status(500).json({ error: 'AI kouč není nakonfigurován' });

  try {
    const { foodContext, workoutStatus, targets, calorieMode, memories, today, nowTime } = req.body || {};

    const memBlock = (Array.isArray(memories) && memories.length)
      ? memories.slice(0, 20).map((m) => `- ${String(m).trim()}`).join('\n')
      : 'Zatím nic.';

    const prompt = buildPrompt({
      foodContext, workoutStatus, targets, calorieMode, memBlock,
      todayDate: today || 'dnes',
      nowTime: (typeof nowTime === 'string' && /^\d{1,2}:\d{2}$/.test(nowTime)) ? nowTime : null
    });

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);
    let gResp;
    try {
      gResp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${COACH_MODEL}:generateContent?key=${COACH_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: prompt }] },
            contents: [{ role: 'user', parts: [{ text: 'Napiš přehled dneška.' }] }],
            generationConfig: {
              temperature: 0.6,
              maxOutputTokens: 200,
              thinkingConfig: { thinkingBudget: 0 },
              responseMimeType: 'application/json'
            }
          }),
          signal: ctrl.signal
        }
      );
    } finally {
      clearTimeout(timer);
    }

    if (!gResp || !gResp.ok) {
      return res.status(200).json({ success: false, reason: 'model' });
    }

    const gData = await gResp.json();
    const cand = gData && gData.candidates && gData.candidates[0];
    const raw = (cand && cand.content && Array.isArray(cand.content.parts))
      ? cand.content.parts.map((p) => (p && p.text) ? p.text : '').join('')
      : '';

    const parsed = parseOverview(raw);
    if (!parsed || !parsed.text) {
      return res.status(200).json({ success: false, reason: 'parse' });
    }

    const action = ACTIONS.includes(parsed.action) ? parsed.action : null;
    return res.status(200).json({
      success: true,
      text: String(parsed.text).slice(0, 80),
      sub: String(parsed.sub || '').slice(0, 90),
      action
    });
  } catch (error) {
    // Never surface this as a 500: the client treats any failure as "keep the
    // local line", and an error page in the log helps nobody.
    console.error('Overview error:', error.name === 'AbortError' ? 'timeout' : error.message);
    return res.status(200).json({ success: false, reason: 'error' });
  }
};
