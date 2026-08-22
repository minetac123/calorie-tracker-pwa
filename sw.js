const CACHE_NAME = 'fitai-cache-v52';
const ASSETS = [
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.json',
  '/icon.svg'
];

// Helper to strip redirect metadata for iOS Safari PWA compatibility
function cleanResponse(response) {
  if (!response || !response.redirected) {
    return response;
  }
  
  // Rebuild the response object to clear the .redirected flag
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

// Install Service Worker and cache all assets
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      const cleanPromises = ASSETS.map((url) => {
        return fetch(url, {cache: 'no-cache'}).then((response) => {
          if (!response.ok) {
            throw new Error(`Failed to fetch ${url}`);
          }
          // Clean redirects before caching
          return cache.put(url, cleanResponse(response));
        });
      });
      return Promise.all(cleanPromises);
    }).then(() => self.skipWaiting())
  );
});

// Activate and clean up old caches
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// The app shell — always try the network first so code fixes land
// immediately when online, and fall back to cache only when offline.
const SHELL_PATHS = ['/', '/index.html', '/app.js', '/styles.css'];

// Fetch events
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Ignore Vercel Serverless API calls and Gemini API calls
  if (url.pathname.startsWith('/api/') || e.request.url.includes('generativelanguage.googleapis.com')) {
    return;
  }

  // Only handle GET requests (Cache API doesn't support POST, etc.)
  if (e.request.method !== 'GET') {
    return;
  }

  // Normalize root "/" to "/index.html" for cache lookups
  const isShell = url.origin === location.origin &&
    (e.request.mode === 'navigate' || SHELL_PATHS.includes(url.pathname));

  // Cache shell assets under their PATH ONLY. The page requests them with a
  // cache-busting query (/app.js?v=58, /styles.css?v=51), so keying on the full
  // URL would never match what install() pre-cached — and the offline fallback
  // would come up empty, leaving the app with no CSS or JS.
  const isRoot = url.origin === location.origin && url.pathname === '/';
  const cacheKey = isRoot
    ? new Request('/index.html')
    : (isShell && url.search ? new Request(url.origin + url.pathname) : e.request);

  if (isShell) {
    // NETWORK-FIRST: fetch fresh, update cache, fall back to cache offline.
    e.respondWith(
      fetch(e.request).then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const toCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(cacheKey, cleanResponse(toCache)));
        }
        return cleanResponse(response);
      }).catch(() => {
        return caches.match(cacheKey).then((res) => {
          if (res) return cleanResponse(res);
          if (e.request.mode === 'navigate') {
            return caches.match('/index.html').then(r => r ? cleanResponse(r) : Response.error());
          }
          return Response.error();
        });
      })
    );
    return;
  }

  // CACHE-FIRST for everything else (icons, manifest, etc.)
  e.respondWith(
    caches.match(cacheKey).then((cachedResponse) => {
      if (cachedResponse) {
        return cleanResponse(cachedResponse);
      }

      return fetch(e.request).then((response) => {
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }

        const responseToCache = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(e.request, cleanResponse(responseToCache));
        });

        return cleanResponse(response);
      }).catch(() => {
        if (e.request.mode === 'navigate') {
          return caches.match('/index.html').then(res => res ? cleanResponse(res) : Response.error());
        }
      });
    })
  );
});
