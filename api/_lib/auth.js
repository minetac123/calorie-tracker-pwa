// Session helpers shared by the API endpoints.
// The app's session token is base64("username_timestamp_random").

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

module.exports = { extractUsername };
