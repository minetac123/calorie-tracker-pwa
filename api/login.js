const { blobGet } = require('./_lib/blob');
const crypto = require('crypto');

function hashPassword(password) {
  return crypto.createHash('sha256').update(password + '_fitai_salt_2026').digest('hex');
}

function generateToken(username) {
  const payload = username + '_' + Date.now() + '_' + Math.random().toString(36).substr(2);
  return Buffer.from(payload).toString('base64');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Metoda není povolena' });
  }

  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Vyplň uživatelské jméno a heslo' });
    }

    const safeUsername = username.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const blobPath = `users/${safeUsername}.json`;

    // Find user blob
    const userData = await blobGet(blobPath);
    if (!userData) {
      return res.status(401).json({ error: 'Uživatel neexistuje' });
    }

    // Verify password
    const hashedPassword = hashPassword(password);
    if (userData.password !== hashedPassword) {
      return res.status(401).json({ error: 'Špatné heslo' });
    }

    // Generate new token
    const newToken = generateToken(safeUsername);

    // Try to load user's saved app data
    const appData = await blobGet(`data/${safeUsername}.json`);

    return res.status(200).json({
      success: true,
      username: safeUsername,
      token: newToken,
      appData: appData
    });

  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ error: 'Chyba serveru: ' + error.message });
  }
};
