// Single source of truth for "what version are you" questions from the
// Telegram coach. There's no build step that derives these automatically,
// so they're kept in sync by hand with the two other places a human sees
// a version number: the "Verze: X (Cache vN)" line in index.html, and
// CACHE_NAME in sw.js. Bump all three together on a release that should
// be visibly a new version.
const APP_VERSION = '2.39.1';
const CACHE_VERSION = 'v72';

module.exports = { APP_VERSION, CACHE_VERSION };
