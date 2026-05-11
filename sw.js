/* ═══════════════════════════════════════════════════════════════════
   LE 832 FOOD — Service Worker
   Gère :
   - Le cache de la carte (mode hors ligne)
   - Le cache spécial du MENU (/api/menu) pour résilience Render free tier
   - La réception des notifications push depuis le serveur
   - Le clic sur les notifications (ouvre l'app)
   ═══════════════════════════════════════════════════════════════════ */

const CACHE_VERSION = 'le832food-v4';     // ↑ bump pour forcer le re-cache (stale-while-revalidate)
const CACHE_API = 'le832food-api-v4';
const ASSETS = [
  '/carte.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png'
];

// Installation : pré-cache les assets essentiels
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      // Cache best-effort : ne pas planter si un asset est manquant
      return Promise.allSettled(ASSETS.map((a) => cache.add(a)));
    }).then(() => self.skipWaiting())
  );
});

// Activation : nettoie les anciens caches (mais préserve les caches API qu'on veut garder)
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_VERSION && k !== CACHE_API)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Stratégie de fetch
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // ★ /api/menu : network-first avec fallback cache (resilience Render free tier sleep/redéploiement)
  // Si le serveur répond OK → on stocke et on renvoie la réponse fraîche
  // Si le serveur ne répond pas (timeout, 500, sleep) → on renvoie la dernière version connue
  if (url.pathname === '/api/menu') {
    event.respondWith(
      (async () => {
        try {
          const networkResp = await Promise.race([
            fetch(req),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))
          ]);
          if (networkResp.ok) {
            const cache = await caches.open(CACHE_API);
            cache.put(req, networkResp.clone()).catch(() => {});
            return networkResp;
          }
          throw new Error('network not ok');
        } catch (err) {
          const cached = await caches.match(req, { cacheName: CACHE_API });
          if (cached) {
            console.log('[SW] /api/menu : utilisation du cache (reseau indispo)');
            return cached;
          }
          return new Response(JSON.stringify({ menu: {}, openHours: {}, _cached: false, _error: 'network' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      })()
    );
    return;
  }

  // Ne pas intercepter les autres API (orders, push, etc.)
  if (url.pathname.startsWith('/api/')) return;

  // HTML : stale-while-revalidate (rapide + frais)
  // Renvoie immédiatement le cache si présent (instantané), puis met à jour en tâche de fond
  if (req.destination === 'document' || url.pathname.endsWith('.html')) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const fetchPromise = fetch(req)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
            }
            return res;
          })
          .catch(() => cached || caches.match('/carte.html'));
        // Si on a un cache → renvoie tout de suite (rapide)
        // Sinon attend le réseau
        return cached || fetchPromise;
      })
    );
    return;
  }

  // Autres assets : cache-first
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => cached))
  );
});

// Notifications push
self.addEventListener('push', (event) => {
  let data = {};
  try {
    if (event.data) data = event.data.json();
  } catch (e) {
    data = { title: 'LE 832 FOOD', body: event.data ? event.data.text() : 'Vous avez une nouvelle notification' };
  }

  const title = data.title || 'LE 832 FOOD';
  const options = {
    body: data.body || '',
    icon: data.icon || '/icon-192.png',
    badge: data.badge || '/icon-192.png',
    image: data.image,
    tag: data.tag || 'le832food-promo',
    renotify: !!data.renotify,
    data: {
      url: data.url || '/carte.html',
      promoCode: data.promoCode || null
    },
    actions: data.actions || [
      { action: 'view', title: 'Voir' }
    ],
    requireInteraction: !!data.requireInteraction,
    vibrate: [200, 100, 200]
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/carte.html';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes('/carte.html') && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
