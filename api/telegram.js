// Telegram webhook: receives updates and runs them through the same AI coach
// as the in-app chat. Telegram messages appear as a dedicated "Telegram" chat
// in the in-app coach chat list after the next cloud sync.
const { kvGet, kvPut } = require('./_lib/store');
const { buildSystemInstruction } = require('./_lib/coach');
const { APP_VERSION, CACHE_VERSION } = require('./_lib/version');
const {
  tgPost,
  sendMessage,
  answerCallbackQuery,
  findUserByChatId,
  linkUser,
  consumeLinkCode,
  savePendingAction,
  getPendingAction,
  clearPendingAction,
  getFileAsInlinePart
} = require('./_lib/telegram');

const COACH_API_KEY = process.env.COACH_API_KEY || process.env.GEMINI_API_KEY || '';
const COACH_MODEL = process.env.COACH_MODEL || 'gemini-2.5-flash';

// Stable production URL for the Telegram Mini App. Vercel sets
// VERCEL_PROJECT_PRODUCTION_URL (no scheme) on its own; APP_DOMAIN is the
// escape hatch for anyone hosting this somewhere else. Without either, the
// "Upravit" button on the confirmation card is simply left out rather than
// pointed at somebody else's deployment.
const APP_DOMAIN = process.env.APP_DOMAIN || process.env.VERCEL_PROJECT_PRODUCTION_URL || '';

// ---- Food context helpers (mirrors app.js client-side logic) ----

const CATEGORY_NAMES = {
  'Breakfast': 'Snídaně',
  'Morning snack': 'Dopolední svačina',
  'Lunch': 'Oběd',
  'Afternoon snack': 'Odpolední svačina',
  'Dinner': 'Večeře',
  'Second dinner': 'Druhá večeře'
};

function getFoodCategory(item) {
  if (item.category) return item.category;
  if (item.time) {
    const hour = parseInt(item.time.split(':')[0]);
    if (!isNaN(hour)) {
      if (hour >= 5 && hour < 10) return 'Breakfast';
      if (hour >= 10 && hour < 11) return 'Morning snack';
      if (hour >= 11 && hour < 15) return 'Lunch';
      if (hour >= 15 && hour < 18) return 'Afternoon snack';
      if (hour >= 18 && hour < 22) return 'Dinner';
      return 'Second dinner';
    }
  }
  return 'Breakfast';
}

function getTodayStr() {
  // Use Czech local date so the key matches what the app stores food under
  // (the app keys logs by the user's local date, not UTC).
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
  } catch (e) {
    return new Date().toISOString().split('T')[0];
  }
}

// Current wall-clock time in Czech timezone (server runs in UTC).
function getNowTimeStr() {
  try {
    return new Intl.DateTimeFormat('cs-CZ', {
      timeZone: 'Europe/Prague', hour: '2-digit', minute: '2-digit', hour12: false
    }).format(new Date());
  } catch (e) {
    const n = new Date();
    return `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`;
  }
}

function buildFoodContext(userData) {
  const today = getTodayStr();
  const logs = (userData && userData.logs && userData.logs[today]) || [];
  const goals = (userData && userData.goals) || { calories: 2000, protein: 130, carbs: 220, fat: 65 };

  const items = logs.map((i) => ({
    id: i.id,
    name: i.name,
    amount: i.amount,
    category: CATEGORY_NAMES[getFoodCategory(i)] || getFoodCategory(i),
    calories: i.calories,
    protein: i.protein,
    carbs: i.carbs,
    fat: i.fat
  }));

  const totals = items.reduce((s, i) => ({
    calories: s.calories + Number(i.calories || 0),
    protein: s.protein + Number(i.protein || 0),
    carbs: s.carbs + Number(i.carbs || 0),
    fat: s.fat + Number(i.fat || 0)
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 });

  totals.calories = Math.round(totals.calories);
  totals.protein = Math.round(totals.protein * 10) / 10;
  totals.carbs = Math.round(totals.carbs * 10) / 10;
  totals.fat = Math.round(totals.fat * 10) / 10;

  // Mirrors buildFoodContext in app.js: recent days so "to samé co včera"
  // resolves against real entries instead of being guessed.
  const allLogs = (userData && userData.logs) || {};
  const recentDays = [];
  const base = new Date(today + 'T12:00:00Z');
  for (let back = 1; back <= 7; back++) {
    const d = new Date(base.getTime() - back * 86400000).toISOString().slice(0, 10);
    const dayItems = allLogs[d] || [];
    if (!dayItems.length) continue;
    recentDays.push({
      date: d,
      items: dayItems.map((i) => ({
        id: i.id,
        name: i.name,
        amount: i.amount,
        category: CATEGORY_NAMES[getFoodCategory(i)] || getFoodCategory(i),
        calories: i.calories,
        protein: i.protein,
        carbs: i.carbs,
        fat: i.fat
      }))
    });
  }

  return { date: today, goals, totals, items, recentDays, weight: userData && userData.weight };
}

// ---- User data Blob helpers ----

async function loadUserData(username) {
  return kvGet(`data/${username}.json`);
}

async function saveUserData(username, data) {
  await kvPut(`data/${username}.json`, data);
}

// Returns (or creates) the dedicated "Telegram" entry in coachChats.
function getTelegramChat(userData) {
  if (!Array.isArray(userData.coachChats)) userData.coachChats = [];
  let chat = userData.coachChats.find((c) => c.id === 'telegram');
  if (!chat) {
    chat = {
      id: 'telegram',
      title: 'Telegram',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: []
    };
    userData.coachChats.unshift(chat);
  }
  return chat;
}

// ---- Gemini call (mirrors api/chat.js logic, text-only) ----

async function callCoach(message, history, foodContext, memories, mediaPart) {
  const today = getTodayStr();
  const memBlock = (Array.isArray(memories) && memories.length)
    ? memories.map((m) => `- ${String(m).trim()}`).join('\n')
    : 'Žádná uložená fakta.';

  const systemInstruction = buildSystemInstruction({
    memBlock, foodContext, todayDate: today, viewDate: today, nowTime: getNowTimeStr(), coachModel: COACH_MODEL
  });

  const contents = [];
  if (Array.isArray(history)) {
    history.slice(-12).forEach((m) => {
      if (!m || !m.text) return;
      contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] });
    });
  }
  const userParts = [{ text: message }];
  if (mediaPart) userParts.push({ inlineData: mediaPart });
  contents.push({ role: 'user', parts: userParts });

  const modelChain = [...new Set([COACH_MODEL, 'gemini-flash-latest', 'gemini-2.5-flash-lite'])];
  const deadline = Date.now() + 20000;

  let gResp = null;
  let succeeded = false;
  for (const model of modelChain) {
    const remaining = deadline - Date.now();
    if (remaining < 3000) break;

    const genConfig = { temperature: 0.7, maxOutputTokens: 1024 };
    if (/^gemini-2\.5/.test(model) || model === 'gemini-flash-latest') {
      genConfig.thinkingConfig = { thinkingBudget: 0 };
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(11000, remaining));
    try {
      gResp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${COACH_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ systemInstruction: { parts: [{ text: systemInstruction }] }, contents, generationConfig: genConfig }),
          signal: ctrl.signal
        }
      );
    } catch (e) {
      clearTimeout(timer);
      console.error(`Gemini ${model}:`, e.name === 'AbortError' ? 'timeout' : e.message);
      continue;
    }
    clearTimeout(timer);
    if (gResp.ok) { succeeded = true; break; }
    const txt = await gResp.text().catch(() => '');
    console.error(`Gemini ${model}: ${gResp.status} ${txt.slice(0, 140)}`);
  }

  if (!succeeded || !gResp || !gResp.ok) return null;

  const gData = await gResp.json();
  const cand = gData && gData.candidates && gData.candidates[0];
  if (!cand || !cand.content || !Array.isArray(cand.content.parts)) return null;
  return cand.content.parts.map((p) => (p && p.text) ? p.text : '').join('').trim() || null;
}

// Split the coach reply into separate short chat bubbles on the ||| delimiter,
// like a human firing off a couple of quick texts. Caps at 3 to avoid spam.
function splitBubbles(text) {
  return String(text || '')
    .split(/\s*\|\|\|\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 3);
}

async function sendBubbles(chatId, text) {
  const parts = splitBubbles(text);
  if (parts.length === 0) { await sendMessage(chatId, text); return; }
  for (let i = 0; i < parts.length; i++) {
    await sendMessage(chatId, parts[i]);
    if (i < parts.length - 1) await new Promise((r) => setTimeout(r, 600));
  }
}

// ---- [[ACTION]] block parser (mirrors api/chat.js logic) ----

function parseAction(reply) {
  const startIdx = reply.indexOf('[[ACTION]]');
  if (startIdx === -1) return { text: reply, action: null };

  const after = reply.slice(startIdx + '[[ACTION]]'.length);
  const jsonStart = after.indexOf('{');
  let action = null;

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
      try { action = JSON.parse(after.slice(jsonStart, end + 1)); } catch (e) { action = null; }
    }
  }

  const text = reply.slice(0, startIdx).trim() || (action ? 'tak jo, koukni na to níže' : 'promiň, zkus to znovu');
  return { text, action };
}

// ---- Food action executor (mirrors app.js executeCoachAction) ----

function normName(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function czCatToId(cz) {
  const n = normName(cz);
  const map = {
    'snidane': 'Breakfast', 'breakfast': 'Breakfast',
    'dopoledni svacina': 'Morning snack', 'morning snack': 'Morning snack',
    'obed': 'Lunch', 'lunch': 'Lunch',
    'odpoledni svacina': 'Afternoon snack', 'afternoon snack': 'Afternoon snack',
    'vecere': 'Dinner', 'dinner': 'Dinner',
    'druha vecere': 'Second dinner', 'second dinner': 'Second dinner'
  };
  return map[n] || 'Breakfast';
}

function resolveDate(action) {
  const raw = String((action && action.date) || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return getTodayStr();
}

function executeAction(userData, action) {
  if (!action || !action.type) return 'nic se nestalo';
  if (!userData.logs) userData.logs = {};

  if (action.type === 'add') {
    const date = resolveDate(action);
    if (!userData.logs[date]) userData.logs[date] = [];
    const catId = czCatToId(action.category);
    const now = new Date();
    const t = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    let n = 0;
    (action.items || []).forEach((it) => {
      if (!it || !it.name) return;
      userData.logs[date].push({
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        time: t,
        name: it.name,
        amount: it.amount || '100g',
        calories: Math.round(Number(it.calories) || 0),
        protein: Math.round((Number(it.protein) || 0) * 10) / 10,
        carbs: Math.round((Number(it.carbs) || 0) * 10) / 10,
        fat: Math.round((Number(it.fat) || 0) * 10) / 10,
        category: catId
      });
      n++;
    });
    return `přidáno ${n} ${n === 1 ? 'jídlo' : 'jídel'}`;
  }

  if (action.type === 'delete') {
    let removed = 0;
    if (Array.isArray(action.ids) && action.ids.length) {
      const ids = new Set(action.ids);
      Object.keys(userData.logs).forEach((d) => {
        const before = userData.logs[d].length;
        userData.logs[d] = userData.logs[d].filter((i) => !ids.has(i.id));
        removed += before - userData.logs[d].length;
      });
    } else if (action.category) {
      const catId = czCatToId(action.category);
      const date = resolveDate(action);
      const before = (userData.logs[date] || []).length;
      userData.logs[date] = (userData.logs[date] || []).filter((i) => getFoodCategory(i) !== catId);
      removed = before - (userData.logs[date] || []).length;
    }
    return `smazáno ${removed} položek`;
  }

  if (action.type === 'edit') {
    for (const d of Object.keys(userData.logs || {})) {
      const it = (userData.logs[d] || []).find((x) => x.id === action.id);
      if (it) {
        const ch = action.changes || {};
        if (ch.name != null) it.name = ch.name;
        if (ch.amount != null) it.amount = ch.amount;
        if (ch.calories != null) it.calories = Math.round(Number(ch.calories) || 0);
        if (ch.protein != null) it.protein = Math.round((Number(ch.protein) || 0) * 10) / 10;
        if (ch.carbs != null) it.carbs = Math.round((Number(ch.carbs) || 0) * 10) / 10;
        if (ch.fat != null) it.fat = Math.round((Number(ch.fat) || 0) * 10) / 10;
        delete it.original; delete it.leftovers;
        return 'upraveno';
      }
    }
    return 'položka nenalezena';
  }

  return 'neznámá akce';
}

function describeAction(action) {
  if (!action) return '';
  if (action.type === 'add') {
    const items = (action.items || []).map((i) => `${i.name} (${i.calories} kcal)`).join(', ');
    return `Pridat: ${items}`;
  }
  if (action.type === 'delete') {
    if (Array.isArray(action.ids)) return `Smazat ${action.ids.length} pol.`;
    return `Smazat kategorii: ${action.category || '?'}`;
  }
  if (action.type === 'edit') {
    const ch = Object.entries(action.changes || {}).map(([k, v]) => `${k}=${v}`).join(', ');
    return `Upravit: ${ch}`;
  }
  return 'Zmena jidelnicku';
}

// ---- Main webhook handler ----

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const update = req.body;
  if (!update) return res.status(200).end();

  // ---- Callback query (inline button press: Confirm / Cancel) ----
  if (update.callback_query) {
    const cq = update.callback_query;
    await answerCallbackQuery(cq.id);
    const chatId = String(cq.message.chat.id);

    if (cq.data === 'tg_confirm') {
      const entry = await findUserByChatId(chatId);
      if (!entry) {
        await sendMessage(chatId, 'nejsi propojený s FitAI appkou');
        return res.status(200).end();
      }
      const action = await getPendingAction(chatId);
      if (!action) {
        await sendMessage(chatId, 'akce vypršela nebo nebyla nalezena');
        return res.status(200).end();
      }
      const userData = await loadUserData(entry.username);
      if (!userData) {
        await sendMessage(chatId, 'chyba při načítání dat');
        return res.status(200).end();
      }
      const result = executeAction(userData, action);
      const chat = getTelegramChat(userData);
      chat.messages.push({ role: 'assistant', text: `done, ${result}`, ts: Date.now() });
      chat.updatedAt = Date.now();
      await Promise.all([saveUserData(entry.username, userData), clearPendingAction(chatId)]);
      // Remove inline buttons from the original message
      tgPost('editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      await sendMessage(chatId, `done, ${result} — otevri appku a synchronizuj ze cloudu`);
    } else if (cq.data === 'tg_cancel') {
      await clearPendingAction(chatId);
      tgPost('editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      await sendMessage(chatId, 'ok, nechavam to bejt');
    }
    return res.status(200).end();
  }

  // ---- Regular message ----
  const msg = update.message;
  const hasPhoto = Array.isArray(msg && msg.photo) && msg.photo.length > 0;
  const hasVoice = !!(msg && msg.voice && msg.voice.file_id);
  if (!msg || (!msg.text && !hasPhoto && !hasVoice)) return res.status(200).end();

  const chatId = String(msg.chat.id);
  const text = (msg.text || msg.caption || '').trim();

  // /start <code> — link this Telegram chat to a FitAI account
  if (text === '/start' || text.startsWith('/start ')) {
    const code = text.slice('/start'.length).trim();
    if (code) {
      const username = await consumeLinkCode(code);
      if (username) {
        await linkUser(username, chatId);
        await sendMessage(chatId, `propojeno s uctem ${username} — ted mi pis cokoliv a jsem tvuj kouc`);
        return res.status(200).end();
      }
    }
    await sendMessage(chatId, 'cau! jsem FitAI kouc — propoj me pres odkaz v nastaveni appky');
    return res.status(200).end();
  }

  // All other messages require a linked account
  const entry = await findUserByChatId(chatId);
  if (!entry) {
    await sendMessage(chatId, 'nejsi propojeny s FitAI appkou — jdi do nastaveni a klikni "Pripojit Telegram"');
    return res.status(200).end();
  }

  const { username } = entry;
  const userData = await loadUserData(username);
  if (!userData) {
    await sendMessage(chatId, 'chyba pri nacitani dat — otevri appku a synchronizuj ze cloudu');
    return res.status(200).end();
  }

  const foodContext = buildFoodContext(userData);

  // ---- Deterministic commands: no AI round trip, so they're instant and
  // never hallucinate a number. Still logged into the Telegram chat tab so
  // the in-app history reads naturally. ----

  if (text === '/pomoc' || text === '/help') {
    const reply = 'umim tohle:\n/dnes — kolik jsi dneska snedl a kolik zbyva\n/vaha 82.4 — zapise vahu\n/verze — jaka verze appky a kouce bezi\n\njinak mi proste pis, posli fotku jidla nebo mi to naklikej hlasovkou, zapisu ti to sam';
    const tgChat = getTelegramChat(userData);
    tgChat.messages.push({ role: 'user', text, ts: Date.now() });
    tgChat.messages.push({ role: 'assistant', text: reply, ts: Date.now() });
    tgChat.updatedAt = Date.now();
    await saveUserData(username, userData);
    await sendMessage(chatId, reply);
    return res.status(200).end();
  }

  if (text === '/verze' || text === '/version') {
    const reply = `appka: FitAI ${APP_VERSION} (cache ${CACHE_VERSION})\nja: kouč na ${COACH_MODEL}`;
    const tgChat = getTelegramChat(userData);
    tgChat.messages.push({ role: 'user', text, ts: Date.now() });
    tgChat.messages.push({ role: 'assistant', text: reply, ts: Date.now() });
    tgChat.updatedAt = Date.now();
    await saveUserData(username, userData);
    await sendMessage(chatId, reply);
    return res.status(200).end();
  }

  if (text === '/dnes' || text === '/today') {
    const t = foodContext.totals;
    const g = foodContext.goals || {};
    const left = Math.round((Number(g.calories) || 0) - t.calories);
    const reply = `dnes: ${t.calories}/${Number(g.calories) || '?'} kcal (zbyva ${left})\nB ${t.protein}/${Number(g.protein) || '?'} g · S ${t.carbs}/${Number(g.carbs) || '?'} g · T ${t.fat}/${Number(g.fat) || '?'} g`;
    const tgChat = getTelegramChat(userData);
    tgChat.messages.push({ role: 'user', text, ts: Date.now() });
    tgChat.messages.push({ role: 'assistant', text: reply, ts: Date.now() });
    tgChat.updatedAt = Date.now();
    await saveUserData(username, userData);
    await sendMessage(chatId, reply);
    return res.status(200).end();
  }

  if (/^\/vaha\b/i.test(text)) {
    const m = /^\/vaha\s+(\d{1,3}(?:[.,]\d{1,2})?)\s*$/i.exec(text);
    const w = m ? parseFloat(m[1].replace(',', '.')) : NaN;
    const tgChat = getTelegramChat(userData);
    tgChat.messages.push({ role: 'user', text, ts: Date.now() });
    let reply;
    if (!Number.isFinite(w) || w <= 0 || w > 400) {
      reply = 'napis to jako /vaha 82.4';
    } else {
      const today = getTodayStr();
      if (!Array.isArray(userData.weightLogs)) userData.weightLogs = [];
      userData.weightLogs = userData.weightLogs.filter((l) => l.date !== today);
      userData.weightLogs.push({ date: today, weight: w });
      userData.weightLogs.sort((a, b) => b.date.localeCompare(a.date));
      userData.weight = w;
      reply = `zapsano: ${w} kg`;
    }
    tgChat.messages.push({ role: 'assistant', text: reply, ts: Date.now() });
    tgChat.updatedAt = Date.now();
    await saveUserData(username, userData);
    await sendMessage(chatId, reply);
    return res.status(200).end();
  }

  // ---- Everything else goes to the AI coach ----

  let mediaPart = null;
  if (hasPhoto) {
    const best = msg.photo[msg.photo.length - 1]; // Telegram lists sizes smallest-first
    mediaPart = await getFileAsInlinePart(best.file_id);
  } else if (hasVoice) {
    mediaPart = await getFileAsInlinePart(msg.voice.file_id, msg.voice.mime_type);
  }
  const effectiveText = text || (hasPhoto ? '(uživatel poslal fotku jídla)' : hasVoice ? '(uživatel poslal hlasovku)' : '');

  const tgChat = getTelegramChat(userData);
  tgChat.messages.push({ role: 'user', text: effectiveText, ts: Date.now() });
  tgChat.updatedAt = Date.now();

  const memories = Array.isArray(userData.coachMemories)
    ? userData.coachMemories.map((m) => m.text || String(m)).filter(Boolean)
    : [];

  const rawReply = await callCoach(effectiveText, tgChat.messages.slice(0, -1).slice(-20), foodContext, memories, mediaPart);

  if (!rawReply) {
    await sendMessage(chatId, 'AI je ted vytizena, zkus to za chvili');
    return res.status(200).end();
  }

  const { text: replyText, action } = parseAction(rawReply);

  // Store with the ||| split markers normalized to newlines so the app reads it fine.
  tgChat.messages.push({ role: 'assistant', text: replyText.replace(/\s*\|\|\|\s*/g, '\n'), ts: Date.now() });
  tgChat.updatedAt = Date.now();

  await saveUserData(username, userData);

  if (action) {
    await savePendingAction(chatId, action);
    const desc = describeAction(action);
    // For add/edit actions offer an "Edit in mini app" button; delete just needs confirm/cancel.
    // Needs a known domain to point the mini app at — without one the button is
    // dropped and confirm/cancel still work.
    const canEdit = (action.type === 'add' || action.type === 'edit') && !!APP_DOMAIN;
    const buttons = canEdit
      ? [[
          { text: 'Jo', callback_data: 'tg_confirm' },
          { text: 'Upravit', web_app: { url: `https://${APP_DOMAIN}/telegram-miniapp.html?chatId=${chatId}` } },
          { text: 'Ne', callback_data: 'tg_cancel' }
        ]]
      : [[
          { text: 'Jo', callback_data: 'tg_confirm' },
          { text: 'Ne', callback_data: 'tg_cancel' }
        ]];
    // Send the chatty part as separate bubbles, then the action card with buttons.
    const bubbles = splitBubbles(replyText);
    const lead = bubbles.slice(0, -1);
    const last = bubbles.length ? bubbles[bubbles.length - 1] : replyText;
    for (const b of lead) { await sendMessage(chatId, b); await new Promise((r) => setTimeout(r, 600)); }
    await sendMessage(chatId, `${last}\n\n${desc}`, {
      reply_markup: {
        inline_keyboard: buttons
      }
    });
  } else {
    await sendBubbles(chatId, replyText);
  }

  return res.status(200).end();
};
