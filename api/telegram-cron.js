// Daily proactive check-in sent to all Telegram-linked users.
// Triggered by Vercel Cron (see vercel.json). Vercel passes
// Authorization: Bearer <CRON_SECRET> automatically when CRON_SECRET is set.
//
// This used to send a generic line every single morning. A message that arrives
// whether or not anything happened is noise, and noise gets muted. Now the data
// is checked for something actually worth saying, and when nothing scores, the
// user hears nothing at all — which is most days, by design.
const { kvGet } = require('./_lib/store');
const { getTelegramIndex, sendMessage } = require('./_lib/telegram');
const { detectSignals } = require('./_lib/signals');

const COACH_API_KEY = process.env.COACH_API_KEY || process.env.GEMINI_API_KEY || '';
const COACH_MODEL = process.env.COACH_MODEL || 'gemini-2.5-flash';
// Trimmed because a mobile paste into the Vercel dashboard can pick up a
// trailing newline that is invisible and unfixable from the UI. The secret's
// actual content still has to match exactly.
const CRON_SECRET = (process.env.CRON_SECRET || '').trim();

module.exports = async function handler(req, res) {
  // Accept the Vercel cron invocation (Authorization: Bearer <CRON_SECRET>)
  if (CRON_SECRET) {
    const auth = req.headers.authorization || '';
    if (auth.replace(/^Bearer\s+/, '').trim() !== CRON_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const index = await getTelegramIndex();
  if (!index || index.length === 0) return res.status(200).json({ sent: 0 });

  // Czech local date so it matches the keys the app stores logs under.
  let today;
  try {
    today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
  } catch (e) {
    today = new Date().toISOString().split('T')[0];
  }
  let sent = 0;
  let skipped = 0;

  for (const { username, chatId } of index) {
    try {
      // Load user data
      const userData = await kvGet(`data/${username}.json`);
      if (!userData) continue;

      const signals = detectSignals(userData, today);
      if (!signals.length) {
        skipped++;
        continue; // nothing happened worth a notification — stay quiet
      }
      const top = signals[0];
      console.log(`Cron: ${username} -> ${top.id}`);

      const prompt = `Jsi AI kouč a píšeš uživateli sám od sebe do Telegramu, protože sis něčeho všiml v jeho datech.

TOHLE JSI ZJISTIL (je to pravda, spočítáno z jeho čísel):
${top.fact}

CO S TÍM: ${top.hint}

JAK PSÁT:
- jedna zpráva, max 160 znaků
- začni malým písmenem, nekonči tečkou, žádné emoji
- gen-z čeština, mluv jako kámoš
- ZMIŇ TO KONKRÉTNÍ ČÍSLO z toho, co jsi zjistil — bez něj je zpráva k ničemu
- nekonči otázkou, pokud na ni fakt potřebuješ odpověď
- žádné motivační fráze typu "makej dál" nebo "jen tak dál"
- nevymýšlej si žádná další čísla ani fakta, máš jen tohle`;

      const payload = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.8, maxOutputTokens: 200, thinkingConfig: { thinkingBudget: 0 } }
      };

      let reply = null;
      for (const model of [COACH_MODEL, 'gemini-flash-latest']) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10000);
        try {
          const gResp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${COACH_API_KEY}`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: ctrl.signal }
          );
          clearTimeout(timer);
          if (gResp.ok) {
            const gData = await gResp.json();
            const cand = gData && gData.candidates && gData.candidates[0];
            if (cand && cand.content && Array.isArray(cand.content.parts)) {
              reply = cand.content.parts.map((p) => p.text || '').join('').trim();
            }
            if (reply) break;
          }
        } catch (e) {
          clearTimeout(timer);
        }
      }

      if (reply) {
        await sendMessage(chatId, reply);
        sent++;
      }
    } catch (e) {
      console.error(`Cron: error for ${username}:`, e.message);
    }
  }

  return res.status(200).json({ sent, skipped, total: index.length });
};
