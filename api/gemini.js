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
    // Fall back to less-loaded models when the primary 503s ("high demand").
    // Only valid model names — try each once, bounded by a deadline + per-call
    // timeout. Errors from FALLBACK models are never surfaced to the user; we
    // only ever forward a success, or the PRIMARY model's own error.
    // gemini-flash-latest actually processes (just needs time) when 2.5-flash
    // is overloaded, so try it right after the primary and give each call a
    // generous timeout (function maxDuration is 30s).
    const modelChain = [...new Set([GEMINI_MODEL, 'gemini-flash-latest', 'gemini-2.5-flash-lite', 'gemini-flash-lite-latest'])];
    const deadline = Date.now() + 27000;

    let okResp = null;
    let primaryResp = null;
    for (let i = 0; i < modelChain.length; i++) {
      const remaining = deadline - Date.now();
      if (remaining < 3000) break;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelChain[i]}:generateContent?key=${GEMINI_API_KEY}`;
      const ctrl = new AbortController();
      // Give the primary model a long window (it tends to queue under load);
      // fallbacks 503 instantly so they don't need much.
      const callTimeout = i === 0 ? Math.min(18000, remaining) : Math.min(9000, remaining);
      const timer = setTimeout(() => ctrl.abort(), callTimeout);
      let resp = null;
      try {
        resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: ctrl.signal
        });
      } catch (e) {
        clearTimeout(timer);
        console.error(`Gemini ${modelChain[i]} fetch failed:`, e.name === 'AbortError' ? 'timeout' : e.message);
        continue;
      }
      clearTimeout(timer);
      if (resp.ok) { okResp = resp; break; }

      const transient = resp.status === 429 || resp.status === 500 || resp.status === 503;
      if (i === 0) {
        primaryResp = resp; // remember the primary's real error
        if (!transient) break; // real error about the request → forward it
      } else {
        console.error(`Gemini fallback ${modelChain[i]}: ${resp.status}`);
      }
      // transient (or fallback error) → try the next model
    }

    if (okResp) {
      const data = await okResp.json().catch(() => ({}));
      return res.status(okResp.status).json(data);
    }
    // No success. If the primary failed with a real (non-overload) error,
    // forward it; otherwise show a clean overload message.
    if (primaryResp && !(primaryResp.status === 429 || primaryResp.status === 500 || primaryResp.status === 503)) {
      const data = await primaryResp.json().catch(() => ({}));
      return res.status(primaryResp.status).json(data);
    }
    return res.status(503).json({ error: { message: 'AI je teď vytížená, zkus to prosím za chvíli znovu.' } });
  } catch (error) {
    console.error('Gemini proxy error:', error);
    return res.status(502).json({ error: { message: 'AI služba nedostupná: ' + error.message } });
  }
};
