// AI coach with real Gemini function calling.
//
// Unlike /api/chat (which parses a [[ACTION]] text marker for food logging),
// this endpoint gives the model actual tools that mutate the user's profile,
// targets, workout plan and meal plan. The endpoint is stateless: the client
// sends its current plan state, the tools are applied to it here, and the
// mutated state comes back for the client to persist.
const { extractUsername, getValidToken, fetchWhoopSnapshot } = require('./_lib/whoop');
const { fmtWhoop, fmtFood } = require('./_lib/coach');
const {
  TOOL_DECLARATIONS, applyTool, emptyPlanState,
  fmtProfile, fmtTargets, fmtWorkoutPlan, fmtMealPlan,
  dayKeyForDate, DAY_CZ
} = require('./_lib/plans');

const COACH_API_KEY = process.env.COACH_API_KEY || process.env.GEMINI_API_KEY || '';
const COACH_MODEL = process.env.COACH_MODEL || 'gemini-2.5-flash';

const MAX_TOOL_ROUNDS = 5;

// Food-log tools. The food log lives in the client's appState, so these are
// NOT applied here — they come back as a proposal and the app shows the same
// confirm card it already uses for [[ACTION]] blocks. Keeping the human in the
// loop matters: the coach must never silently rewrite what someone ate.
const FOOD_CATEGORIES = ['Snídaně', 'Dopolední svačina', 'Oběd', 'Odpolední svačina', 'Večeře', 'Druhá večeře'];

const FOOD_TOOL_NAMES = new Set(['log_food', 'delete_food', 'edit_food']);

const FOOD_TOOLS = [
  {
    name: 'log_food',
    description: 'Zapiš snědené jídlo do deníku. Volej POUZE když uživatel použije rozkaz („zapiš", „přidej", „dej tam"). NIKDY když jen popisuje co jedl, ptá se na radu, nebo když mu ty sám něco doporučuješ.',
    parameters: {
      type: 'OBJECT',
      properties: {
        category: { type: 'STRING', enum: FOOD_CATEGORIES },
        date: { type: 'STRING', description: 'YYYY-MM-DD. Vynech pro aktuálně zobrazený den.' },
        items: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              name: { type: 'STRING' },
              amount: { type: 'STRING', description: 'např. "150g"' },
              calories: { type: 'NUMBER' },
              protein: { type: 'NUMBER' },
              carbs: { type: 'NUMBER' },
              fat: { type: 'NUMBER' }
            },
            required: ['name', 'amount', 'calories', 'protein', 'carbs', 'fat']
          }
        }
      },
      required: ['category', 'items']
    }
  },
  {
    name: 'delete_food',
    description: 'Smaž zapsané jídlo. Volej jen na výslovný rozkaz uživatele.',
    parameters: {
      type: 'OBJECT',
      properties: {
        ids: { type: 'ARRAY', items: { type: 'STRING' }, description: 'ID položek z kontextu dnešního jídla' },
        category: { type: 'STRING', enum: FOOD_CATEGORIES, description: 'Nebo smaž celou kategorii' },
        date: { type: 'STRING', description: 'YYYY-MM-DD' }
      }
    }
  },
  {
    name: 'edit_food',
    description: 'Uprav už zapsané jídlo (množství, makra, název). Volej jen na výslovný rozkaz uživatele.',
    parameters: {
      type: 'OBJECT',
      properties: {
        id: { type: 'STRING', description: 'ID položky z kontextu' },
        changes: {
          type: 'OBJECT',
          properties: {
            name: { type: 'STRING' },
            amount: { type: 'STRING' },
            calories: { type: 'NUMBER' },
            protein: { type: 'NUMBER' },
            carbs: { type: 'NUMBER' },
            fat: { type: 'NUMBER' }
          }
        }
      },
      required: ['id', 'changes']
    }
  }
];

// Translate a food tool call into the action shape the client already knows.
function foodActionFromCall(name, args) {
  const a = args || {};
  if (name === 'log_food') {
    return { type: 'add', category: a.category, date: a.date, items: a.items || [] };
  }
  if (name === 'delete_food') {
    return { type: 'delete', ids: a.ids, category: a.category, date: a.date };
  }
  if (name === 'edit_food') {
    return { type: 'edit', id: a.id, changes: a.changes || {} };
  }
  return null;
}

// Shared voice rules — identical to the food coach so the app has one persona.
const STYLE = `STYL — DODRŽUJ PŘESNĚ:
- vždy začínej malým písmenem
- NIKDY nekonči zprávu tečkou
- žádné emoji (jedině když si o ně user vysloveně řekne)
- piš JAK ČLOVĚK V CHATU: krátce, jedna myšlenka na zprávu
- když máš dvě krátký myšlenky, rozděl je na DVĚ zprávy oddělený řádkem se třema svislejma čárama: |||  (max 3 zprávy)
- žádné generické AI fráze, nic formálního, nevysvětluj přehnaně
- slang v pohodě (bro, btw, easy, v pohodě, mazec, brutál)
- žádné vykřičníky pokud fakt nejsi hyped`;

function onboardingPrompt(ctx) {
  return `Jsi AI kouč v appce FitAI a právě vedeš PRVNÍ konverzaci s novým uživatelem. Píšeš jako kámoš z gen z, ne jako dotazník.

${STYLE}

TVŮJ ÚKOL — ONBOARDING:
Postupně, v přirozené konverzaci, zjisti tyhle věci. PTÁŠ SE VŽDY JEN NA JEDNU VĚC NAJEDNOU a čekáš na odpověď. Nikdy nevysyp všechny otázky naráz — tohle je chat, ne formulář.
1. cíl — chce zpevnit (recomp), zhubnout (cut) nebo nabrat (bulk)
2. pohlaví, věk, výška, váha (klidně se zeptej na víc těchhle naráz, patří k sobě)
3. kolikrát týdně trénuje a jak dlouho jeden trénink trvá
4. dietní omezení (vegetarián, bez laktózy…)
5. co nemá rád / na co má alergii
6. jaké má vybavení — posilovna, domácí činky, nebo jen vlastní váha
7. jak dlouho už cvičí — začátečník / pokročilý / zkušený

PRAVIDLA:
- Po KAŽDÉ odpovědi uživatele hned zavolej save_profile s tím, co ses právě dozvěděl. Neschovávej si to na konec.
- Když uživatel odpoví na víc věcí naráz, ulož všechny.
- Když už máš všechno (save_profile ti vrátí readyForTargets:true), postupuj v TOMHLE pořadí:
  a) zavolej compute_targets — dostaneš spočítané kalorie a makra
  b) zavolej set_workout_plan — vygeneruj celý týdenní split podle jeho vybavení, zkušenosti a počtu tréninků. Netréninkové dny dej rest:true
  c) zavolej set_meal_plan — vygeneruj jídelníček na všech 7 dní. KAŽDÝ den musí makry vyjít zhruba na cíle z compute_targets (±5 %). Respektuj alergie a co nemá rád
  d) až potom napiš krátkou zprávu, co jsi mu připravil
- Tyhle tři nástroje můžeš zavolat i naráz v jedné odpovědi, klidně to udělej.
- U jídelníčku piš reálné české jídlo, ne fitness katalog. Gramáž musí sedět na makra.
- NIKDY si čísla kalorií nevymýšlej — vždycky použij compute_targets.

=== CO UŽ VÍŠ O UŽIVATELI ===
${fmtProfile(ctx.profile)}

=== SPOČÍTANÉ CÍLE ===
${fmtTargets(ctx.targets)}

Dnes je ${ctx.todayDate} (${DAY_CZ[ctx.todayKey]}).`;
}

function coachPrompt(ctx) {
  return `Jsi AI kouč v appce FitAI. Píšeš jako kámoš z gen z, ne jako oficiální asistent. Máš přístup k profilu uživatele, jeho tréninkovému plánu, jídelníčku, dnešním kaloriím a datům z WHOOP.

${STYLE}

I tak buď fakt užitečný: propoj data a poraď na rovinu. Nediagnostikuj nemoci, u vážnejších věcí pošli k doktorovi.

POSLOUCHEJ USERA — NEJDŮLEŽITĚJŠÍ:
- Vždycky reaguj na to, co user fakt napsal. Když se zeptá, odpověz na TO
- NEopakuj pořád dokola to samý (bílkoviny, cíle, váhu), když se ho to netýká
- Když tě jen pozdraví, pozdrav zpátky a zeptej se co je — žádná přednáška
- Když si jen kecá, kecej zpátky. Seš kámoš, ne motivační plakát

=== NÁSTROJE — MĚNÍŠ APPKU DOOPRAVDY ===
Máš nástroje, které SKUTEČNĚ mění data v appce. Když si uživatel řekne o změnu, NEPOPISUJ ji slovy — ZAVOLEJ nástroj. Příklady:
- „zapiš mi k obědu kuřecí prso 200g" → log_food (POZOR: jen na přímý rozkaz, viz níž)
- „dnes nemám čas na nohy, přehoď to na zítra" → swap_workout_days
- „nemám rád losos, dej mi něco jinýho" → replace_meal (nové jídlo s podobnými makry)
- „chci přidat víc bílkovin" → set_targets, a pak update_meal_plan_day / set_meal_plan aby to sedělo
- „byl jsem týden nemocnej, uprav mi plán" → set_workout_plan s lehčím rozjezdem
- „změň mi středu na push" → update_workout_day
- změna váhy / cíle → save_profile a potom compute_targets

PRAVIDLA PRO NÁSTROJE:
- Po zavolání nástroje dostaneš zpátky výsledek. Teprve pak napiš uživateli KONKRÉTNĚ co se změnilo (např. „nohy jsou teď ve středu, push se posunul na dnešek"), ne jen „jasně, mám to"
- Když si změnu nevyžádal a jen se ptá na radu, žádný nástroj nevolej — jen poraď
- Když měníš jídlo v plánu, drž makra blízko původním, ať sedí denní cíle
- Respektuj alergie a co nemá rád — nikdy je nenavrhuj

ZÁPIS SNĚDENÉHO JÍDLA (log_food / delete_food / edit_food) — PŘÍSNĚ:
Tyhle tři volej JEN když uživatel použije přímý rozkaz: „přidej", „zapiš", „dej tam", „smaž", „odstraň", „uprav", „změň".
NIKDY je nevolej když:
- ty sám navrhuješ, co by mohl sníst
- uživatel se jen ptá na radu ohledně stravy
- uživatel popisuje co jedl, ale neřekne „zapiš"
- uživatel říká že nestíhá cíle nebo se omlouvá
Při pochybnosti nevolej nic. Tyhle změny se uživateli ukážou k potvrzení, takže je jen navrhuješ — krátce popiš co jsi navrhl.
Mazání/úpravu navrhuj jen když jde o omyl nebo duplikát, NE aby si user vylepšil čísla.

=== PROFIL ===
${fmtProfile(ctx.profile)}

=== DENNÍ CÍLE ===
${fmtTargets(ctx.targets)}

=== TRÉNINKOVÝ PLÁN ===
${fmtWorkoutPlan(ctx.workoutPlan, ctx.todayKey)}

=== JÍDELNÍČEK ===
${fmtMealPlan(ctx.mealPlan, ctx.todayKey)}

=== DNEŠNÍ PROGRESS (co fakt snědl) ===
${fmtFood(ctx.foodContext)}

=== DNEŠNÍ TRÉNINK ===
${ctx.workoutStatus}

=== WHOOP ===
${fmtWhoop(ctx.whoopSnapshot)}

=== PAMĚŤ ===
${ctx.memBlock}

Dnes je ${ctx.todayDate} (${DAY_CZ[ctx.todayKey]}), čas ${ctx.nowTime || 'neznámý'}.`;
}

// One Gemini call. Returns the parsed candidate or null.
async function callGemini(model, payload, timeoutMs) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${COACH_API_KEY}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      console.error(`Gemini ${model}: ${resp.status} ${txt.slice(0, 200)}`);
      return null;
    }
    return await resp.json();
  } catch (e) {
    console.error(`Gemini ${model} failed:`, e.name === 'AbortError' ? 'timeout' : e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metoda není povolena' });

  const username = extractUsername(req.headers.authorization);
  if (!username) return res.status(401).json({ error: 'Nepřihlášen' });
  if (!COACH_API_KEY) {
    return res.status(500).json({ error: 'AI Kouč není nakonfigurován (chybí COACH_API_KEY / GEMINI_API_KEY).' });
  }

  try {
    const {
      message, history, mode, image,
      profile, targets, workoutPlan, mealPlan,
      foodContext, workoutStatus, memories, today, nowTime
    } = req.body || {};

    if ((!message || !message.trim()) && !image) {
      return res.status(400).json({ error: 'Prázdná zpráva' });
    }

    const isOnboarding = mode === 'onboarding';
    const todayDate = (today && /^\d{4}-\d{2}-\d{2}$/.test(today)) ? today : null;
    const todayKey = dayKeyForDate(todayDate);

    // Plan state the tools operate on. Starts from whatever the client has.
    const state = Object.assign(emptyPlanState(), {
      profile: profile || {},
      targets: targets || null,
      workoutPlan: workoutPlan || null,
      mealPlan: mealPlan || null
    });

    // WHOOP is only worth fetching for the ongoing coach, not mid-onboarding.
    let whoopSnapshot = null;
    if (!isOnboarding) {
      const token = await getValidToken(username);
      if (token && !token._expired) {
        whoopSnapshot = await fetchWhoopSnapshot(token.accessToken);
      }
    }

    const memBlock = (Array.isArray(memories) && memories.length)
      ? memories.map((m) => `- ${String(m).trim()}`).join('\n')
      : 'Žádná uložená fakta.';

    const ctx = {
      profile: state.profile, targets: state.targets,
      workoutPlan: state.workoutPlan, mealPlan: state.mealPlan,
      foodContext, whoopSnapshot, memBlock, todayDate: todayDate || 'dnes', todayKey,
      nowTime: (typeof nowTime === 'string' && /^\d{1,2}:\d{2}$/.test(nowTime)) ? nowTime : null,
      workoutStatus: workoutStatus || 'Dnešní trénink zatím nezačal.'
    };

    const systemInstruction = isOnboarding ? onboardingPrompt(ctx) : coachPrompt(ctx);

    // Build the conversation.
    const contents = [];
    if (Array.isArray(history)) {
      history.slice(-16).forEach((m) => {
        if (!m || !m.text) return;
        contents.push({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.text }]
        });
      });
    }
    const userParts = [];
    if (message && message.trim()) {
      userParts.push({ text: message });
    } else {
      userParts.push({ text: '(uživatel poslal fotku jídla)' });
    }
    if (image) {
      const im = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(image);
      if (im) userParts.push({ inlineData: { mimeType: im[1], data: im[2] } });
    }
    contents.push({ role: 'user', parts: userParts });

    // Onboarding has no food log to touch yet — only offer the plan tools.
    const activeTools = isOnboarding
      ? TOOL_DECLARATIONS
      : TOOL_DECLARATIONS.concat(FOOD_TOOLS);

    const basePayload = {
      systemInstruction: { parts: [{ text: systemInstruction }] },
      tools: [{ functionDeclarations: activeTools }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 8192,
        thinkingConfig: { thinkingBudget: 0 }
      }
    };

    // ---- Tool loop: model calls tools, we apply them and feed results back ----
    const deadline = Date.now() + 55000;
    const appliedTools = [];
    let reply = null;
    let planChanged = false;
    let foodAction = null;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const remaining = deadline - Date.now();
      if (remaining < 4000) break;

      const gData = await callGemini(
        COACH_MODEL,
        Object.assign({}, basePayload, { contents }),
        Math.min(24000, remaining)
      );
      if (!gData) break;

      const cand = gData.candidates && gData.candidates[0];
      const parts = (cand && cand.content && Array.isArray(cand.content.parts)) ? cand.content.parts : [];

      const text = parts.map((p) => (p && p.text) ? p.text : '').join('').trim();
      const calls = parts.filter((p) => p && p.functionCall).map((p) => p.functionCall);

      if (!calls.length) {
        if (text) reply = text;
        break;
      }

      // Apply every requested tool and collect responses for the next turn.
      const responseParts = [];
      calls.forEach((fc) => {
        let result;
        if (FOOD_TOOL_NAMES.has(fc.name)) {
          // Food edits need the user's OK, so they are proposed, not applied.
          // Only the first proposal per turn survives — one card at a time.
          const proposed = foodActionFromCall(fc.name, fc.args);
          if (proposed && !foodAction) {
            foodAction = proposed;
            result = { ok: true, pending: true, note: 'Návrh byl poslán uživateli k potvrzení. Krátce mu popiš, co jsi navrhl — nepiš, že je to hotové.' };
          } else {
            result = { ok: false, error: 'Najednou lze navrhnout jen jednu změnu jídelního deníku.' };
          }
        } else {
          try {
            result = applyTool(fc.name, fc.args, state);
          } catch (e) {
            console.error(`Tool ${fc.name} threw:`, e.message);
            result = { ok: false, error: 'Nástroj selhal: ' + e.message };
          }
          if (result && result.ok) planChanged = true;
        }
        if (result && result.ok) appliedTools.push({ name: fc.name, result });
        responseParts.push({
          functionResponse: { name: fc.name, response: { result } }
        });
      });

      // Echo the model's own turn back, then hand it the tool results.
      contents.push({ role: 'model', parts: parts.filter((p) => p.functionCall || p.text) });
      contents.push({ role: 'user', parts: responseParts });

      // Keep any text the model produced alongside the calls as a fallback.
      if (text && !reply) reply = text;
    }

    if (!reply) {
      reply = appliedTools.length
        ? 'hotovo, mrkni na plán'
        : 'sorry, jsem teď dost cooked, zkus to za chvíli';
    }

    return res.status(200).json({
      success: true,
      reply,
      planChanged,
      action: foodAction,
      appliedTools: appliedTools.map((t) => t.name),
      profile: state.profile,
      targets: state.targets,
      workoutPlan: state.workoutPlan,
      mealPlan: state.mealPlan,
      whoopConnected: !!whoopSnapshot
    });
  } catch (error) {
    console.error('Coach error:', error);
    return res.status(500).json({ error: 'Chyba serveru: ' + error.message });
  }
};
