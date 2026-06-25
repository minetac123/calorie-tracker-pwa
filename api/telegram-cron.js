// Daily proactive check-in sent to all Telegram-linked users.
// Triggered by Vercel Cron (see vercel.json). Vercel passes
// Authorization: Bearer <CRON_SECRET> automatically when CRON_SECRET is set.
const { list } = require('@vercel/blob');
const { getTelegramIndex, sendMessage } = require('./_lib/telegram');
const { getValidToken, fetchWhoopSnapshot } = require('./_lib/whoop');

const COACH_API_KEY = process.env.COACH_API_KEY || process.env.GEMINI_API_KEY || '';
const COACH_MODEL = process.env.COACH_MODEL || 'gemini-2.5-flash';
const CRON_SECRET = process.env.CRON_SECRET || '';

module.exports = async function handler(req, res) {
  // Accept the Vercel cron invocation (Authorization: Bearer <CRON_SECRET>)
  if (CRON_SECRET) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${CRON_SECRET}`) {
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

  for (const { username, chatId } of index) {
    try {
      // Load user data
      const blobs = await list({ prefix: `data/${username}.json` });
      if (!blobs.blobs || blobs.blobs.length === 0) continue;
      const base = blobs.blobs[0].url;
      const fresh = base + (base.includes('?') ? '&' : '?') + '_=' + Date.now();
      const userResp = await fetch(fresh, { cache: 'no-store' });
      const userData = await userResp.json();

      const goals = userData.goals || { calories: 2000 };
      const logs = (userData.logs && userData.logs[today]) || [];
      const consumed = Math.round(logs.reduce((s, i) => s + (Number(i.calories) || 0), 0));

      // Optional WHOOP data
      let whoopLine = '';
      try {
        const token = await getValidToken(username);
        if (token && !token._expired) {
          const snap = await fetchWhoopSnapshot(token.accessToken);
          if (snap && snap.recovery && snap.recovery.recoveryScore != null) {
            whoopLine = ` Recovery ${snap.recovery.recoveryScore}%,`;
          }
        }
      } catch (e) { /* WHOOP optional */ }

      const prompt = `Napiš jednu krátkou ranní zprávu (max 100 znaků, gen-z čeština, začínej malým písmenem, bez tečky, žádné emoji, konkrétní a motivující ne generické). Kontext:${whoopLine} dnesni cil ${goals.calories} kcal, zatim snezeno ${consumed} kcal.`;

      const payload = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.9, maxOutputTokens: 150, thinkingConfig: { thinkingBudget: 0 } }
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

  return res.status(200).json({ sent, total: index.length });
};
