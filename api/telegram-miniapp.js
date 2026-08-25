// Telegram Mini App backend: load and execute a pending food action.
// GET  ?chatId=<id> — return the pending action for the mini app to display
// POST {chatId, action} — execute the (possibly edited) action and notify user
const { kvGet, kvPut } = require('./_lib/store');
const { getPendingAction, clearPendingAction, findUserByChatId, sendMessage } = require('./_lib/telegram');

function getFoodCategory(item) {
  if (item.category) return item.category;
  if (item.time) {
    const hour = parseInt(item.time.split(':')[0]);
    if (!isNaN(hour)) {
      if (hour >= 5 && hour < 10) return 'Breakfast';
      if (hour >= 10 && hour < 12) return 'Morning snack';
      if (hour >= 12 && hour < 15) return 'Lunch';
      if (hour >= 15 && hour < 18) return 'Afternoon snack';
      if (hour >= 18 && hour < 22) return 'Dinner';
      return 'Second dinner';
    }
  }
  return 'Breakfast';
}

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
  return new Date().toISOString().split('T')[0];
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

function getTelegramChat(userData) {
  if (!Array.isArray(userData.coachChats)) userData.coachChats = [];
  let chat = userData.coachChats.find((c) => c.id === 'telegram');
  if (!chat) {
    chat = { id: 'telegram', title: 'Telegram', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
    userData.coachChats.unshift(chat);
  }
  return chat;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const chatId = req.method === 'GET'
    ? (req.query && req.query.chatId)
    : (req.body && req.body.chatId);

  if (!chatId) return res.status(400).json({ error: 'chatId required' });

  // Return the pending action for the mini app to display/edit
  if (req.method === 'GET') {
    const action = await getPendingAction(chatId);
    if (!action) return res.status(404).json({ error: 'No pending action' });
    return res.status(200).json({ action });
  }

  // Execute the (possibly edited) action
  if (req.method === 'POST') {
    const { action } = req.body || {};
    if (!action) return res.status(400).json({ error: 'action required' });

    const entry = await findUserByChatId(chatId);
    if (!entry) return res.status(404).json({ error: 'User not linked' });

    const userData = await kvGet(`data/${entry.username}.json`);
    if (!userData) {
      return res.status(404).json({ error: 'User data not found' });
    }

    const result = executeAction(userData, action);

    const chat = getTelegramChat(userData);
    chat.messages.push({ role: 'assistant', text: `done, ${result}`, ts: Date.now() });
    chat.updatedAt = Date.now();

    await Promise.all([
      kvPut(`data/${entry.username}.json`, userData),
      clearPendingAction(chatId)
    ]);

    await sendMessage(chatId, `done, ${result} — otevri appku a synchronizuj ze cloudu`);

    return res.status(200).json({ success: true, result });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
