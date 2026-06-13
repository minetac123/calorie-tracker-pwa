const { put, list } = require('@vercel/blob');
const crypto = require('crypto');

// Simple SHA-256 hash
function hashPassword(password) {
  return crypto.createHash('sha256').update(password + '_fitai_salt_2026').digest('hex');
}

// Generate session token
function generateToken(username) {
  const payload = username + '_' + Date.now() + '_' + Math.random().toString(36).substr(2);
  return Buffer.from(payload).toString('base64');
}

module.exports = async function handler(req, res) {
  // CORS
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

    if (username.length < 3 || username.length > 30) {
      return res.status(400).json({ error: 'Jméno musí mít 3–30 znaků' });
    }

    if (password.length < 4) {
      return res.status(400).json({ error: 'Heslo musí mít alespoň 4 znaky' });
    }

    const safeUsername = username.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const blobPath = `users/${safeUsername}.json`;

    // Check if user already exists
    const existing = await list({ prefix: blobPath });
    if (existing.blobs && existing.blobs.length > 0) {
      return res.status(409).json({ error: 'Uživatel už existuje' });
    }

    const hashedPassword = hashPassword(password);
    const token = generateToken(safeUsername);

    const userData = {
      username: safeUsername,
      password: hashedPassword,
      token: token,
      createdAt: new Date().toISOString()
    };

    await put(blobPath, JSON.stringify(userData), {
      access: 'private',
      addRandomSuffix: false
    });

    return res.status(200).json({
      success: true,
      username: safeUsername,
      token: token
    });

  } catch (error) {
    console.error('Register error:', error);
    return res.status(500).json({ error: 'Chyba serveru: ' + error.message });
  }
};
