// Shared WHOOP API helpers (v2).
// Files/folders prefixed with "_" are ignored by Vercel's filesystem router,
// so this module is importable by the real /api endpoints without becoming one.
const { put, list, del } = require('@vercel/blob');

const WHOOP_CLIENT_ID = process.env.WHOOP_CLIENT_ID || '';
const WHOOP_CLIENT_SECRET = process.env.WHOOP_CLIENT_SECRET || '';
const WHOOP_REDIRECT_URI = process.env.WHOOP_REDIRECT_URI || '';

const WHOOP_AUTH_URL = 'https://api.prod.whoop.com/oauth/oauth2/auth';
const WHOOP_TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const WHOOP_API_BASE = 'https://api.prod.whoop.com/developer/v2';

// Scopes the app requests. offline is required to receive a refresh token.
const WHOOP_SCOPES = [
  'offline',
  'read:profile',
  'read:recovery',
  'read:cycles',
  'read:sleep',
  'read:workout',
  'read:body_measurement'
].join(' ');

// Pull the username out of the app's base64 session token ("username_ts_random").
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

// Build the WHOOP consent URL. `state` is echoed back to the callback.
function buildAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: WHOOP_CLIENT_ID,
    response_type: 'code',
    redirect_uri: WHOOP_REDIRECT_URI,
    scope: WHOOP_SCOPES,
    state: state || Math.random().toString(36).slice(2)
  });
  return `${WHOOP_AUTH_URL}?${params.toString()}`;
}

const tokenBlobPath = (username) => `whoop/${username}.json`;

async function getStoredToken(username) {
  try {
    const blobs = await list({ prefix: tokenBlobPath(username) });
    if (!blobs.blobs || blobs.blobs.length === 0) return null;
    const resp = await fetch(blobs.blobs[0].url);
    return await resp.json();
  } catch (e) {
    console.error('getStoredToken error:', e);
    return null;
  }
}

async function saveStoredToken(username, tokenData) {
  await put(tokenBlobPath(username), JSON.stringify(tokenData), {
    access: 'public',
    addRandomSuffix: false
  });
}

async function deleteStoredToken(username) {
  try {
    const blobs = await list({ prefix: tokenBlobPath(username) });
    if (blobs.blobs && blobs.blobs.length > 0) {
      await del(blobs.blobs.map((b) => b.url));
    }
  } catch (e) {
    console.error('deleteStoredToken error:', e);
  }
}

// Exchange an authorization code for access + refresh tokens.
async function exchangeCodeForToken(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: WHOOP_CLIENT_ID,
    client_secret: WHOOP_CLIENT_SECRET,
    redirect_uri: WHOOP_REDIRECT_URI
  });
  const resp = await fetch(WHOOP_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`WHOOP token exchange failed (${resp.status}): ${txt}`);
  }
  const data = await resp.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in * 1000)
  };
}

// Use a refresh token to get a fresh access token.
async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: WHOOP_CLIENT_ID,
    client_secret: WHOOP_CLIENT_SECRET,
    scope: WHOOP_SCOPES
  });
  const resp = await fetch(WHOOP_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt: Date.now() + (data.expires_in * 1000)
  };
}

// Return a valid (auto-refreshed) token object, persisting any refresh.
async function getValidToken(username) {
  let token = await getStoredToken(username);
  if (!token) return null;
  // Refresh slightly early (60s skew) to avoid mid-request expiry.
  if (!token.expiresAt || token.expiresAt < Date.now() + 60000) {
    const refreshed = await refreshAccessToken(token.refreshToken);
    if (!refreshed) return { ...token, _expired: true };
    token = { ...token, ...refreshed };
    await saveStoredToken(username, token);
  }
  return token;
}

// GET a WHOOP API path with the bearer token. Returns parsed JSON or null.
async function whoopGet(accessToken, path) {
  try {
    const resp = await fetch(`${WHOOP_API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!resp.ok) {
      console.error(`WHOOP GET ${path} -> ${resp.status}`);
      return null;
    }
    return await resp.json();
  } catch (e) {
    console.error(`WHOOP GET ${path} error:`, e);
    return null;
  }
}

// Fetch a concise snapshot of the user's latest WHOOP data.
async function fetchWhoopSnapshot(accessToken) {
  const [profile, recovery, cycles, sleep] = await Promise.all([
    whoopGet(accessToken, '/user/profile/basic'),
    whoopGet(accessToken, '/recovery?limit=1'),
    whoopGet(accessToken, '/cycle?limit=1'),
    whoopGet(accessToken, '/activity/sleep?limit=1')
  ]);

  const recoveryRec = recovery && recovery.records && recovery.records[0];
  const cycleRec = cycles && cycles.records && cycles.records[0];
  const sleepRec = sleep && sleep.records && sleep.records[0];

  const recScore = recoveryRec && recoveryRec.score ? recoveryRec.score : null;
  const cycScore = cycleRec && cycleRec.score ? cycleRec.score : null;
  const slpScore = sleepRec && sleepRec.score ? sleepRec.score : null;

  // Day strain energy expenditure converted kJ -> kcal (1 kcal = 4.184 kJ).
  let activeKcal = null;
  if (cycScore && typeof cycScore.kilojoule === 'number') {
    activeKcal = Math.round(cycScore.kilojoule / 4.184);
  }

  return {
    profile: profile
      ? { firstName: profile.first_name, lastName: profile.last_name }
      : null,
    recovery: recScore
      ? {
          recoveryScore: recScore.recovery_score,
          restingHeartRate: recScore.resting_heart_rate,
          hrvMs: recScore.hrv_rmssd_milli != null
            ? Math.round(recScore.hrv_rmssd_milli * 10) / 10
            : null,
          spo2: recScore.spo2_percentage,
          skinTempC: recScore.skin_temp_celsius
        }
      : null,
    strain: cycScore
      ? {
          strain: cycScore.strain != null
            ? Math.round(cycScore.strain * 10) / 10
            : null,
          averageHeartRate: cycScore.average_heart_rate,
          maxHeartRate: cycScore.max_heart_rate,
          activeKcal
        }
      : null,
    sleep: slpScore && slpScore.stage_summary
      ? {
          performancePercentage: slpScore.sleep_performance_percentage,
          totalInBedMs: slpScore.stage_summary.total_in_bed_time_milli,
          totalAwakeMs: slpScore.stage_summary.total_awake_time_milli,
          respiratoryRate: slpScore.respiratory_rate
        }
      : null
  };
}

module.exports = {
  WHOOP_CLIENT_ID,
  WHOOP_CLIENT_SECRET,
  WHOOP_REDIRECT_URI,
  WHOOP_SCOPES,
  extractUsername,
  buildAuthUrl,
  getStoredToken,
  saveStoredToken,
  deleteStoredToken,
  exchangeCodeForToken,
  refreshAccessToken,
  getValidToken,
  whoopGet,
  fetchWhoopSnapshot
};
