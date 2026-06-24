// Endpoints to link/unlink a FitAI account with a Telegram chat.
// POST  — generate a 6-digit code the user sends to the bot (/start <code>)
// GET   — check whether the current user is connected
// DELETE — disconnect
const { extractUsername } = require('./_lib/whoop');
const {
  TELEGRAM_BOT_USERNAME,
  setWebhook,
  getTelegramIndex,
  unlinkUser,
  saveLinkCode
} = require('./_lib/telegram');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const username = extractUsername(req.headers.authorization);
  if (!username) return res.status(401).json({ error: 'Nepřihlášen' });

  // Generate a new link code and (idempotently) register the webhook.
  if (req.method === 'POST') {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    await saveLinkCode(username, code);

    // Ensure the webhook is registered (safe to call repeatedly).
    const webhookUrl = `${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : ''}/api/telegram`;
    if (webhookUrl && webhookUrl.startsWith('https://')) {
      setWebhook(webhookUrl).catch((e) => console.error('setWebhook error:', e));
    }

    return res.status(200).json({ code, botUsername: TELEGRAM_BOT_USERNAME });
  }

  // Return connection status.
  if (req.method === 'GET') {
    const idx = await getTelegramIndex();
    const connected = idx.some((e) => e.username === username);
    return res.status(200).json({ connected });
  }

  // Remove connection.
  if (req.method === 'DELETE') {
    await unlinkUser(username);
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: 'Metoda není povolena' });
};
