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
  publicKey:  process.env.VAPID_PUBLIC  || 'BJr4xIN3n05AHBGoadYFLb666sMan7qZ27kDt1iKb5_aKsuokCH3JPNKdDVMn1ReF-YBZjK6-GrsUbxphm7coNw',
  privateKey: process.env.VAPID_PRIVATE || 'tZu-C9HaZ62J1iVIJjSOkPlh4Au9sOThoqBo_u7wLPU',
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
      points: c.points || 0,
      orderCount: c.orderCount || 0,
      rewardThreshold: loyalty.rewardThreshold || 100,
      rewardValue: loyalty.rewardValue || 5
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
