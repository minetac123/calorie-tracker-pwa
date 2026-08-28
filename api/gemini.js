// Gemini proxy for the food-analysis flow. Keeps the API key server-side
// (set GEMINI_API_KEY or COACH_API_KEY in Vercel) so it never ships in the
// client bundle. The client builds the full generateContent payload and posts
// it here; we just attach the key and forward to Google, returning Google's
// response.
//
// Accepts either variable, same as every other endpoint. Running the whole app
// off a single key is the normal case; requiring GEMINI_API_KEY specifically
// here meant setting only COACH_API_KEY silently broke photo analysis while
// everything else kept working.
const { extractUsername } = require('./_lib/auth');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.COACH_API_KEY || '';
const GEMINI_MODEL = 'gemini-2.5-flash';

// Models the client may explicitly ask for via `__model`. Kept as an allowlist
// so the proxy can never be pointed at an arbitrary (or costlier) model.
// The image model is "nano banana" — used to render what to add/remove from a
// plate. It has no fallbacks: no other model here can return an image.
const MODEL_ALLOWLIST = {
  'gemini-2.5-flash-image': { chain: ['gemini-2.5-flash-image'], image: true }
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Metoda není povolena' } });
  }

  // Require a logged-in session so the proxy can't be used anonymously.
  const username = await extractUsername(req.headers.authorization);
  if (!username) {
    return res.status(401).json({ error: { message: 'Nepřihlášen' } });
  }

  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: { message: 'AI není nakonfigurováno (chybí GEMINI_API_KEY / COACH_API_KEY).' } });
  }

  const payload = req.body;
  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: { message: 'Chybí data požadavku' } });
  }

  // Optional explicit model (allowlisted). Stripped before forwarding so it
  // never reaches Google as an unknown field.
  const requested = payload.__model;
  delete payload.__model;
  const override = requested ? MODEL_ALLOWLIST[requested] : null;
  if (requested && !override) {
    return res.status(400).json({ error: { message: 'Nepodporovaný model' } });
  }

  // Disable "thinking" for the food-analysis call. It's a structured extraction
  // task, so thinking just adds latency (and with an image often pushes the
  // call past the timeout under load → every model 503s → "AI vytížená").
  // Keeps this path fast and reliable, same as the coach in api/chat.js.
  // The image model rejects thinkingConfig outright, so skip it there.
  if (!override || !override.image) {
    if (!payload.generationConfig || typeof payload.generationConfig !== 'object') {
      payload.generationConfig = {};
    }
    if (payload.generationConfig.thinkingConfig == null) {
      payload.generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }
  }

  try {
    // Fall back to less-loaded models when the primary 503s ("high demand").
    // Only valid model names — try each once, bounded by a deadline + per-call
    // timeout. Errors from FALLBACK models are never surfaced to the user; we
    // only ever forward a success, or the PRIMARY model's own error.
    // gemini-flash-latest actually processes (just needs time) when 2.5-flash
    // is overloaded, so try it right after the primary and give each call a
    // generous timeout (function maxDuration is 30s).
    const modelChain = override
      ? override.chain
      : [...new Set([GEMINI_MODEL, 'gemini-flash-latest', 'gemini-2.5-flash-lite', 'gemini-flash-lite-latest'])];
    // Image generation is slower than extraction, so give it the whole budget.
    const deadline = Date.now() + (override && override.image ? 50000 : 27000);

    let okResp = null;
    let primaryResp = null;
    for (let i = 0; i < modelChain.length; i++) {
      const remaining = deadline - Date.now();
      if (remaining < 3000) break;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelChain[i]}:generateContent?key=${GEMINI_API_KEY}`;
      const ctrl = new AbortController();
      // Give the primary model a long window (it tends to queue under load);
      // fallbacks 503 instantly so they don't need much.
      const callTimeout = (override && override.image)
        ? Math.min(48000, remaining)
        : (i === 0 ? Math.min(18000, remaining) : Math.min(9000, remaining));
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
