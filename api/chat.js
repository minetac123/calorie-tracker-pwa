// AI coach chat endpoint. Combines the user's WHOOP metrics (fetched
// server-side from the stored token) with the food/calorie context sent by
// the client, then asks Gemini for a personalised answer.
const { extractUsername, getValidToken, fetchWhoopSnapshot } = require('./_lib/whoop');

// The coach can use its own dedicated key + model (set COACH_API_KEY /
// COACH_MODEL in Vercel). Falls back to the shared GEMINI_API_KEY and a
// smart-but-fast default model.
const COACH_API_KEY = process.env.COACH_API_KEY || process.env.GEMINI_API_KEY || '';
const COACH_MODEL = process.env.COACH_MODEL || 'gemini-2.5-flash';

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
    lines.push('Jídla dnes (s id pro úpravy/mazání):');
    food.items.forEach((it) => {
      lines.push(`  • [id:${it.id}] ${it.name} (${it.amount || ''}) [${it.category || ''}] – ${it.calories} kcal, B ${it.protein} g, S ${it.carbs} g, T ${it.fat} g`);
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

  if (!COACH_API_KEY) {
    return res.status(500).json({ error: 'AI Kouč není nakonfigurován (chybí COACH_API_KEY / GEMINI_API_KEY).' });
  }

  try {
    const { message, history, foodContext, memories, image, today } = req.body || {};
    if ((!message || !message.trim()) && !image) {
      return res.status(400).json({ error: 'Prázdná zpráva' });
    }
    const viewDate = (foodContext && foodContext.date) || 'today';
    const todayDate = (today && /^\d{4}-\d{2}-\d{2}$/.test(today)) ? today : viewDate;

    // Manual facts the user asked the coach to always remember.
    const memBlock = (Array.isArray(memories) && memories.length)
      ? memories.map((m) => `- ${String(m).trim()}`).join('\n')
      : 'Žádná uložená fakta.';

    // Pull WHOOP metrics server-side (token never leaves the backend).
    let whoopSnapshot = null;
    const token = await getValidToken(username);
    if (token && !token._expired) {
      whoopSnapshot = await fetchWhoopSnapshot(token.accessToken);
    }

    const systemInstruction = `Jsi AI kouč v appce FitAI a píšeš jako kámoš z gen z, ne jako oficiální asistent. Čeština, neformálně, vtipně, trochu drze ale v jádru tě to zajímá a podporuješ. Máš přístup k datům z WHOOP (regenerace, spánek, zátěž, tep) a k dnešnímu jídlu a kaloriím usera.

STYL — DODRŽUJ PŘESNĚ:
- vždy začínej malým písmenem
- NIKDY nekonči zprávu tečkou
- žádné emoji (jedině když si o ně user vysloveně řekne)
- krátce, pod 150 znaků
- max 1-2 krátké věty
- žádné generické AI fráze, nic formálního, nevysvětluj přehnaně
- slang v pohodě (bro, lol, btw, easy, v pohodě, cooked, mazec, brutál)
- žádné vykřičníky pokud fakt nejsi hyped

I tak buď fakt užitečný: propoj data a poraď na rovinu (nízká regenerace = odpočiň + dej si poriadne jídlo, přepálený kalorie = řekni mu to). Nediagnostikuj nemoci, u vážnejších věcí pošli k doktorovi.

=== CO SI MÁŠ PAMATOVAT O UŽIVATELI ===
${memBlock}

=== WHOOP DATA ===
${fmtWhoop(whoopSnapshot)}

=== JÍDLO A KALORIE (z aplikace) ===
${fmtFood(foodContext)}

=== SPRÁVA JÍDEL ===
Umíš uživateli spravovat jídelníček: PŘIDAT, SMAZAT nebo UPRAVIT jídlo. Dnešní datum je ${todayDate}. Aktuálně zobrazený den má datum ${viewDate}.
Když uživatel chce akci na JINÝ den (např. „na zítra", „včera", „v pondělí", „25.6."), nastav v akci pole "date" na konkrétní datum ve formátu YYYY-MM-DD (spočítej ho z dnešního data ${todayDate}). Když den neuvede, pole "date" vynech — použije se aktuálně zobrazený den.
Když uživatel JASNĚ chce změnu (např. „přidej proteinové kafe k snídani", „smaž oběd", „uprav rýži na 200 g", nebo pošle fotku jídla a chce ho zapsat), připoj NA ÚPLNÝ KONEC odpovědi přesně JEDEN blok akce:
[[ACTION]]{validní JSON na jednom řádku}[[/ACTION]]
Aplikace se uživatele VŽDY zeptá na potvrzení, takže akci jen NAVRHNI a krátce popiš, co uděláš. Nikdy neměň data jinak než tímto blokem.

Formáty (pole "date":"YYYY-MM-DD" je VOLITELNÉ u všech akcí — vynech ho pro aktuální den):
- Přidat: {"type":"add","date":"2026-06-25","category":"Snídaně|Dopolední svačina|Oběd|Odpolední svačina|Večeře|Druhá večeře","items":[{"name":"Proteinové kafe","amount":"250ml","calories":180,"protein":25,"carbs":8,"fat":5}]}
- Smazat konkrétní položky: {"type":"delete","ids":["<id z kontextu výše>"]}
- Smazat celou kategorii: {"type":"delete","date":"2026-06-25","category":"Oběd"}
- Upravit položku: {"type":"edit","id":"<id>","changes":{"amount":"200g","calories":260,"protein":20,"carbs":30,"fat":8}}

Pravidla:
- Pro smazání/úpravu používej "id" z kontextu jídel (pole [id:...]).
- Při přidání odhadni reálná makra (calories ≈ protein*4 + carbs*4 + fat*9). Pokud uživatel poslal fotku jídla a chce ji přidat, rozpoznej jídlo a navrhni "add".
- Když uživatel data měnit nechce (jen se ptá / radí), žádný blok akce NEPŘIDÁVEJ.
- Blok [[ACTION]] musí být validní JSON na jednom řádku a nic nesmí být za uzavírací značkou.`;

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
    // Current turn: text and/or an attached image.
    const userParts = [];
    if (message && message.trim()) {
      userParts.push({ text: message });
    } else if (image) {
      userParts.push({ text: '(uživatel poslal fotku jídla)' });
    }
    if (image) {
      const im = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(image);
      if (im) userParts.push({ inlineData: { mimeType: im[1], data: im[2] } });
    }
    contents.push({ role: 'user', parts: userParts });

    // Fallback chain for when the primary model is overloaded (503). Only
    // valid model names. Try each once, bounded by a deadline + per-call
    // timeout. A bad/unavailable fallback model is just skipped (we keep
    // trying), and the coach never surfaces a raw Google model error.
    const modelChain = [...new Set([COACH_MODEL, 'gemini-flash-latest', 'gemini-2.5-flash-lite'])];
    const deadline = Date.now() + 20000;

    let gResp = null;
    let succeeded = false;
    for (const model of modelChain) {
      const remaining = deadline - Date.now();
      if (remaining < 3000) break; // not enough time to try another model

      const genConfig = { temperature: 0.7, maxOutputTokens: 3072 };
      // Disable "thinking" on 2.5-family models (incl. the -latest alias) so the
      // whole token budget goes to the answer.
      if (/^gemini-2\.5/.test(model) || model === 'gemini-flash-latest') genConfig.thinkingConfig = { thinkingBudget: 0 };
      const payload = {
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents,
        generationConfig: genConfig
      };
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${COACH_API_KEY}`;

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Math.min(11000, remaining));
      try {
        gResp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: ctrl.signal
        });
      } catch (e) {
        clearTimeout(timer);
        console.error(`Gemini ${model} fetch failed:`, e.name === 'AbortError' ? 'timeout' : e.message);
        continue; // try next model
      }
      clearTimeout(timer);

      if (gResp.ok) { succeeded = true; break; }
      const status = gResp.status;
      const txt = await gResp.text().catch(() => '');
      console.error(`Gemini ${model}: ${status} ${txt.slice(0, 140)}`);
      // Any failure (overload OR an unavailable/bad model) → try the next one.
    }

    if (!gResp || !gResp.ok || !succeeded) {
      return res.status(503).json({
        error: 'AI je teď hodně vytížená 😕 Zkus to prosím za chvilku znovu.'
      });
    }

    const gData = await gResp.json();
    const cand = gData && gData.candidates && gData.candidates[0];
    // Join every text part (some responses split the answer across parts).
    let reply = null;
    if (cand && cand.content && Array.isArray(cand.content.parts)) {
      reply = cand.content.parts
        .map((p) => (p && p.text) ? p.text : '')
        .join('')
        .trim() || null;
    }

    if (!reply) {
      // Surface the model's stop reason so truncation/safety blocks are visible.
      console.error('Empty reply. finishReason:', cand && cand.finishReason, JSON.stringify(gData).slice(0, 500));
      return res.status(502).json({ error: 'AI nevrátila odpověď' });
    }

    // Extract an optional food-management action proposal from the reply.
    // Be robust: the model sometimes omits the closing [[/ACTION]] marker, so
    // pull the JSON object out by brace-matching and strip everything from the
    // [[ACTION]] marker onward (so raw JSON is never shown to the user).
    let action = null;
    const startIdx = reply.indexOf('[[ACTION]]');
    if (startIdx !== -1) {
      const after = reply.slice(startIdx + '[[ACTION]]'.length);
      const jsonStart = after.indexOf('{');
      if (jsonStart !== -1) {
        let depth = 0, end = -1, inStr = false, esc = false;
        for (let i = jsonStart; i < after.length; i++) {
          const c = after[i];
          if (esc) { esc = false; continue; }
          if (c === '\\') { esc = true; continue; }
          if (c === '"') { inStr = !inStr; continue; }
          if (inStr) continue;
          if (c === '{') depth++;
          else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end !== -1) {
          try {
            action = JSON.parse(after.slice(jsonStart, end + 1));
          } catch (e) {
            console.error('Bad ACTION JSON:', after.slice(jsonStart, end + 1).slice(0, 200));
            action = null;
          }
        }
      }
      reply = reply.slice(0, startIdx).trim();
      if (!reply) reply = action ? 'tak jo, koukni na to dole' : 'promiň, zkus to ještě jednou';
    }

    return res.status(200).json({
      success: true,
      reply,
      action,
      whoopConnected: !!whoopSnapshot
    });
  } catch (error) {
    console.error('Chat error:', error);
    return res.status(500).json({ error: 'Chyba serveru: ' + error.message });
  }
};
