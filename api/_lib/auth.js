// Session helpers shared by the API endpoints.
// The app's session token is base64("username_timestamp_random").

function extractUsername(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  try {
    const token = authHeader.split(' ')[1];
    const decoded = Buffer.from(token, 'base64').toString('utf-8');
    // Format is "username_timestamp_random". A bare split('_')[0] truncated
    // any username that itself contains an underscore (register.js explicitly
    // allows them) at the first one, silently authenticating as the wrong
    // person. Timestamp and random are always the last two segments, so
    // dropping exactly those two reconstructs the real username instead.
    const parts = decoded.split('_');
    if (parts.length < 3) return null;
    return parts.slice(0, -2).join('_') || null;
  } catch (e) {
    return null;
  }
}

module.exports = { extractUsername };
