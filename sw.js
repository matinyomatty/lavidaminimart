// ═══════════════════════════════════════════════
//  LA VIDA MINIMART — Service Worker
//  Offline-first: cache everything, queue writes
// ═══════════════════════════════════════════════
const CACHE_NAME = 'lavida-v1';
const SYNC_TAG   = 'lavida-sync';

// Assets to pre-cache on install
const PRECACHE = [
  './index.html',
  './manifest.json',
  'https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@400;500;700&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.28/jspdf.plugin.autotable.min.js'
];

// ── INSTALL: cache core assets ──
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(PRECACHE).catch(() => {/* non-fatal if CDN offline */})
    )
  );
});

// ── ACTIVATE: clean old caches ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── FETCH: cache-first for GET, network for POST ──
self.addEventListener('fetch', e => {
  const { request } = e;

  // POST requests (saves to Google Sheets) — queue if offline
  if (request.method === 'POST') {
    e.respondWith(
      fetch(request.clone()).catch(async () => {
        // Store in IndexedDB queue
        const body = await request.clone().text();
        await queueRequest(request.url, body);
        // Register background sync if supported
        if ('sync' in self.registration) {
          await self.registration.sync.register(SYNC_TAG);
        }
        // Return fake OK so app doesn't crash
        return new Response(JSON.stringify({ queued: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // GET requests — cache first, then network
  e.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        // Cache successful responses
        if (response && response.status === 200 && response.type !== 'opaque') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback for navigation
        if (request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});

// ── BACKGROUND SYNC: flush queued requests ──
self.addEventListener('sync', e => {
  if (e.tag === SYNC_TAG) {
    e.waitUntil(flushQueue());
  }
});

// ── PUSH NOTIFICATIONS (future use) ──
self.addEventListener('push', e => {
  if (!e.data) return;
  const { title, body } = e.data.json();
  e.waitUntil(
    self.registration.showNotification(title || 'La Vida', {
      body,
      icon: './icon-192.png',
      badge: './icon-192.png'
    })
  );
});

// ═══════════════════════════════════════════════
//  IndexedDB Queue Helpers
// ═══════════════════════════════════════════════
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('lavida-queue', 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore('requests', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function queueRequest(url, body) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('requests', 'readwrite');
    tx.objectStore('requests').add({ url, body, timestamp: Date.now() });
    tx.oncomplete = resolve;
    tx.onerror = e => reject(e.target.error);
  });
}

async function flushQueue() {
  const db = await openDB();
  const items = await new Promise((resolve, reject) => {
    const tx = db.transaction('requests', 'readonly');
    const req = tx.objectStore('requests').getAll();
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });

  for (const item of items) {
    try {
      await fetch(item.url, {
        method: 'POST',
        mode: 'no-cors',
        body: item.body
      });
      // Remove from queue on success
      await new Promise((resolve, reject) => {
        const tx = db.transaction('requests', 'readwrite');
        tx.objectStore('requests').delete(item.id);
        tx.oncomplete = resolve;
        tx.onerror = e => reject(e.target.error);
      });
    } catch {
      // Leave in queue, retry next sync
    }
  }

  // Notify all open tabs that sync completed
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach(c => c.postMessage({ type: 'SYNC_COMPLETE' }));
}
