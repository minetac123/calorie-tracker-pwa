// Telegram Bot API helpers and key-value storage for the Telegram integration.
const { kvGet, kvPut, kvDel } = require('./store');

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

// Registers the "/" command menu shown in Telegram's chat UI. Safe to call
// repeatedly — it just overwrites whatever was there before.
async function setMyCommands() {
  return tgPost('setMyCommands', {
    commands: [
      { command: 'dnes', description: 'Kolik jsi dneska snědl a kolik zbývá' },
      { command: 'vaha', description: 'Zapíše váhu, např. /vaha 82.4' },
      { command: 'pomoc', description: 'Co všechno umím' }
    ]
  });
}

// Downloads a Telegram-hosted file (a food photo or a voice note) and
// returns it as a Gemini-ready inline part, or null if anything about the
// fetch fails. `hintMime` is used when Telegram already told us the mime
// type (voice messages carry one); otherwise it's guessed from the
// extension in file_path, which is all we get for photos.
async function getFileAsInlinePart(fileId, hintMime) {
  try {
    const infoResp = await fetch(`${TG_API}/getFile?file_id=${encodeURIComponent(fileId)}`);
    const info = await infoResp.json().catch(() => ({}));
    const filePath = info && info.result && info.result.file_path;
    if (!filePath) return null;

    const fileResp = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`);
    if (!fileResp.ok) return null;
    const buf = Buffer.from(await fileResp.arrayBuffer());

    let mimeType = hintMime;
    if (!mimeType) {
      const ext = (filePath.split('.').pop() || 'jpg').toLowerCase();
      const byExt = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        oga: 'audio/ogg', ogg: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav' };
      mimeType = byExt[ext] || 'image/jpeg';
    }
    return { mimeType, data: buf.toString('base64') };
  } catch (e) {
    return null;
  }
}

// --- Telegram user index: [{username, chatId}] ---

const INDEX_PATH = 'telegram/index.json';

async function getTelegramIndex() {
  return (await kvGet(INDEX_PATH)) || [];
}

async function findUserByChatId(chatId) {
  const idx = await getTelegramIndex();
  return idx.find((e) => String(e.chatId) === String(chatId)) || null;
}

async function linkUser(username, chatId) {
  const idx = await getTelegramIndex();
  const filtered = idx.filter((e) => e.username !== username && String(e.chatId) !== String(chatId));
  filtered.push({ username, chatId: String(chatId) });
  await kvPut(INDEX_PATH, filtered);
}

async function unlinkUser(username) {
  const idx = await getTelegramIndex();
  await kvPut(INDEX_PATH, idx.filter((e) => e.username !== username));
}

// --- One-time link codes (6-digit): stored as {code: {username, expiry}} ---

const CODES_PATH = 'telegram/codes.json';

async function saveLinkCode(username, code) {
  const codes = (await kvGet(CODES_PATH)) || {};
  // Remove existing code for this user and expired codes
  const now = Date.now();
  Object.keys(codes).forEach((k) => {
    if (!codes[k] || codes[k].expiry < now || codes[k].username === username) delete codes[k];
  });
  codes[code] = { username, expiry: now + 15 * 60 * 1000 };
  await kvPut(CODES_PATH, codes);
}

async function consumeLinkCode(code) {
  const codes = (await kvGet(CODES_PATH)) || {};
  const entry = codes[code];
  if (!entry || entry.expiry < Date.now()) return null;
  delete codes[code];
  await kvPut(CODES_PATH, codes);
  return entry.username;
}

// --- Pending food actions awaiting Telegram confirmation ---

const PENDING_PATH = (chatId) => `telegram/pending/${chatId}.json`;

async function savePendingAction(chatId, action) {
  await kvPut(PENDING_PATH(chatId), action);
}

async function getPendingAction(chatId) {
  return kvGet(PENDING_PATH(chatId));
}

async function clearPendingAction(chatId) {
  await kvDel(PENDING_PATH(chatId));
}

module.exports = {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_BOT_USERNAME,
  tgPost,
  sendMessage,
  answerCallbackQuery,
  setWebhook,
  setMyCommands,
  getFileAsInlinePart,
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
