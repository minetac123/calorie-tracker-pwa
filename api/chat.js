// AI coach chat endpoint. Combines the user's WHOOP metrics (fetched
// server-side from the stored token) with the food/calorie context sent by
// the client, then asks Gemini for a personalised answer.
const { extractUsername, getValidToken, fetchWhoopSnapshot } = require('./_lib/whoop');

// Gemini key comes from the environment (set GEMINI_API_KEY in Vercel).
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

function fmtWhoop(w) {
  if (!w) return 'WHOOP není připojen nebo nemá dnes žádná data.';
  const lines = [];
  if (w.recovery) {
    lines.push(`- Recovery: ${w.recovery.recoveryScore != null ? w.recovery.recoveryScore + '%' : 'n/a'}`);
    if (w.recovery.hrvMs != null) lines.push(`- HRV: ${w.recovery.hrvMs} ms`);
    if (w.recovery.restingHeartRate != null) lines.push(`- Klidová tepová frekvence: ${w.recovery.restingHeartRate} bpm`);
    if (w.recovery.spo2 != null) lines.push(`- SpO2: ${w.recovery.spo2} %`);
  }
  if (w.strain) {
    if (w.strain.strain != null) lines.push(`- Denní strain: ${w.strain.strain}`);
    if (w.strain.activeKcal != null) lines.push(`- Spáleno (WHOOP odhad): ${w.strain.activeKcal} kcal`);
    if (w.strain.averageHeartRate != null) lines.push(`- Průměrná tepovka: ${w.strain.averageHeartRate} bpm`);
  }
  if (w.sleep) {
    if (w.sleep.performancePercentage != null) lines.push(`- Výkon spánku: ${w.sleep.performancePercentage} %`);
    if (w.sleep.totalInBedMs != null) lines.push(`- Spánek (v posteli): ${(w.sleep.totalInBedMs / 3600000).toFixed(1)} h`);
    if (w.sleep.respiratoryRate != null) lines.push(`- Dechová frekvence: ${Math.round(w.sleep.respiratoryRate * 10) / 10} /min`);
  }
  return lines.length ? lines.join('\n') : 'WHOOP připojen, ale dnes zatím nejsou data.';
}

function fmtFood(food) {
  if (!food) return 'Žádný kontext o jídle nebyl poskytnut.';
  const lines = [];
  if (food.date) lines.push(`Datum: ${food.date}`);
  if (food.goals) {
    lines.push(`Denní cíle: ${food.goals.calories} kcal, B ${food.goals.protein} g, S ${food.goals.carbs} g, T ${food.goals.fat} g`);
  }
  if (food.totals) {
    lines.push(`Snězeno dnes: ${food.totals.calories} kcal, B ${food.totals.protein} g, S ${food.totals.carbs} g, T ${food.totals.fat} g`);
  }
  if (Array.isArray(food.items) && food.items.length) {
    lines.push('Jídla dnes:');
    food.items.forEach((it) => {
      lines.push(`  • ${it.name} (${it.amount || ''}) – ${it.calories} kcal, B ${it.protein} g, S ${it.carbs} g, T ${it.fat} g`);
    });
  } else {
    lines.push('Dnes zatím nebylo zapsáno žádné jídlo.');
  }
  if (food.weight != null) lines.push(`Aktuální váha: ${food.weight} kg`);
  return lines.join('\n');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Metoda není povolena' });
  }

  const username = extractUsername(req.headers.authorization);
  if (!username) {
    return res.status(401).json({ error: 'Nepřihlášen' });
  }

  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'AI Kouč není nakonfigurován (chybí GEMINI_API_KEY).' });
  }

  try {
    const { message, history, foodContext } = req.body || {};
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Prázdná zpráva' });
    }

    // Pull WHOOP metrics server-side (token never leaves the backend).
    let whoopSnapshot = null;
    const token = await getValidToken(username);
    if (token && !token._expired) {
      whoopSnapshot = await fetchWhoopSnapshot(token.accessToken);
    }

    const systemInstruction = `Jsi osobní zdravotní a fitness kouč v aplikaci FitAI. Mluvíš česky, přátelsky, stručně a konkrétně. Máš přístup k datům uživatele z náramku WHOOP (regenerace, spánek, zátěž, tepová frekvence) a k jeho dnešnímu jídelníčku a kaloriím z aplikace.

Tvým úkolem je propojit tato data a dávat praktické rady: např. když je nízká regenerace, doporuč odpočinek a vhodnou výživu; když uživatel překračuje kalorický cíl, upozorni ho; spoj kvalitu spánku, zátěž a příjem kalorií do smysluplných doporučení. Nediagnostikuj nemoci a u vážných zdravotních potíží doporuč lékaře. Odpovídej v běžném textu (ne JSON), klidně používej krátké odrážky a emoji střídmě.

=== WHOOP DATA ===
${fmtWhoop(whoopSnapshot)}

=== JÍDLO A KALORIE (z aplikace) ===
${fmtFood(foodContext)}`;

    // Build Gemini conversation contents from prior history + new message.
    const contents = [];
    if (Array.isArray(history)) {
      history.slice(-12).forEach((m) => {
        if (!m || !m.text) return;
        contents.push({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.text }]
        });
      });
    }
    contents.push({ role: 'user', parts: [{ text: message }] });

    const payload = {
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents,
      generationConfig: { temperature: 0.7, maxOutputTokens: 1024 }
    };

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const gResp = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!gResp.ok) {
      const txt = await gResp.text();
      console.error('Gemini error:', gResp.status, txt);
      return res.status(502).json({ error: 'AI služba nedostupná' });
    }

    const gData = await gResp.json();
    const reply =
      gData &&
      gData.candidates &&
      gData.candidates[0] &&
      gData.candidates[0].content &&
      gData.candidates[0].content.parts &&
      gData.candidates[0].content.parts[0]
        ? gData.candidates[0].content.parts[0].text
        : null;

    if (!reply) {
      return res.status(502).json({ error: 'AI nevrátila odpověď' });
    }

    return res.status(200).json({
      success: true,
      reply,
      whoopConnected: !!whoopSnapshot
    });
  } catch (error) {
    console.error('Chat error:', error);
    return res.status(500).json({ error: 'Chyba serveru: ' + error.message });
  }
};
