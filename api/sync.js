const { put, list } = require('@vercel/blob');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Extract username from token (base64 encoded: "username_timestamp_random")
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Nepřihlášen' });
  }

  let username;
  try {
    const token = authHeader.split(' ')[1];
    const decoded = Buffer.from(token, 'base64').toString('utf-8');
    username = decoded.split('_')[0];
  } catch (e) {
    return res.status(401).json({ error: 'Neplatný token' });
  }

  if (!username) {
    return res.status(401).json({ error: 'Neplatný token' });
  }

  const blobPath = `data/${username}.json`;

  try {
    // SAVE data to cloud
    if (req.method === 'POST') {
      const appData = req.body;

      if (!appData) {
        return res.status(400).json({ error: 'Žádná data k uložení' });
      }

      await put(blobPath, JSON.stringify(appData), {
        access: 'public',
        addRandomSuffix: false,
        cacheControlMaxAge: 0
      });

      return res.status(200).json({ success: true, message: 'Data uložena' });
    }

    // LOAD data from cloud
    if (req.method === 'GET') {
      const blobs = await list({ prefix: blobPath });

      if (!blobs.blobs || blobs.blobs.length === 0) {
        return res.status(200).json({ success: true, appData: null });
      }

      // Bust the CDN cache so a load right after a save returns fresh data.
      const base = blobs.blobs[0].url;
      const fresh = base + (base.includes('?') ? '&' : '?') + '_=' + Date.now();
      const dataResp = await fetch(fresh, { cache: 'no-store' });
      const appData = await dataResp.json();

      return res.status(200).json({ success: true, appData: appData });
    }

    return res.status(405).json({ error: 'Metoda není povolena' });

  } catch (error) {
    console.error('Sync error:', error);
    return res.status(500).json({ error: 'Chyba serveru: ' + error.message });
  }
};
