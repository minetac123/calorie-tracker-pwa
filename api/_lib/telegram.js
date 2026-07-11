// Telegram Bot API helpers and Vercel Blob storage for the Telegram integration.
const { blobGet, blobPut, blobDel } = require('./blob');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || '';
const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

async function tgPost(method, body) {
  const resp = await fetch(`${TG_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return resp.json().catch(() => ({}));
}

async function sendMessage(chatId, text, extra = {}) {
  return tgPost('sendMessage', { chat_id: chatId, text: String(text || '').slice(0, 4096), ...extra });
}

async function answerCallbackQuery(callbackQueryId, text = '') {
  return tgPost('answerCallbackQuery', { callback_query_id: callbackQueryId, text });
}

async function setWebhook(url) {
  return tgPost('setWebhook', { url, allowed_updates: ['message', 'callback_query'] });
}

// --- Telegram user index: [{username, chatId}] ---

const INDEX_PATH = 'telegram/index.json';

async function getTelegramIndex() {
  return (await blobGet(INDEX_PATH)) || [];
}

async function findUserByChatId(chatId) {
  const idx = await getTelegramIndex();
  return idx.find((e) => String(e.chatId) === String(chatId)) || null;
}

async function linkUser(username, chatId) {
  const idx = await getTelegramIndex();
  const filtered = idx.filter((e) => e.username !== username && String(e.chatId) !== String(chatId));
  filtered.push({ username, chatId: String(chatId) });
  await blobPut(INDEX_PATH, filtered);
}

async function unlinkUser(username) {
  const idx = await getTelegramIndex();
  await blobPut(INDEX_PATH, idx.filter((e) => e.username !== username));
}

// --- One-time link codes (6-digit): stored as {code: {username, expiry}} ---

const CODES_PATH = 'telegram/codes.json';

async function saveLinkCode(username, code) {
  const codes = (await blobGet(CODES_PATH)) || {};
  // Remove existing code for this user and expired codes
  const now = Date.now();
  Object.keys(codes).forEach((k) => {
    if (!codes[k] || codes[k].expiry < now || codes[k].username === username) delete codes[k];
  });
  codes[code] = { username, expiry: now + 15 * 60 * 1000 };
  await blobPut(CODES_PATH, codes);
}

async function consumeLinkCode(code) {
  const codes = (await blobGet(CODES_PATH)) || {};
  const entry = codes[code];
  if (!entry || entry.expiry < Date.now()) return null;
  delete codes[code];
  await blobPut(CODES_PATH, codes);
  return entry.username;
}

// --- Pending food actions awaiting Telegram confirmation ---

const PENDING_PATH = (chatId) => `telegram/pending/${chatId}.json`;

async function savePendingAction(chatId, action) {
  await blobPut(PENDING_PATH(chatId), action);
}

async function getPendingAction(chatId) {
  return blobGet(PENDING_PATH(chatId));
}

async function clearPendingAction(chatId) {
  await blobDel(PENDING_PATH(chatId));
}

module.exports = {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_BOT_USERNAME,
  tgPost,
  sendMessage,
  answerCallbackQuery,
  setWebhook,
  getTelegramIndex,
  findUserByChatId,
  linkUser,
  unlinkUser,
  saveLinkCode,
  consumeLinkCode,
  savePendingAction,
  getPendingAction,
  clearPendingAction
};
