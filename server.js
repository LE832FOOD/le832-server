
#!/usr/bin/env node
/**
 * Flamme / Le 832 — Serveur de synchronisation + carte fidélité PWA
 * ──────────────────────────────────────────────────────────────────
 * 1. Sync temps réel WebSocket entre caisses/bornes (existant)
 * 2. Sert la caisse à http://localhost:8080/
 * 3. Sert la carte fidélité PWA à /carte.html, /sw.js, /manifest.json
 * 4. API push web : abonnement + envoi de promos
 *
 * INSTALLATION
 *   npm install ws web-push
 *   npx web-push generate-vapid-keys
 *   # Coller la PUBLIC dans carte.html + caisse.html (constante VAPID_PUBLIC_KEY)
 *   # Coller la PRIVATE et la PUBLIC ci-dessous (ou via env VAPID_PUBLIC / VAPID_PRIVATE)
 *   node server.js
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

let WebSocketServer;
try {
  WebSocketServer = require('ws').Server;
} catch (e) {
  console.error('\n❌  Module "ws" manquant. Lance : npm install ws web-push\n');
  process.exit(1);
}

let webPush = null;
try { webPush = require('web-push'); }
catch (e) { console.warn('⚠ web-push non installé — notifs push désactivées.\n'); }

const PORT = process.env.PORT || 8080;
const STATE_FILE = path.join(__dirname, 'flamme_state.json');
const SUBS_FILE = path.join(__dirname, 'flamme_subscriptions.json');

const VAPID = {
  publicKey:  process.env.VAPID_PUBLIC  || 'REPLACE_WITH_YOUR_VAPID_PUBLIC_KEY',
  privateKey: process.env.VAPID_PRIVATE || 'REPLACE_WITH_YOUR_VAPID_PRIVATE_KEY',
  subject:    process.env.VAPID_SUBJECT || 'mailto:contact@le832.fr'
};
const ADMIN_CODE = process.env.ADMIN_CODE || '9999';

if (webPush && VAPID.publicKey !== 'REPLACE_WITH_YOUR_VAPID_PUBLIC_KEY') {
  webPush.setVapidDetails(VAPID.subject, VAPID.publicKey, VAPID.privateKey);
} else if (webPush) {
  console.warn('⚠ VAPID non configuré. Lance : npx web-push generate-vapid-keys');
  console.warn('  Puis renseigne les clés dans server.js et carte.html\n');
}

// ═══ Persistance ═══
let sharedState = {};
try {
  if (fs.existsSync(STATE_FILE)) {
    sharedState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    console.log(`✓ État chargé (${STATE_FILE})`);
  }
} catch (e) { console.error('Erreur lecture état :', e.message); }

let subscriptions = {}; // { phoneKey: [{endpoint, keys, addedAt}, ...] }
try {
  if (fs.existsSync(SUBS_FILE)) {
    subscriptions = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
    const total = Object.values(subscriptions).reduce((s, a) => s + a.length, 0);
    console.log(`✓ ${total} abonnement(s) push chargé(s)`);
  }
} catch (e) { console.error('Erreur lecture abonnements :', e.message); }

let saveTimer = null;
function persistSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(sharedState, null, 2)); }
    catch (e) { console.error('Erreur sauvegarde état :', e.message); }
  }, 500);
}
function persistSubs() {
  try { fs.writeFileSync(SUBS_FILE, JSON.stringify(subscriptions, null, 2)); }
  catch (e) { console.error('Erreur sauvegarde subs :', e.message); }
}

const normalizePhone = (p) => (p || '').toString().replace(/[^\d+]/g, '');

// ═══ Statique ═══
const STATIC_FILES = {
  '/':              { file: 'caisse.html',    type: 'text/html; charset=utf-8' },
  '/caisse.html':   { file: 'caisse.html',    type: 'text/html; charset=utf-8' },
  '/carte.html':    { file: 'carte.html',     type: 'text/html; charset=utf-8' },
  '/sw.js':         { file: 'sw.js',          type: 'application/javascript; charset=utf-8' },
  '/manifest.json': { file: 'manifest.json',  type: 'application/manifest+json; charset=utf-8' },
  '/icon-192.png':  { file: 'icon-192.png',   type: 'image/png' },
  '/icon-512.png':  { file: 'icon-512.png',   type: 'image/png' }
};

function readBody(req, max = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = ''; let len = 0;
    req.on('data', (chunk) => {
      len += chunk.length;
      if (len > max) { reject(new Error('Body too large')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function jsonRes(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // ─── Statique ───
  if (req.method === 'GET' && STATIC_FILES[pathname]) {
    const conf = STATIC_FILES[pathname];
    const filePath = path.join(__dirname, conf.file);
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': conf.type, 'Cache-Control': 'no-cache' });
      fs.createReadStream(filePath).pipe(res);
      return;
    } else {
      res.writeHead(404);
      res.end(`Fichier ${conf.file} introuvable. Place-le à côté de server.js.`);
      return;
    }
  }

  // ─── /health ───
  if (req.method === 'GET' && pathname === '/health') {
    return jsonRes(res, 200, {
      ok: true,
      clients: wss ? wss.clients.size : 0,
      orders: (sharedState.orders || []).length,
      subscribers: Object.values(subscriptions).reduce((s, a) => s + a.length, 0),
      pushEnabled: !!webPush && VAPID.publicKey !== 'REPLACE_WITH_YOUR_VAPID_PUBLIC_KEY'
    });
  }

  // ─── /api/customer ───
  if (req.method === 'GET' && pathname === '/api/customer') {
    const phone = normalizePhone(url.searchParams.get('phone') || '');
    if (!phone) return jsonRes(res, 400, { error: 'phone manquant' });
    const customers = sharedState.customers || {};
    const c = customers[phone];
    const loyalty = sharedState.loyalty || {};
    if (!c) {
      return jsonRes(res, 200, {
        found: false,
        phone,
        rewardThreshold: loyalty.rewardThreshold || 100,
        rewardValue: loyalty.rewardValue || 5
      });
    }
    return jsonRes(res, 200, {
      found: true,
      phone: c.phone,
      firstName: c.firstName || '',
      lastName: c.lastName || '',
      email: c.email || '',
      birthday: c.birthday || '',
      address: c.address || '',
      points: c.points || 0,
      orderCount: c.orderCount || 0,
      totalSpent: c.totalSpent || 0,
      favoriteItem: c.favoriteItem || '',
      rewardThreshold: loyalty.rewardThreshold || 100,
      rewardValue: loyalty.rewardValue || 5,
      recentOrders: ((sharedState.orders || []).filter(o => o.customer && normalizePhone(o.customer.phone) === phone).slice(0, 10).map(o => ({
        id: o.id,
        number: o.number,
        createdAt: o.createdAt,
        total: o.total,
        type: o.type,
        status: o.status,
        itemCount: (o.items || []).reduce((s, i) => s + (i.qty || 1), 0)
      })))
    });
  }

  // ─── /api/subscribe ───
  if (req.method === 'POST' && pathname === '/api/subscribe') {
    if (!webPush) return jsonRes(res, 503, { error: 'push désactivé' });
    let body;
    try { body = await readBody(req); } catch (e) { return jsonRes(res, 400, { error: 'invalid body' }); }
    const phone = normalizePhone(body.phone || '');
    const sub = body.subscription;
    if (!phone || !sub || !sub.endpoint) return jsonRes(res, 400, { error: 'phone et subscription requis' });
    if (!subscriptions[phone]) subscriptions[phone] = [];
    if (!subscriptions[phone].find(s => s.endpoint === sub.endpoint)) {
      subscriptions[phone].push({ endpoint: sub.endpoint, keys: sub.keys, addedAt: Date.now() });
      persistSubs();
    }
    return jsonRes(res, 200, { ok: true });
  }

  // ─── /api/unsubscribe ───
  if (req.method === 'POST' && pathname === '/api/unsubscribe') {
    let body;
    try { body = await readBody(req); } catch (e) { return jsonRes(res, 400, { error: 'invalid body' }); }
    const phone = normalizePhone(body.phone || '');
    const endpoint = body.endpoint;
    if (!phone || !endpoint) return jsonRes(res, 400, { error: 'phone et endpoint requis' });
    if (subscriptions[phone]) {
      subscriptions[phone] = subscriptions[phone].filter(s => s.endpoint !== endpoint);
      if (subscriptions[phone].length === 0) delete subscriptions[phone];
      persistSubs();
    }
    return jsonRes(res, 200, { ok: true });
  }

  // ─── /api/send-promo (admin) ───
  if (req.method === 'POST' && pathname === '/api/send-promo') {
    if (!webPush) return jsonRes(res, 503, { error: 'push désactivé' });
    let body;
    try { body = await readBody(req); } catch (e) { return jsonRes(res, 400, { error: 'invalid body' }); }
    if (body.adminCode !== ADMIN_CODE) return jsonRes(res, 401, { error: 'code admin invalide' });
    const title = (body.title || 'Le 832').toString().slice(0, 100);
    const message = (body.message || '').toString().slice(0, 500);
    if (!message) return jsonRes(res, 400, { error: 'message requis' });

    let targets = [];
    if (body.phone && body.phone !== 'all') {
      const p = normalizePhone(body.phone);
      targets = subscriptions[p] ? [{ phone: p, subs: subscriptions[p] }] : [];
    } else {
      targets = Object.entries(subscriptions).map(([phone, subs]) => ({ phone, subs }));
    }

    const payload = JSON.stringify({
      title, body: message,
      tag: body.tag || 'le832-promo',
      url: body.url || '/carte.html',
      promoCode: body.promoCode || null,
      requireInteraction: !!body.requireInteraction
    });

    let success = 0, fail = 0;
    const removeList = [];
    for (const t of targets) {
      for (const sub of t.subs) {
        try {
          await webPush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload);
          success++;
        } catch (e) {
          fail++;
          if (e.statusCode === 410 || e.statusCode === 404) {
            removeList.push({ phone: t.phone, endpoint: sub.endpoint });
          }
          console.warn(`Push fail ${t.phone}: ${e.statusCode || e.message}`);
        }
      }
    }
    for (const r of removeList) {
      if (subscriptions[r.phone]) {
        subscriptions[r.phone] = subscriptions[r.phone].filter(s => s.endpoint !== r.endpoint);
        if (subscriptions[r.phone].length === 0) delete subscriptions[r.phone];
      }
    }
    if (removeList.length > 0) persistSubs();

    return jsonRes(res, 200, { ok: true, success, fail, expired: removeList.length });
  }

  // ─── /api/subscribers-count ───
  if (req.method === 'GET' && pathname === '/api/subscribers-count') {
    const total = Object.values(subscriptions).reduce((s, a) => s + a.length, 0);
    return jsonRes(res, 200, { total, uniquePhones: Object.keys(subscriptions).length });
  }

  // ─── /api/customer-update : mise à jour des infos client depuis la PWA ───
  if (req.method === 'POST' && pathname === '/api/customer-update') {
    let body;
    try { body = await readBody(req); } catch (e) { return jsonRes(res, 400, { error: 'invalid body' }); }
    const phone = normalizePhone(body.phone || '');
    if (!phone) return jsonRes(res, 400, { error: 'phone manquant' });
    if (!sharedState.customers) sharedState.customers = {};
    const existing = sharedState.customers[phone] || { phone, points: 0, orderCount: 0, createdAt: Date.now() };
    sharedState.customers[phone] = {
      ...existing,
      firstName: body.firstName || existing.firstName || '',
      lastName: body.lastName || existing.lastName || '',
      email: body.email || existing.email || '',
      birthday: body.birthday || existing.birthday || '',
      address: body.address || existing.address || '',
      updatedAt: Date.now()
    };
    persistSoon();
    // Broadcast aux caisses connectées
    broadcast(null, { type: 'state', data: sharedState });
    return jsonRes(res, 200, { ok: true });
  }

  // ─── /api/menu : menu pour la PWA ───
  if (req.method === 'GET' && pathname === '/api/menu') {
    const menu = sharedState.menu || {};
    // Filtrer pour ne garder que les produits visibles + champs publics
    const filtered = {};
    for (const cat in menu) {
      const items = (menu[cat] || []).filter(p => !p.hidden && !p.outOfStock);
      if (items.length > 0) {
        filtered[cat] = items.map(p => ({
          id: p.id,
          name: p.name,
          description: p.description || '',
          price: p.price,
          photo: p.photo || null,
          stock: p.stock
        }));
      }
    }
    const config = sharedState.config || {};
    return jsonRes(res, 200, {
      menu: filtered,
      openHours: config.openHours || {
        mon: ['11:30-14:30','18:00-22:30'],
        tue: ['11:30-14:30','18:00-22:30'],
        wed: ['11:30-14:30','18:00-22:30'],
        thu: ['11:30-14:30','18:00-22:30'],
        fri: ['11:30-14:30','18:00-23:00'],
        sat: ['11:30-14:30','18:00-23:00'],
        sun: []
      }
    });
  }

  // ─── /api/order : nouvelle commande depuis la PWA ───
  if (req.method === 'POST' && pathname === '/api/order') {
    let body;
    try { body = await readBody(req); } catch (e) { return jsonRes(res, 400, { error: 'invalid body' }); }

    const phone = normalizePhone(body.phone || '');
    if (!phone) return jsonRes(res, 400, { error: 'phone requis' });
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return jsonRes(res, 400, { error: 'panier vide' });
    }
    const validTypes = ['emporter', 'livraison', 'sur_place'];
    if (!validTypes.includes(body.type)) {
      return jsonRes(res, 400, { error: 'type invalide' });
    }

    // Numéro de commande
    if (typeof sharedState.counter !== 'number') sharedState.counter = 1;
    const orderNumber = sharedState.counter++;
    const orderId = 'pwa_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

    // Calculer total côté serveur (sécurité : ne pas faire confiance au client)
    const menu = sharedState.menu || {};
    const allProducts = {};
    for (const cat in menu) {
      for (const p of (menu[cat] || [])) allProducts[p.id] = p;
    }
    let total = 0;
    const items = [];
    for (const i of body.items) {
      const product = allProducts[i.id];
      if (!product) continue;
      const qty = Math.max(1, parseInt(i.qty) || 1);
      const itemTotal = product.price * qty;
      total += itemTotal;
      items.push({
        id: product.id,
        name: product.name,
        price: product.price,
        qty: qty
      });
    }
    if (items.length === 0) {
      return jsonRes(res, 400, { error: 'aucun produit valide' });
    }

    // Mettre à jour la fiche client
    if (!sharedState.customers) sharedState.customers = {};
    const cust = sharedState.customers[phone] || { phone, points: 0, orderCount: 0, createdAt: Date.now() };
    if (body.customer) {
      cust.firstName = body.customer.firstName || cust.firstName || '';
      cust.lastName = body.customer.lastName || cust.lastName || '';
      cust.email = body.customer.email || cust.email || '';
      if (body.customer.address) cust.address = body.customer.address;
    }
    cust.phone = phone;
    sharedState.customers[phone] = cust;

    // Créer la commande
    const order = {
      id: orderId,
      number: orderNumber,
      type: body.type,
      status: 'en_cours',
      awaitingConfirmation: true, // ← spécifique aux commandes PWA
      items: items,
      customer: {
        phone: phone,
        firstName: cust.firstName,
        lastName: cust.lastName,
        address: body.customer && body.customer.address ? body.customer.address : (cust.address || '')
      },
      table: body.table || null,
      slot: body.slot || null,
      note: body.note || '',
      total: total,
      payment: { method: 'en_attente', paid: false },
      source: 'pwa', // ← provenance app mobile
      createdAt: Date.now(),
      closedAt: null
    };

    if (!Array.isArray(sharedState.orders)) sharedState.orders = [];
    sharedState.orders.unshift(order);
    persistSoon();

    // Broadcast aux caisses connectées (sons + affichage immédiat)
    broadcast(null, { type: 'state', data: sharedState });

    return jsonRes(res, 200, {
      ok: true,
      orderId: orderId,
      number: orderNumber,
      total: total
    });
  }

  // ─── /api/my-orders : commandes en cours d'un client pour le suivi PWA ───
  if (req.method === 'GET' && pathname === '/api/my-orders') {
    const phone = normalizePhone(url.searchParams.get('phone') || '');
    if (!phone) return jsonRes(res, 400, { error: 'phone requis' });
    const all = sharedState.orders || [];
    // Filtrer : commandes du client qui ne sont pas encore "terminée" depuis trop longtemps
    const now = Date.now();
    const TWO_HOURS = 2 * 60 * 60 * 1000;
    const myOrders = all.filter(o => {
      if (!o.customer || normalizePhone(o.customer.phone) !== phone) return false;
      // Garder les commandes en cours
      if (o.status === 'en_cours' || o.status === 'en_livraison' || o.awaitingConfirmation) return true;
      // Garder les commandes terminées récemment (< 2h)
      if (o.status === 'terminee' && o.closedAt && (now - o.closedAt) < TWO_HOURS) return true;
      return false;
    });
    // Mapper pour ne renvoyer que les champs publics
    const result = myOrders.map(o => {
      // Calculer l'étape actuelle
      let stage = 'received'; // étape par défaut
      if (o.awaitingConfirmation) stage = 'received';
      else if (o.status === 'en_cours' && o.kdsStartedAt) stage = 'preparing';
      else if (o.status === 'en_cours' && !o.kdsStartedAt) stage = 'confirmed';
      else if (o.status === 'en_livraison') stage = 'delivering';
      else if (o.status === 'terminee') stage = 'completed';
      return {
        id: o.id,
        number: o.number,
        type: o.type,
        slot: o.slot || null,
        items: (o.items || []).map(i => ({ name: i.name, qty: i.qty, price: i.price })),
        total: o.total || 0,
        status: o.status,
        stage: stage,
        createdAt: o.createdAt,
        confirmedAt: o.confirmedAt || null,
        kdsStartedAt: o.kdsStartedAt || null,
        readyAt: o.readyAt || null,
        deliveryStartedAt: o.deliveryStartedAt || null,
        closedAt: o.closedAt || null,
        refusedReason: o.refusedReason || null,
        awaitingConfirmation: !!o.awaitingConfirmation
      };
    });
    // Trier par date desc
    result.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return jsonRes(res, 200, { orders: result });
  }

  // ─── /api/order-status : permet à un client de voir l'état de sa commande ───
  if (req.method === 'GET' && pathname === '/api/order-status') {
    const orderId = url.searchParams.get('id');
    if (!orderId) return jsonRes(res, 400, { error: 'id requis' });
    const order = (sharedState.orders || []).find(o => o.id === orderId);
    if (!order) return jsonRes(res, 404, { error: 'commande introuvable' });
    return jsonRes(res, 200, {
      number: order.number,
      status: order.status,
      awaitingConfirmation: !!order.awaitingConfirmation,
      type: order.type,
      slot: order.slot,
      total: order.total,
      refusedReason: order.refusedReason || null
    });
  }

  // ─── /api/order-confirm : la caisse confirme une commande PWA ───
  if (req.method === 'POST' && pathname === '/api/order-confirm') {
    let body;
    try { body = await readBody(req); } catch (e) { return jsonRes(res, 400, { error: 'invalid body' }); }
    if (body.adminCode !== ADMIN_CODE) return jsonRes(res, 401, { error: 'code admin invalide' });
    const orderId = body.orderId;
    if (!orderId) return jsonRes(res, 400, { error: 'orderId requis' });
    const order = (sharedState.orders || []).find(o => o.id === orderId);
    if (!order) return jsonRes(res, 404, { error: 'commande introuvable' });

    order.awaitingConfirmation = false;
    order.confirmedAt = Date.now();
    persistSoon();
    broadcast(null, { type: 'state', data: sharedState });

    // Push notif au client si abonné
    if (webPush && order.customer && order.customer.phone) {
      const subs = subscriptions[order.customer.phone] || [];
      const payload = JSON.stringify({
        title: 'Le 832',
        body: `✅ Commande #${order.number} confirmée ! ${order.slot ? 'Prête à ' + order.slot : 'En préparation'}`,
        tag: 'order-confirm-' + orderId,
        url: '/carte.html'
      });
      for (const sub of subs) {
        webPush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload).catch(() => {});
      }
    }
    return jsonRes(res, 200, { ok: true });
  }

  // ─── /api/order-refuse : la caisse refuse une commande PWA ───
  if (req.method === 'POST' && pathname === '/api/order-refuse') {
    let body;
    try { body = await readBody(req); } catch (e) { return jsonRes(res, 400, { error: 'invalid body' }); }
    if (body.adminCode !== ADMIN_CODE) return jsonRes(res, 401, { error: 'code admin invalide' });
    const orderId = body.orderId;
    const reason = (body.reason || 'Indisponible').toString().slice(0, 200);
    if (!orderId) return jsonRes(res, 400, { error: 'orderId requis' });
    const order = (sharedState.orders || []).find(o => o.id === orderId);
    if (!order) return jsonRes(res, 404, { error: 'commande introuvable' });

    order.status = 'annulee';
    order.awaitingConfirmation = false;
    order.refusedReason = reason;
    order.refusedAt = Date.now();
    order.closedAt = Date.now();
    persistSoon();
    broadcast(null, { type: 'state', data: sharedState });

    if (webPush && order.customer && order.customer.phone) {
      const subs = subscriptions[order.customer.phone] || [];
      const payload = JSON.stringify({
        title: 'Le 832',
        body: `❌ Commande #${order.number} non honorée : ${reason}`,
        tag: 'order-refuse-' + orderId,
        url: '/carte.html'
      });
      for (const sub of subs) {
        webPush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload).catch(() => {});
      }
    }
    return jsonRes(res, 200, { ok: true });
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// ═══ WebSocket ═══
const wss = new WebSocketServer({ server });

function broadcast(senderWs, data) {
  const payload = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client !== senderWs && client.readyState === 1) {
      try { client.send(payload); } catch (e) {}
    }
  });
}

wss.on('connection', (ws, req) => {
  const ip = (req.socket && req.socket.remoteAddress) || 'inconnu';
  console.log(`→ Connexion WS ${ip} (total : ${wss.clients.size})`);

  if (Object.keys(sharedState).length > 0) {
    try { ws.send(JSON.stringify({ type: 'state', data: sharedState })); } catch (e) {}
  }
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'hello') {
      if (Object.keys(sharedState).length > 0) {
        try { ws.send(JSON.stringify({ type: 'state', data: sharedState })); } catch (e) {}
      }
      return;
    }
    if (msg.type === 'state' && msg.data) {
      sharedState = msg.data;
      persistSoon();
      broadcast(ws, { type: 'state', data: sharedState });
    }
  });
  ws.on('close', () => console.log(`← Déconnexion (total : ${wss.clients.size})`));
  ws.on('error', (e) => console.error('WS error:', e.message));
});

server.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   FLAMME — Sync + Carte fidélité PWA             ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`\n  HTTP       : http://localhost:${PORT}`);
  console.log(`  WebSocket  : ws://localhost:${PORT}`);
  console.log(`  Carte PWA  : http://localhost:${PORT}/carte.html`);
  console.log(`  État       : ${STATE_FILE}`);
  console.log(`  Push       : ${webPush && VAPID.publicKey !== 'REPLACE_WITH_YOUR_VAPID_PUBLIC_KEY' ? '✓ activé' : '✗ désactivé (configure VAPID)'}`);

  const nets = require('os').networkInterfaces();
  const ips = [];
  for (const name in nets) {
    for (const n of nets[name]) {
      if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
    }
  }
  if (ips.length) {
    console.log('\n  Pour les autres appareils du réseau :');
    ips.forEach(ip => {
      console.log(`    Caisse → http://${ip}:${PORT}`);
      console.log(`    Carte  → http://${ip}:${PORT}/carte.html`);
    });
  }
  console.log('\n  Ctrl+C pour arrêter.\n');
});

process.on('SIGINT', () => {
  console.log('\nArrêt…');
  if (saveTimer) {
    clearTimeout(saveTimer);
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(sharedState, null, 2)); } catch (e) {}
  }
  process.exit(0);
});
