const { kvGet, kvPut } = require('./_lib/store');
const { extractUsername } = require('./_lib/auth');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const username = extractUsername(req.headers.authorization);
  if (!username) {
    return res.status(401).json({ error: 'Nepřihlášen' });
  }

  const blobPath = `data/${username}.json`;

  try {
    // SAVE data to cloud
    if (req.method === 'POST') {
      const appData = req.body;

      if (!appData) {
        return res.status(400).json({ error: 'Žádná data k uložení' });
      }

      await kvPut(blobPath, appData);

      return res.status(200).json({ success: true, message: 'Data uložena' });
    }

    // LOAD data from cloud
    if (req.method === 'GET') {
      const appData = await kvGet(blobPath);
      return res.status(200).json({ success: true, appData: appData || null });
    }

    return res.status(405).json({ error: 'Metoda není povolena' });

  } catch (error) {
    console.error('Sync error:', error);
    return res.status(500).json({ error: 'Chyba serveru: ' + error.message });
  }
};
