// Gemini proxy for the food-analysis flow. Keeps the API key server-side
// (set GEMINI_API_KEY in Vercel) so it never ships in the client bundle.
// The client builds the full generateContent payload and posts it here; we
// just attach the key and forward to Google, returning Google's response.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-2.5-flash';

function extractUsername(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  try {
    const token = authHeader.split(' ')[1];
    const decoded = Buffer.from(token, 'base64').toString('utf-8');
    return decoded.split('_')[0] || null;
  } catch (e) {
    return null;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Metoda není povolena' } });
  }

  // Require a logged-in session so the proxy can't be used anonymously.
  const username = extractUsername(req.headers.authorization);
  if (!username) {
    return res.status(401).json({ error: { message: 'Nepřihlášen' } });
  }

  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: { message: 'AI není nakonfigurováno (chybí GEMINI_API_KEY).' } });
  }

  const payload = req.body;
  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: { message: 'Chybí data požadavku' } });
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const gResp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    // Forward Google's status + body verbatim so the client parses as before.
    const data = await gResp.json().catch(() => ({}));
    return res.status(gResp.status).json(data);
  } catch (error) {
    console.error('Gemini proxy error:', error);
    return res.status(502).json({ error: { message: 'AI služba nedostupná: ' + error.message } });
  }
};
