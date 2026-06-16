const CACHE_NAME = 'fitai-cache-v31';
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

  let requestToMatch = e.request;
  
  // If requesting root "/", serve "/index.html" from the cache
  if (url.origin === location.origin && url.pathname === '/') {
    requestToMatch = new Request('/index.html');
  }

  e.respondWith(
    caches.match(requestToMatch).then((cachedResponse) => {
      if (cachedResponse) {
        // Return cleaned response for Safari
        return cleanResponse(cachedResponse);
      }
      
      return fetch(e.request).then((response) => {
        // Check if we received a valid response
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }

        // Clone response to cache it without locking the return stream
        const responseToCache = response.clone();
        
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(e.request, cleanResponse(responseToCache));
        });

        // MUST clean response before returning to Safari to avoid PWA crash
        return cleanResponse(response);
      }).catch(() => {
        if (e.request.mode === 'navigate') {
          return caches.match('/index.html').then(res => res ? cleanResponse(res) : Response.error());
        }
      });
    })
  );
});
