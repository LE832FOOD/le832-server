/* ═══════════════════════════════════════════════════════════════════
   Le 832 — Service Worker
   Gère :
   - Le cache de la carte (mode hors ligne)
   - La réception des notifications push depuis le serveur
   - Le clic sur les notifications (ouvre l'app)
   ═══════════════════════════════════════════════════════════════════ */

const CACHE_VERSION = 'le832-v1';
const ASSETS = [
  '/carte.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
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

// Activation : nettoie les anciens caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Stratégie network-first avec fallback cache (pour la carte HTML)
// pour les autres requêtes : cache-first
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Ne pas intercepter les API
  if (url.pathname.startsWith('/api/')) return;

  // HTML : network-first
  if (req.destination === 'document' || url.pathname.endsWith('.html')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('/carte.html')))
    );
    return;
  }

  // Autres : cache-first
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

// ═══ NOTIFICATIONS PUSH ═══

// Réception d'une notification push depuis le serveur
self.addEventListener('push', (event) => {
  let data = {};
  try {
    if (event.data) data = event.data.json();
  } catch (e) {
    data = { title: 'Le 832', body: event.data ? event.data.text() : 'Vous avez une nouvelle notification' };
  }

  const title = data.title || 'Le 832';
  const options = {
    body: data.body || '',
    icon: data.icon || '/icon-192.png',
    badge: data.badge || '/icon-192.png',
    image: data.image,
    tag: data.tag || 'le832-promo',
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

// Clic sur une notification : ouvre l'app (ou la met en avant si déjà ouverte)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/carte.html';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Si une fenêtre est déjà ouverte sur l'app, la mettre en avant
      for (const client of clientList) {
        if (client.url.includes('/carte.html') && 'focus' in client) {
          return client.focus();
        }
      }
      // Sinon, ouvrir une nouvelle fenêtre
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

// Permettre la mise à jour immédiate du SW depuis la page
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
