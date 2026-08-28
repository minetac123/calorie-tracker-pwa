// Telegram Bot API helpers and key-value storage for the Telegram integration.
const crypto = require('crypto');
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
      { command: 'verze', description: 'Jaká verze appky a kouče běží' },
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

// --- Ověření Telegram Mini App initData ---
//
// Mini app dřív posílala chatId jako parametr v URL a backend mu prostě věřil.
// Chat ID je ale jen číslo — kdo si tipne cizí, přečte a přepíše cizí data.
//
// Telegram proto každé mini appce předává `initData` podepsaná botím tokenem.
// Podpis umí ověřit jen ten, kdo token zná, takže z něj jde chatId bezpečně
// odvodit. Postup je z oficiální dokumentace Telegramu.
function verifyInitData(initData) {
  if (!TELEGRAM_BOT_TOKEN || !initData) return null;

  try {
    const params = new URLSearchParams(String(initData));
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    // Všechny ostatní dvojice seřazené podle klíče, spojené novým řádkem.
    const dataCheckString = Array.from(params.entries())
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData')
      .update(TELEGRAM_BOT_TOKEN).digest();
    const computed = crypto.createHmac('sha256', secretKey)
      .update(dataCheckString).digest('hex');

    const a = Buffer.from(computed, 'hex');
    const b = Buffer.from(hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    // Stará initData se nepočítají — kdyby někomu unikla z historie prohlížeče,
    // ať aspoň nejde použít napořád.
    const authDate = Number(params.get('auth_date'));
    if (!Number.isFinite(authDate)) return null;
    if (Date.now() / 1000 - authDate > 24 * 60 * 60) return null;

    const user = JSON.parse(params.get('user') || 'null');
    if (!user || !user.id) return null;

    // U soukromého chatu s botem je chat ID rovno ID uživatele.
    return { chatId: String(user.id), user };
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
  verifyInitData,
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
