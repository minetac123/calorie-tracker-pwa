const { list } = require('@vercel/blob');

async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + '_fitai_salt_2026');
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
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
    const blobs = await list({ prefix: blobPath });
    if (!blobs.blobs || blobs.blobs.length === 0) {
      return res.status(401).json({ error: 'Uživatel neexistuje' });
    }

    // Fetch user data from blob URL
    const userBlobUrl = blobs.blobs[0].url;
    const userResp = await fetch(userBlobUrl);
    const userData = await userResp.json();

    // Verify password
    const hashedPassword = await hashPassword(password);
    if (userData.password !== hashedPassword) {
      return res.status(401).json({ error: 'Špatné heslo' });
    }

    // Generate new token
    const newToken = generateToken(safeUsername);

    // Try to load user's saved app data
    let appData = null;
    const dataBlobs = await list({ prefix: `data/${safeUsername}.json` });
    if (dataBlobs.blobs && dataBlobs.blobs.length > 0) {
      const dataResp = await fetch(dataBlobs.blobs[0].url);
      appData = await dataResp.json();
    }

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
