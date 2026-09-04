// Single source of truth for the app's version.
//
// APP_VERSION is load-bearing beyond the Telegram coach's "/verze": the iOS
// workflow reads it into MARKETING_VERSION (= CFBundleShortVersionString) and
// tags the GitHub Release with it, and the in-app update checker compares the
// two. Bumping it is what makes an installed iOS app offer an update — and if
// it drifts from the release tag, the app either nags forever or never.
//
// Three other places show a version to a human and are kept in sync by hand
// (scripts/check-version-sync.js fails the build if they drift): the
// "Verze: X (Cache vN)" line in index.html and CACHE_NAME in sw.js.
const APP_VERSION = '3.0.1';
const CACHE_VERSION = 'v82';

module.exports = { APP_VERSION, CACHE_VERSION };
