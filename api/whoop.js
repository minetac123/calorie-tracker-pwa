// WHOOP connection endpoint: OAuth code exchange, status + data, disconnect.
const {
  WHOOP_CLIENT_ID,
  extractUsername,
  buildAuthUrl,
  saveStoredToken,
  deleteStoredToken,
  exchangeCodeForToken,
  getValidToken,
  fetchWhoopSnapshot
} = require('./_lib/whoop');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const username = extractUsername(req.headers.authorization);
  if (!username) {
    return res.status(401).json({ error: 'Nepřihlášen' });
  }

  if (!WHOOP_CLIENT_ID) {
    return res.status(500).json({ error: 'WHOOP není nakonfigurován (chybí WHOOP_CLIENT_ID).' });
  }

  try {
    // POST: exchange the authorization code coming back from WHOOP.
    if (req.method === 'POST' && req.body && req.body.code) {
      const tokenData = await exchangeCodeForToken(req.body.code);
      await saveStoredToken(username, tokenData);
      return res.status(200).json({ success: true, message: 'WHOOP úspěšně připojena' });
    }

    // DELETE: forget the stored token (disconnect).
    if (req.method === 'DELETE') {
      await deleteStoredToken(username);
      return res.status(200).json({ success: true, message: 'WHOOP odpojena' });
    }

    // GET: connection status + a snapshot of the latest metrics.
    if (req.method === 'GET') {
      const token = await getValidToken(username);

      if (!token || token._expired) {
        return res.status(200).json({
          success: true,
          connected: false,
          authUrl: buildAuthUrl(username)
        });
      }

      const snapshot = await fetchWhoopSnapshot(token.accessToken);
      return res.status(200).json({ success: true, connected: true, data: snapshot });
    }

    return res.status(405).json({ error: 'Metoda není povolena' });
  } catch (error) {
    console.error('WHOOP error:', error);
    return res.status(500).json({ error: 'Chyba serveru: ' + error.message });
  }
};
