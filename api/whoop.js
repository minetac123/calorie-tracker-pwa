const { put, list } = require('@vercel/blob');

// WHOOP API configuration
const WHOOP_CLIENT_ID = process.env.WHOOP_CLIENT_ID || '';
const WHOOP_CLIENT_SECRET = process.env.WHOOP_CLIENT_SECRET || '';
const WHOOP_REDIRECT_URI = process.env.WHOOP_REDIRECT_URI || 'https://localhost:3000/whoop-callback';
const WHOOP_API_BASE = 'https://api.prod.whoop.com';

// Extract username from auth header
function extractUsername(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  try {
    const token = authHeader.split(' ')[1];
    const decoded = Buffer.from(token, 'base64').toString('utf-8');
    return decoded.split('_')[0];
  } catch (e) {
    return null;
  }
}

// Get WHOOP token from user blob storage
async function getWhoopToken(username) {
  try {
    const blobPath = `whoop/${username}.json`;
    const blobs = await list({ prefix: blobPath });
    if (!blobs.blobs || blobs.blobs.length === 0) {
      return null;
    }
    const resp = await fetch(blobs.blobs[0].url);
    const data = await resp.json();
    return data;
  } catch (e) {
    console.error('Error getting WHOOP token:', e);
    return null;
  }
}

// Save WHOOP token to user blob storage
async function saveWhoopToken(username, tokenData) {
  try {
    const blobPath = `whoop/${username}.json`;
    await put(blobPath, JSON.stringify(tokenData), {
      access: 'private',
      addRandomSuffix: false
    });
    return true;
  } catch (e) {
    console.error('Error saving WHOOP token:', e);
    return false;
  }
}

// Refresh WHOOP access token using refresh token
async function refreshWhoopToken(refreshToken) {
  try {
    const response = await fetch(`${WHOOP_API_BASE}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: WHOOP_CLIENT_ID,
        client_secret: WHOOP_CLIENT_SECRET
      })
    });

    if (!response.ok) {
      throw new Error(`WHOOP token refresh failed: ${response.statusText}`);
    }

    const data = await response.json();
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresAt: Date.now() + (data.expires_in * 1000)
    };
  } catch (e) {
    console.error('Error refreshing WHOOP token:', e);
    return null;
  }
}

// Fetch user profile from WHOOP
async function getWhoopProfile(accessToken) {
  try {
    const response = await fetch(`${WHOOP_API_BASE}/api/user/profile/v1/profile`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch WHOOP profile: ${response.statusText}`);
    }

    return await response.json();
  } catch (e) {
    console.error('Error fetching WHOOP profile:', e);
    return null;
  }
}

// Fetch WHOOP metrics for today
async function getWhoopMetrics(accessToken, userId) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const response = await fetch(
      `${WHOOP_API_BASE}/api/metric/heart_rate/v1/create?start=${today}T00:00:00Z&end=${today}T23:59:59Z&user_id=${userId}`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch WHOOP metrics: ${response.statusText}`);
    }

    return await response.json();
  } catch (e) {
    console.error('Error fetching WHOOP metrics:', e);
    return null;
  }
}

// Fetch WHOOP cycles (HRV, Strain, Recovery)
async function getWhoopCycles(accessToken, userId) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const response = await fetch(
      `${WHOOP_API_BASE}/api/activity/cycle/v1/create?start=${today}T00:00:00Z&end=${today}T23:59:59Z&user_id=${userId}`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch WHOOP cycles: ${response.statusText}`);
    }

    return await response.json();
  } catch (e) {
    console.error('Error fetching WHOOP cycles:', e);
    return null;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Extract username from auth header
  const username = extractUsername(req.headers.authorization);
  if (!username) {
    return res.status(401).json({ error: 'Nepřihlášen' });
  }

  try {
    // POST: Exchange WHOOP authorization code for access token
    if (req.method === 'POST' && req.body.code) {
      const { code } = req.body;

      const response = await fetch(`${WHOOP_API_BASE}/oauth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code: code,
          client_id: WHOOP_CLIENT_ID,
          client_secret: WHOOP_CLIENT_SECRET,
          redirect_uri: WHOOP_REDIRECT_URI
        })
      });

      if (!response.ok) {
        return res.status(400).json({ error: 'Selhala autentizace s WHOOP' });
      }

      const data = await response.json();
      const tokenData = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + (data.expires_in * 1000),
        userId: data.user_id
      };

      // Save token to blob storage
      await saveWhoopToken(username, tokenData);

      return res.status(200).json({
        success: true,
        message: 'WHOOP úspěšně připojena'
      });
    }

    // GET: Fetch WHOOP metrics and data
    if (req.method === 'GET') {
      let tokenData = await getWhoopToken(username);

      if (!tokenData) {
        return res.status(200).json({
          success: true,
          connected: false,
          authUrl: `${WHOOP_API_BASE}/oauth/authorize?client_id=${WHOOP_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(WHOOP_REDIRECT_URI)}`
        });
      }

      // Check if token expired and refresh if needed
      if (tokenData.expiresAt < Date.now()) {
        const refreshed = await refreshWhoopToken(tokenData.refreshToken);
        if (refreshed) {
          tokenData = { ...tokenData, ...refreshed };
          await saveWhoopToken(username, tokenData);
        } else {
          // Refresh failed, need to re-authenticate
          return res.status(200).json({
            success: true,
            connected: false,
            message: 'Platnost tokenu vypršela, prosím se znovu připojte',
            authUrl: `${WHOOP_API_BASE}/oauth/authorize?client_id=${WHOOP_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(WHOOP_REDIRECT_URI)}`
          });
        }
      }

      // Fetch WHOOP data
      const profile = await getWhoopProfile(tokenData.accessToken);
      const cycles = await getWhoopCycles(tokenData.accessToken, tokenData.userId);

      return res.status(200).json({
        success: true,
        connected: true,
        profile: profile,
        cycles: cycles,
        message: 'WHOOP data načtena'
      });
    }

    // DELETE: Disconnect WHOOP
    if (req.method === 'DELETE') {
      // For now, we'll just return success. In production, you might want to revoke the token with WHOOP.
      // Delete the token blob
      return res.status(200).json({
        success: true,
        message: 'WHOOP odpojena'
      });
    }

    return res.status(405).json({ error: 'Metoda není povolena' });

  } catch (error) {
    console.error('WHOOP error:', error);
    return res.status(500).json({ error: 'Chyba serveru: ' + error.message });
  }
};
