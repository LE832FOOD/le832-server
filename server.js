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
const zlib = require('zlib');

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

// ═══════════════════════════════════════════════════════════════════
// ★ BOT TÉLÉPHONIQUE VAPI.AI — Config et helpers
// ═══════════════════════════════════════════════════════════════════
const RESTO_LOCATION = {
  lat: 48.7244,    // Vitry-le-François (TODO: à confirmer adresse exacte)
  lon: 4.5840,
  name: 'Le 832 FOOD',
  address: '51300 Vitry-le-François'
};
const DELIVERY_MAX_KM = 15;
const VAPI_WEBHOOK_SECRET = process.env.VAPI_WEBHOOK_SECRET || '';
let voiceBotEnabled = true;

function checkVapiAuth(req, res) {
  if (!VAPI_WEBHOOK_SECRET) return true; // pas d'auth en dev
  const provided = req.headers['x-vapi-secret'] || req.headers['x-vapi-signature'] || '';
  if (provided !== VAPI_WEBHOOK_SECRET) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
  }
  return true;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function geocodeAddress(address) {
  try {
    const q = encodeURIComponent(address + ', France');
    const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1&countrycodes=fr`;
    // Node 18+ a fetch natif. Pour Node < 18, il faudrait require('node-fetch') ou https.
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Le832-VoiceBot/1.0 (contact@le832.fr)' }
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    return {
      lat: parseFloat(data[0].lat),
      lon: parseFloat(data[0].lon),
      displayName: data[0].display_name
    };
  } catch (e) {
    console.error('Geocode error:', e && e.message);
    return null;
  }
}

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

// ★ CHARGEMENT AUTO DU MENU
// Si le state ne contient pas de menu (ou très petit) on tente de charger un fichier
// 'menu_default.json' du repo. Ainsi après un redéploiement Render free tier,
// le menu reste disponible sans intervention manuelle.
const MENU_DEFAULT_FILE = path.join(__dirname, 'menu_default.json');
function _ensureMenuLoaded() {
  try {
    const hasMenu = sharedState.menu &&
      typeof sharedState.menu === 'object' &&
      Object.keys(sharedState.menu).length >= 3; // au moins 3 catégories
    if (hasMenu) return;
    if (!fs.existsSync(MENU_DEFAULT_FILE)) {
      console.log(`⚠ Pas de menu par défaut (${MENU_DEFAULT_FILE}). La caisse devra charger le menu.`);
      return;
    }
    const fallback = JSON.parse(fs.readFileSync(MENU_DEFAULT_FILE, 'utf8'));
    if (!fallback.menu || typeof fallback.menu !== 'object') {
      console.log('⚠ menu_default.json invalide (champ "menu" manquant)');
      return;
    }
    if (!sharedState.menu) sharedState.menu = {};
    sharedState.menu = fallback.menu;
    if (fallback.config && typeof fallback.config === 'object') {
      sharedState.config = { ...(sharedState.config || {}), ...fallback.config };
    }
    persistSoon();
    const totalProducts = Object.values(fallback.menu).reduce((s, a) => s + (Array.isArray(a) ? a.length : 0), 0);
    console.log(`✓ Menu par défaut chargé : ${Object.keys(fallback.menu).length} catégories, ${totalProducts} produits`);
  } catch (e) {
    console.error('Erreur chargement menu par défaut :', e.message);
  }
}

let subscriptions = {}; // { phoneKey: [{endpoint, keys, addedAt}, ...] }
let sseClients = new Map(); // { phoneKey: Set<{res, lastSent}> } pour Server-Sent Events
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

// Charge le menu par défaut si state vide (après redéploiement Render free tier)
_ensureMenuLoaded();

const normalizePhone = (p) => (p || '').toString().replace(/[^\d+]/g, '');

// Sanitisation : enlève les balises HTML, scripts complets et caractères dangereux
function sanitizeString(s, maxLen) {
  if (typeof s !== 'string') return '';
  // 1. Enlève le contenu complet des balises <script>...</script>, <style>, <iframe>, <object>, <embed>
  let out = s.replace(/<(script|style|iframe|object|embed|noscript|template)[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  // 2. Enlève les balises HTML restantes mais garde le texte entre
  out = out.replace(/<[^>]*>/g, '');
  // 3. Enlève les caractères de contrôle SAUF \n et \t
  out = out.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
  // 4. Normalise espaces multiples (mais garde \n)
  out = out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (typeof maxLen === 'number' && out.length > maxLen) out = out.slice(0, maxLen);
  return out;
}

// ═══ Rate limiting (anti-DDoS / anti-spam) ═══
const RATE_LIMITS = {
  '/api/order':           { window: 60000, max: 5  },  // 5 commandes/min/IP
  '/api/customer-update': { window: 60000, max: 30 },  // 30 updates/min/IP
  '/api/subscribe':       { window: 60000, max: 10 },  // 10 abonnements/min/IP
  '/api/my-orders':       { window: 60000, max: 60 },  // 1 req/sec en moyenne
  '/api/menu':            { window: 60000, max: 60 },
  '/api/customer':        { window: 60000, max: 60 },
  '/api/wheel-win':       { window: 60000, max: 5  },  // anti-abus roue (5 win/min/IP max)
  '/api/has-push':        { window: 60000, max: 60 },
  default:                { window: 60000, max: 120 } // 2/sec en moyenne
};
const rateBuckets = new Map(); // ip+path -> [timestamps]
function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}
function rateLimitOk(req, pathname) {
  const limit = RATE_LIMITS[pathname] || RATE_LIMITS.default;
  const ip = getClientIp(req);
  const key = ip + ':' + pathname;
  const now = Date.now();
  const arr = rateBuckets.get(key) || [];
  const fresh = arr.filter(t => (now - t) < limit.window);
  if (fresh.length >= limit.max) {
    rateBuckets.set(key, fresh);
    return false;
  }
  fresh.push(now);
  rateBuckets.set(key, fresh);
  // Nettoyage périodique
  if (rateBuckets.size > 5000) {
    const cutoff = now - 5 * 60 * 1000; // 5 min
    for (const [k, v] of rateBuckets) {
      const f = v.filter(t => t > cutoff);
      if (f.length === 0) rateBuckets.delete(k);
      else rateBuckets.set(k, f);
    }
  }
  return true;
}

// ═══ Limites métier ═══
const MAX_ITEMS_PER_ORDER = 50;       // 50 produits différents max
const MAX_QTY_PER_ITEM    = 30;       // 30 unités max par produit
const MAX_PENDING_ORDERS  = 200;      // 200 commandes simultanées max
const MAX_NOTE_LENGTH     = 500;      // 500 caractères max pour la note
const ORDER_RETENTION_MS  = 7 * 24 * 60 * 60 * 1000; // 7 jours
const MAX_TOTAL_ORDERS    = 2000;                     // Hard limit en mémoire

// ═══ Auto-purge des vieilles commandes ═══
function purgeOldOrders() {
  if (!Array.isArray(sharedState.orders)) return;
  const now = Date.now();
  const before = sharedState.orders.length;
  // Étape 1 : purge par âge (>7 jours pour les terminées)
  sharedState.orders = sharedState.orders.filter(o => {
    if (o.status === 'en_cours' || o.status === 'en_livraison' || o.awaitingConfirmation) return true;
    const closedAt = o.closedAt || o.refusedAt || o.createdAt || now;
    return (now - closedAt) < ORDER_RETENTION_MS;
  });
  // Étape 2 : si toujours trop, garder les plus récentes
  if (sharedState.orders.length > MAX_TOTAL_ORDERS) {
    sharedState.orders.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    sharedState.orders = sharedState.orders.slice(0, MAX_TOTAL_ORDERS);
  }
  const removed = before - sharedState.orders.length;
  if (removed > 0) {
    console.log(`Auto-purge: ${removed} vieilles commandes supprimées (en mémoire: ${sharedState.orders.length})`);
    persistSoon();
  }
}
// Lancer la purge toutes les 6h
setInterval(purgeOldOrders, 6 * 60 * 60 * 1000);

// ═══ Push notification utilitaire ═══
async function sendPushTo(phone, title, body, data = {}) {
  if (!webPush) return;
  const phoneNorm = normalizePhone(phone);
  const subs = subscriptions[phoneNorm];
  if (!subs || subs.length === 0) return;
  const payload = JSON.stringify({ title, body, data });
  const removeList = [];
  for (const sub of subs) {
    try {
      await webPush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload);
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        removeList.push(sub.endpoint);
      }
    }
  }
  if (removeList.length > 0) {
    subscriptions[phoneNorm] = subs.filter(s => !removeList.includes(s.endpoint));
    persistSubs();
  }
}

// ═══ Détection des changements d'état des commandes PWA + envoi notifs ═══
// Compare l'ancien état au nouveau et envoie les notifications appropriées
function detectOrderChangesAndNotify(oldOrders, newOrders) {
  if (!Array.isArray(newOrders)) return;
  const oldMap = {};
  (oldOrders || []).forEach(o => { if (o && o.id) oldMap[o.id] = o; });

  // Récupérer les canaux configurés depuis sharedState.config.notifChannels
  // Défauts si non configurés : push partout sauf preparing (none) et delivering (both)
  const defaults = { confirmed: 'push', preparing: 'none', ready: 'push', delivering: 'both', completed: 'push' };
  const channels = (sharedState.config && sharedState.config.notifChannels) || {};
  const ch = (stage) => {
    const c = channels[stage];
    if (!c || !['push', 'sms', 'both', 'none'].includes(c)) return defaults[stage] || 'push';
    return c;
  };

  // Limite de protection : max 100 commandes scannées par sync
  const MAX_SCAN = 100;
  let scanned = 0;

  for (const newO of newOrders) {
    if (scanned++ >= MAX_SCAN) break;
    try {
      if (!newO || newO.source !== 'pwa') continue;
      if (!newO.customer || !newO.customer.phone) continue;
      const phone = newO.customer.phone;
      const oldO = oldMap[newO.id];
      if (!oldO) continue;
      const num = newO.number;

      // Détecter si un changement d'état s'est produit pour cette commande
      const stateChanged = (
        oldO.awaitingConfirmation !== newO.awaitingConfirmation ||
        oldO.status !== newO.status ||
        oldO.kdsStatus !== newO.kdsStatus
      );

      // ★ NOUVEAU : si la commande a un canal préféré (notifChannel), il prime sur le canal global
      // Valeurs possibles : 'push' | 'sms' | 'both' | 'none'
      // Si la commande vient d'une PWA (newO.source === 'pwa'), on force 'push' (le client a déjà l'app)
      const orderCh = (stage) => {
        if (newO.source === 'pwa') return 'push'; // PWA → push automatique toujours
        if (newO.notifChannel && ['push','sms','both','none'].includes(newO.notifChannel)) {
          return newO.notifChannel;
        }
        return ch(stage); // fallback canal global par étape
      };

      // ÉCRAN TEMPS RÉEL : envoyer SSE à chaque changement même si pas de notif push/SMS
      // (ex: passage en préparation où canal=none → l'écran doit quand même s'actualiser)
      if (stateChanged) {
        sendSseTo(phone, 'order_update', {
          orderId: newO.id,
          number: num,
          status: newO.status,
          awaitingConfirmation: !!newO.awaitingConfirmation,
          kdsStatus: newO.kdsStatus || null,
          type: newO.type
        });
      }

      // 1. Confirmation
      if (oldO.awaitingConfirmation && !newO.awaitingConfirmation && newO.status !== 'annulee') {
        sendNotifTo(phone, orderCh('confirmed'), '✓ Commande confirmée',
          `Commande N°${num} confirmée — votre commande est en préparation.`,
          { orderId: newO.id, stage: 'confirmed' });
      }
      // 2. Refus
      if (oldO.status !== 'annulee' && newO.status === 'annulee') {
        const reason = newO.refusedReason ? ` : ${newO.refusedReason}` : '';
        // Refus = toujours push (pas configurable car critique)
        sendPushTo(phone, '❌ Commande refusée',
          `Commande N°${num} refusée${reason}`,
          { orderId: newO.id, stage: 'refused' });
      }
      // 2bis. En préparation (transition kdsStatus → 'preparation')
      if (oldO.kdsStatus !== 'preparation' && newO.kdsStatus === 'preparation') {
        sendNotifTo(phone, orderCh('preparing'), '🍳 En préparation',
          `Commande N°${num} en préparation`,
          { orderId: newO.id, stage: 'preparing' });
      }
      // 3. Cuisine prête
      if (oldO.kdsStatus !== 'prete' && newO.kdsStatus === 'prete') {
        if (newO.type !== 'livraison') {
          sendNotifTo(phone, orderCh('ready'), '🛍 Commande prête',
            `Commande N°${num} prête à récupérer !`,
            { orderId: newO.id, stage: 'ready' });
        }
        // Pour livraison : pas de notif "prête" (la suivante est "livreur en route")
      }
      // 4. Livreur en route
      if (oldO.status !== 'en_livraison' && newO.status === 'en_livraison') {
        sendNotifTo(phone, orderCh('delivering'), '🚗 Livreur en route',
          `Commande N°${num} — votre livreur est en route !`,
          { orderId: newO.id, stage: 'delivering' });
      }
      // 5. Terminée
      if (oldO.status !== 'terminee' && newO.status === 'terminee') {
        const msg = newO.type === 'livraison'
          ? `Commande N°${num} livrée — bon appétit !`
          : `Commande N°${num} récupérée — bon appétit !`;
        sendNotifTo(phone, orderCh('completed'), '🏁 Bon appétit', msg,
          { orderId: newO.id, stage: 'completed' });
      }
    } catch (e) {
      console.error('Erreur notif commande:', e.message);
    }
  }
}

// Envoie selon le canal configuré ; pour SMS, on broadcast aux caisses qui ouvriront l'app SMS
// Toujours envoie aussi un événement SSE à la PWA pour rafraîchir l'écran instantanément
async function sendNotifTo(phone, channel, title, body, data) {
  // SSE : toujours envoyé indépendamment du canal pour MAJ écran temps réel
  sendSseTo(phone, 'order_update', { title, body, ...data });

  if (channel === 'none') return;
  if (channel === 'push' || channel === 'both') {
    sendPushTo(phone, title, body, data).catch(() => {});
  }
  if (channel === 'sms' || channel === 'both') {
    // Broadcast un message aux caisses connectées : elles ouvriront sms: locally
    broadcastSmsRequest(phone, body, data);
  }
}

// Envoie un événement SSE (Server-Sent Event) à toutes les sessions PWA d'un client
// → utilisé pour rafraîchir l'écran de suivi instantanément quand un statut change
function sendSseTo(phone, eventName, payload) {
  try {
    if (!sseClients) return;
    const phoneNorm = normalizePhone(phone);
    const set = sseClients.get(phoneNorm);
    if (!set || set.size === 0) return;
    const data = 'event: ' + eventName + '\ndata: ' + JSON.stringify(payload || {}) + '\n\n';
    const dead = [];
    set.forEach(client => {
      try { client.res.write(data); client.lastSent = Date.now(); }
      catch (e) { dead.push(client); }
    });
    dead.forEach(c => set.delete(c));
    if (set.size === 0) sseClients.delete(phoneNorm);
  } catch (e) { console.error('sendSseTo error:', e.message); }
}

// Diffuse un événement SSE à TOUTES les PWA connectées (tous clients)
// → utilisé quand le menu ou les horaires changent globalement
function broadcastSseToAll(payload) {
  try {
    if (!sseClients) return;
    const eventName = (payload && payload.type) || 'update';
    const data = 'event: ' + eventName + '\ndata: ' + JSON.stringify(payload || {}) + '\n\n';
    sseClients.forEach((set, phone) => {
      const dead = [];
      set.forEach(client => {
        try { client.res.write(data); client.lastSent = Date.now(); }
        catch (e) { dead.push(client); }
      });
      dead.forEach(c => set.delete(c));
      if (set.size === 0) sseClients.delete(phone);
    });
  } catch (e) { console.error('broadcastSseToAll error:', e.message); }
}

// Demande à toutes les caisses connectées d'ouvrir un SMS pour ce client
function broadcastSmsRequest(phone, body, data) {
  try {
    if (!wss) return;
    const msg = JSON.stringify({ type: 'sms_request', phone, body, data });
    wss.clients.forEach(client => {
      try { if (client.readyState === 1) client.send(msg); } catch (e) {}
    });
  } catch (e) { console.error('broadcastSmsRequest error:', e.message); }
}

// ═══ Statique ═══
const STATIC_FILES = {
  '/':              { file: 'caisse.html',    type: 'text/html; charset=utf-8' },
  '/caisse.html':   { file: 'caisse.html',    type: 'text/html; charset=utf-8' },
  '/carte.html':    { file: 'carte.html',     type: 'text/html; charset=utf-8' },
  '/sw.js':         { file: 'sw.js',          type: 'application/javascript; charset=utf-8' },
  '/manifest.json': { file: 'manifest.json',  type: 'application/manifest+json; charset=utf-8' },
  // Anciennes routes (rétrocompat) — pointent vers les nouveaux fichiers
  '/icon-192.png':  { file: 'icon-192.png',   type: 'image/png' },
  '/icon-512.png':  { file: 'icon-512.png',   type: 'image/png' },
  // Nouvelles icônes LE 832 FOOD
  '/icon-32.png':           { file: 'icon-32.png',          type: 'image/png' },
  '/icon-48.png':           { file: 'icon-48.png',          type: 'image/png' },
  '/icon-72.png':           { file: 'icon-72.png',          type: 'image/png' },
  '/icon-96.png':           { file: 'icon-96.png',          type: 'image/png' },
  '/icon-144.png':          { file: 'icon-144.png',         type: 'image/png' },
  '/icon-152.png':          { file: 'icon-152.png',         type: 'image/png' },
  '/icon-167.png':          { file: 'icon-167.png',         type: 'image/png' },
  '/icon-180.png':          { file: 'icon-180.png',         type: 'image/png' },
  '/icon-192.png':          { file: 'icon-192.png',         type: 'image/png' },
  '/icon-256.png':          { file: 'icon-256.png',         type: 'image/png' },
  '/icon-384.png':          { file: 'icon-384.png',         type: 'image/png' },
  '/icon-512.png':          { file: 'icon-512.png',         type: 'image/png' },
  '/apple-touch-icon.png':  { file: 'apple-touch-icon.png', type: 'image/png' },
  '/favicon-16.png':        { file: 'favicon-16.png',       type: 'image/png' },
  '/favicon-32.png':        { file: 'favicon-32.png',       type: 'image/png' },
  '/favicon.ico':           { file: 'favicon.ico',          type: 'image/x-icon' },
  '/favicon.ico':                 { file: 'favicon.ico',          type: 'image/x-icon' }
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

  // ─── Rate limiting sur /api/* ───
  if (pathname.startsWith('/api/')) {
    if (!rateLimitOk(req, pathname)) {
      return jsonRes(res, 429, { error: 'trop de requêtes, ralentissez' });
    }
  }

  // ─── Statique ───
  if (req.method === 'GET' && STATIC_FILES[pathname]) {
    const conf = STATIC_FILES[pathname];
    const filePath = path.join(__dirname, conf.file);
    if (fs.existsSync(filePath)) {
      // Compression gzip/deflate si supporté par le client
      const acceptEncoding = (req.headers['accept-encoding'] || '').toLowerCase();
      const compressible = /text|javascript|json|xml|html|svg/.test(conf.type);
      // Cache : long pour les icônes/images (immutables), court pour HTML/JS
      const isImage = /image\//.test(conf.type) || /\.(png|jpg|jpeg|ico|svg|webp)$/i.test(conf.file);
      const cacheControl = isImage ? 'public, max-age=2592000, immutable' : 'public, max-age=300, must-revalidate';
      try {
        const headers = { 'Content-Type': conf.type, 'Cache-Control': cacheControl };
        // Compression seulement si compressible et accept-encoding compatible
        if (compressible && acceptEncoding.includes('gzip')) {
          headers['Content-Encoding'] = 'gzip';
          headers['Vary'] = 'Accept-Encoding';
          res.writeHead(200, headers);
          fs.createReadStream(filePath).pipe(zlib.createGzip()).pipe(res);
        } else if (compressible && acceptEncoding.includes('deflate')) {
          headers['Content-Encoding'] = 'deflate';
          headers['Vary'] = 'Accept-Encoding';
          res.writeHead(200, headers);
          fs.createReadStream(filePath).pipe(zlib.createDeflate()).pipe(res);
        } else {
          res.writeHead(200, headers);
          fs.createReadStream(filePath).pipe(res);
        }
        return;
      } catch (e) {
        console.error('Erreur servir fichier:', e.message);
        res.writeHead(500);
        res.end('Erreur serveur');
        return;
      }
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
      photo: c.photo || '',
      inLeaderboard: !!c.inLeaderboard,
      showPhotoOnCard: !!c.showPhotoOnCard,
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

    // ★ Photo de profil : valider le base64 et la taille (max ~250 Ko)
    let photo = existing.photo || '';
    if (typeof body.photo === 'string') {
      // Si chaîne vide, on supprime la photo
      if (body.photo === '') {
        photo = '';
      } else if (body.photo.startsWith('data:image/') && body.photo.length < 350000) {
        photo = body.photo;
      }
      // Sinon on ignore (image trop grosse ou mauvais format)
    }

    // ★ Opt-in classement : booléen explicite, défaut false
    let inLeaderboard = !!existing.inLeaderboard;
    if (typeof body.inLeaderboard === 'boolean') {
      inLeaderboard = body.inLeaderboard;
    }

    // ★ Photo sur carte (toggle photo OU QR) : booléen explicite, défaut false (QR)
    let showPhotoOnCard = !!existing.showPhotoOnCard;
    if (typeof body.showPhotoOnCard === 'boolean') {
      showPhotoOnCard = body.showPhotoOnCard;
    }

    sharedState.customers[phone] = {
      ...existing,
      firstName: body.firstName || existing.firstName || '',
      lastName: body.lastName || existing.lastName || '',
      email: body.email || existing.email || '',
      birthday: body.birthday || existing.birthday || '',
      address: body.address || existing.address || '',
      photo: photo,
      inLeaderboard: inLeaderboard,
      showPhotoOnCard: showPhotoOnCard,
      updatedAt: Date.now()
    };
    persistSoon();
    // Broadcast aux caisses connectées
    broadcast(null, { type: 'state', data: sharedState });
    return jsonRes(res, 200, { ok: true });
  }

  // ─── /api/leaderboard : Top 10 des plus gros acheteurs (opt-in seulement) ───
  if (req.method === 'GET' && pathname === '/api/leaderboard') {
    const requesterPhone = normalizePhone(url.searchParams.get('phone') || '');
    const customers = sharedState.customers || {};
    // Calcule le total dépensé par client à partir des commandes
    const orders = sharedState.orders || [];
    const spentByPhone = {};
    const ordersByPhone = {};
    for (const o of orders) {
      if (o.status !== 'terminee') continue;
      const ph = normalizePhone((o.customer && o.customer.phone) || '');
      if (!ph) continue;
      spentByPhone[ph] = (spentByPhone[ph] || 0) + (o.total || 0);
      ordersByPhone[ph] = (ordersByPhone[ph] || 0) + 1;
    }
    // Construit la liste complète et trie
    const all = Object.keys(spentByPhone).map(ph => {
      const c = customers[ph] || {};
      const optIn = !!c.inLeaderboard;
      const firstName = (c.firstName || '').trim();
      const lastName = (c.lastName || '').trim();
      const displayName = optIn
        ? ((firstName + (lastName ? ' ' + lastName.charAt(0).toUpperCase() + '.' : '')) || 'Anonyme')
        : 'Anonyme';
      return {
        phone: ph,
        displayName: displayName,
        photo: (optIn && c.photo) ? c.photo : '',
        anonymous: !optIn,
        totalSpent: Math.round(spentByPhone[ph] * 100) / 100,
        orderCount: ordersByPhone[ph] || 0,
        isMe: ph === requesterPhone
      };
    }).sort((a, b) => b.totalSpent - a.totalSpent);
    // Top 10
    const top10 = all.slice(0, 10).map((c, i) => ({ ...c, rank: i + 1 }));
    // Position du demandeur s'il est en dehors du top 10
    let myEntry = null;
    if (requesterPhone) {
      const myIdx = all.findIndex(c => c.phone === requesterPhone);
      if (myIdx >= 10) {
        myEntry = { ...all[myIdx], rank: myIdx + 1 };
      }
    }
    return jsonRes(res, 200, {
      top: top10,
      me: myEntry,
      totalParticipants: all.filter(c => !c.anonymous).length,
      totalCustomers: all.length
    });
  }

  // ─── /api/has-push : vérifie si un téléphone a déjà la PWA installée ───
  // Permet à la caisse de savoir s'il faut inviter le client à installer la PWA
  if (req.method === 'GET' && pathname === '/api/has-push') {
    const phone = (url.searchParams.get('phone') || '').trim();
    if (!phone) return jsonRes(res, 400, { error: 'phone required' });
    const phoneNorm = normalizePhone(phone);
    const subs = subscriptions[phoneNorm];
    const hasPush = !!(subs && subs.length > 0);
    return jsonRes(res, 200, { has: hasPush, count: hasPush ? subs.length : 0 });
  }

  // ─── /api/wheel-win : un client a gagné à la roue de la chance ───
  // Enregistre le code promo côté caisse pour qu'il soit reconnu à l'utilisation
  if (req.method === 'POST' && pathname === '/api/wheel-win') {
    try {
      const body = await readBody(req);
      if (!body || !body.phone || !body.code) {
        return jsonRes(res, 400, { error: 'phone et code requis' });
      }
      const phoneNorm = normalizePhone(body.phone);
      const code = sanitizeString(String(body.code), 50).toUpperCase();
      const value = parseFloat(body.value);
      const type = body.type === '%' ? '%' : '€';

      if (!code || isNaN(value) || value <= 0 || value > 100) {
        return jsonRes(res, 400, { error: 'code/value invalides' });
      }

      // Vérifier qu'on n'a pas déjà ce code
      if (!Array.isArray(sharedState.promoCodes)) sharedState.promoCodes = [];
      const exists = sharedState.promoCodes.find(p => p.code === code);
      if (exists) return jsonRes(res, 200, { ok: true, alreadyExists: true });

      // Anti-abus : pas plus de 10 gains par client en 7j
      const oneWeekAgo = Date.now() - 7 * 86400000;
      const recentWins = sharedState.promoCodes.filter(p =>
        p.ownerPhone === phoneNorm &&
        p.note && p.note.includes('Roue de la chance') &&
        p.createdAt > oneWeekAgo
      );
      if (recentWins.length >= 10) {
        return jsonRes(res, 429, { error: 'too many wins' });
      }

      sharedState.promoCodes.push({
        code: code,
        type: type,
        value: value,
        maxUses: 1,
        uses: 0,
        expires: Date.now() + 30 * 86400000, // 30 jours
        ownerPhone: phoneNorm, // restreint à ce client
        createdAt: Date.now(),
        note: 'Roue de la chance'
      });
      persistSoon();
      broadcast(null, { type: 'state', data: sharedState });
      console.log(`🎰 Roue de la chance : ${body.phone} a gagné ${value}${type} (code ${code})`);
      return jsonRes(res, 200, { ok: true });
    } catch (e) {
      console.error('wheel-win error:', e.message);
      return jsonRes(res, 400, { error: 'invalid request' });
    }
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
          desc: p.desc || '',
          price: p.price,
          photo: p.photo || null,
          stock: p.stock,
          config: p.config || null,  // Configurations options (taille, sauces, suppléments, boissons...)
          // Champs pour les accompagnements et formules (Poulet, Brochette, Plateau)
          accompCount: p.accompCount || undefined,            // rétrocompat
          grandAccompCount: p.grandAccompCount || undefined,
          petitAccompCount: p.petitAccompCount || undefined,
          drinkCount: p.drinkCount || undefined,
          accompFormulas: p.accompFormulas || undefined,
          // Sous-catégorie (utile pour grouper Poulet / Brochette / Plateau)
          subCategory: p.subCategory || undefined,
          // Indique si le produit est entièrement non-personnalisable
          noCustomization: p.noCustomization || undefined
        }));
      }
    }
    const config = sharedState.config || {};
    // ★ Convertit le nouveau format des horaires (objet par jour) vers l'ancien
    // format attendu par la PWA (clés courtes + tableau de plages "HH:MM-HH:MM")
    function convertOpenHoursForPwa(rawHours) {
      const fallback = {
        mon: ['11:30-14:30','18:00-22:30'],
        tue: ['11:30-14:30','18:00-22:30'],
        wed: ['11:30-14:30','18:00-22:30'],
        thu: ['11:30-14:30','18:00-22:30'],
        fri: ['11:30-14:30','18:00-23:00'],
        sat: ['11:30-14:30','18:00-23:00'],
        sun: []
      };
      if (!rawHours || typeof rawHours !== 'object') return fallback;
      // Mapping des clés longues → clés courtes
      const map = { monday:'mon', tuesday:'tue', wednesday:'wed', thursday:'thu', friday:'fri', saturday:'sat', sunday:'sun' };
      const out = {};
      let foundAny = false;
      for (const longKey in map) {
        const shortKey = map[longKey];
        const day = rawHours[longKey];
        // Détecte le nouveau format : { open: bool, service1: {start,end}, service2: {start,end} }
        if (day && typeof day === 'object' && !Array.isArray(day)) {
          foundAny = true;
          if (!day.open) {
            out[shortKey] = [];
            continue;
          }
          const ranges = [];
          if (day.service1 && day.service1.start && day.service1.end) {
            ranges.push(`${day.service1.start}-${day.service1.end}`);
          }
          if (day.service2 && day.service2.start && day.service2.end) {
            ranges.push(`${day.service2.start}-${day.service2.end}`);
          }
          out[shortKey] = ranges;
        }
        // Ancien format : on garde tel quel
        else if (Array.isArray(rawHours[shortKey])) {
          foundAny = true;
          out[shortKey] = rawHours[shortKey];
        }
        else if (Array.isArray(day)) {
          foundAny = true;
          out[shortKey] = day;
        }
      }
      // Si aucune clé trouvée (config vide), on renvoie le fallback
      return foundAny ? out : fallback;
    }
    return jsonRes(res, 200, {
      menu: filtered,
      openHours: convertOpenHoursForPwa(config.openHours),
      // ★ Config roue de la chance (personnalisable depuis la caisse)
      wheelConfig: (config.wheelEnabled !== false) ? {
        enabled: true,
        cooldownDays: config.wheelCooldownDays || 7,
        sectors: config.wheelSectors || null  // null = utilise les valeurs par défaut côté PWA
      } : { enabled: false }
    });
  }

  // ─── /api/order : nouvelle commande depuis la PWA ───
  if (req.method === 'POST' && pathname === '/api/order') {
    let body;
    try { body = await readBody(req); } catch (e) { return jsonRes(res, 400, { error: 'invalid body' }); }

    const phone = normalizePhone(body.phone || '');
    if (!phone || phone.length < 6 || phone.length > 20) {
      return jsonRes(res, 400, { error: 'téléphone invalide' });
    }
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return jsonRes(res, 400, { error: 'panier vide' });
    }
    if (body.items.length > MAX_ITEMS_PER_ORDER) {
      return jsonRes(res, 400, { error: `trop d'articles (max ${MAX_ITEMS_PER_ORDER})` });
    }
    const validTypes = ['emporter', 'livraison', 'sur_place'];
    if (!validTypes.includes(body.type)) {
      return jsonRes(res, 400, { error: 'type invalide' });
    }
    // Validation slot (format HH:MM)
    if (body.slot && !/^[0-2]\d:[0-5]\d$/.test(body.slot)) {
      return jsonRes(res, 400, { error: 'format heure invalide' });
    }
    // Validation note
    body.note = sanitizeString(body.note, MAX_NOTE_LENGTH);

    // Limite anti-spam : on ne compte QUE les commandes en attente de traitement actif
    // (pas celles déjà prêtes ou en livraison qui sont juste en attente de récupération/livraison)
    const pendingCount = (sharedState.orders || []).filter(o => {
      // Commande non terminée et non annulée
      if (o.status === 'terminee' || o.status === 'annulee') return false;
      // En attente confirmation manager (PWA)
      if (o.awaitingConfirmation) return true;
      // En cours de préparation cuisine (kdsStatus pas encore 'prete' ni 'servie')
      if (o.status === 'en_cours' && o.kdsStatus !== 'prete' && o.kdsStatus !== 'servie') return true;
      // Déjà en livraison ou prête : ne compte pas (n'occupe plus de bande passante)
      return false;
    }).length;
    if (pendingCount >= MAX_PENDING_ORDERS) {
      return jsonRes(res, 503, { error: 'trop de commandes en attente, réessayez dans quelques minutes' });
    }

    // Numéro de commande (atomique grâce au single-thread Node)
    if (typeof sharedState.counter !== 'number') sharedState.counter = 1;
    const orderNumber = sharedState.counter++;
    const orderId = 'pwa_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);

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
      // Validation qty stricte
      let qty = parseInt(i.qty);
      if (!Number.isFinite(qty) || qty < 1) qty = 1;
      if (qty > MAX_QTY_PER_ITEM) qty = MAX_QTY_PER_ITEM;
      // Calcul du prix avec options
      let itemPrice = product.price;
      let optionsLabel = '';
      const incomingOpts = i.options || null;
      if (incomingOpts && typeof incomingOpts === 'object') {
        const labelParts = [];

        // Helper pour valider un objet { label, price } reçu en option
        const validateLabelPrice = (obj, minP, maxP) => {
          if (!obj || typeof obj !== 'object') return null;
          const cleanLabel = sanitizeString(obj.label, 80);
          if (!cleanLabel) return null;
          const min = (typeof minP === 'number') ? minP : 0;
          const max = (typeof maxP === 'number') ? maxP : 100;
          const safePrice = (typeof obj.price === 'number' && Number.isFinite(obj.price) && obj.price >= min && obj.price <= max) ? obj.price : 0;
          return { label: cleanLabel, price: safePrice };
        };

        // 1. Taille / pain (bread)
        const breadObj = validateLabelPrice(incomingOpts.bread, 0, 100);
        if (breadObj) {
          itemPrice += breadObj.price;
          incomingOpts.bread = breadObj;
          labelParts.push(breadObj.label);
        }
        // 2. Base (pizza)
        const baseObj = validateLabelPrice(incomingOpts.base, 0, 100);
        if (baseObj) {
          itemPrice += baseObj.price;
          incomingOpts.base = baseObj;
          labelParts.push('Base : ' + baseObj.label);
        }
        // 3. Menu (panini)
        const menuObj = validateLabelPrice(incomingOpts.menu, 0, 50);
        if (menuObj) {
          itemPrice += menuObj.price;
          incomingOpts.menu = menuObj;
          if (menuObj.label !== 'Sans menu') labelParts.push(menuObj.label);
        }
        // 4. Viande unique (panini, zap'wich)
        const meatObj = validateLabelPrice(incomingOpts.meat, 0, 30);
        if (meatObj) {
          itemPrice += meatObj.price;
          incomingOpts.meat = meatObj;
          labelParts.push('Viande : ' + meatObj.label);
        }
        // 5. Viandes multiples (tacos / bowls 2v / 3v)
        if (Array.isArray(incomingOpts.meats)) {
          incomingOpts.meats = incomingOpts.meats.slice(0, 5).map(m => {
            if (m && typeof m === 'object') {
              const cleanLabel = sanitizeString(m.label, 80);
              if (cleanLabel) return { label: cleanLabel };
            }
            return null;
          }).filter(Boolean);
          if (incomingOpts.meats.length > 0) {
            labelParts.push('Viandes : ' + incomingOpts.meats.map(m => m.label).join(', '));
          }
        }
        // 5bis. Accompagnements (poulet braisé, brochettes) — pas de prix (inclus)
        if (Array.isArray(incomingOpts.accompagnements)) {
          incomingOpts.accompagnements = incomingOpts.accompagnements.slice(0, 5).map(a => {
            if (a && typeof a === 'object') {
              const cleanLabel = sanitizeString(a.label, 80);
              if (cleanLabel) return { label: cleanLabel };
            }
            return null;
          }).filter(Boolean);
          if (incomingOpts.accompagnements.length > 0) {
            labelParts.push('Accompagnements : ' + incomingOpts.accompagnements.map(a => a.label).join(', '));
          }
        }
        // 6. Sauce fromagère (oui/non)
        if (typeof incomingOpts.cheeseSauce === 'boolean') {
          labelParts.push(incomingOpts.cheeseSauce ? 'Avec sauce fromagère' : 'Sans sauce fromagère');
        } else {
          incomingOpts.cheeseSauce = null;
        }
        // 7. Menu enfant : choix du plat
        const kidsObj = validateLabelPrice(incomingOpts.kidsMenu, 0, 30);
        if (kidsObj) {
          itemPrice += kidsObj.price;
          incomingOpts.kidsMenu = kidsObj;
          labelParts.push('Menu : ' + kidsObj.label);
        }
        // 8. Menu enfant : viande si panini choisi
        const meatPaniniObj = validateLabelPrice(incomingOpts.meatIfPanini, 0, 30);
        if (meatPaniniObj) {
          incomingOpts.meatIfPanini = meatPaniniObj;
          labelParts.push('Panini : ' + meatPaniniObj.label);
        }
        // 9. Sauces (multi-choix)
        if (Array.isArray(incomingOpts.sauces)) {
          incomingOpts.sauces = incomingOpts.sauces.slice(0, 10).map(s => {
            const obj = validateLabelPrice(s, -10, 50);
            if (obj) {
              if (obj.price > 0) itemPrice += obj.price;
              labelParts.push(obj.label);
              return obj;
            }
            return null;
          }).filter(Boolean);
        }
        // 10. Suppléments (multi-choix avec prix)
        if (Array.isArray(incomingOpts.extras)) {
          incomingOpts.extras = incomingOpts.extras.slice(0, 20).map(e => {
            const obj = validateLabelPrice(e, -10, 50);
            if (obj) {
              if (obj.price !== 0) itemPrice += obj.price;
              labelParts.push((obj.price >= 0 ? '+' : '') + obj.label);
              return obj;
            }
            return null;
          }).filter(Boolean);
        }
        // 11. À retirer
        if (Array.isArray(incomingOpts.removed)) {
          incomingOpts.removed = incomingOpts.removed.slice(0, 20).map(r => sanitizeString(r, 80)).filter(Boolean);
          incomingOpts.removed.forEach(r => labelParts.push('Sans ' + r));
        }
        // 12. Boisson
        const drinkObj = validateLabelPrice(incomingOpts.drink, 0, 50);
        if (drinkObj) {
          itemPrice += drinkObj.price;
          incomingOpts.drink = drinkObj;
          labelParts.push('Boisson : ' + drinkObj.label);
        } else {
          incomingOpts.drink = null;
        }
        // 13. Commentaire
        if (typeof incomingOpts.comment === 'string') {
          incomingOpts.comment = sanitizeString(incomingOpts.comment, 200);
          if (incomingOpts.comment) labelParts.push('Note : ' + incomingOpts.comment);
        }
        optionsLabel = labelParts.join(' · ');
      }
      // Garde-fou prix anormal
      if (itemPrice < 0) itemPrice = product.price;
      if (itemPrice > product.price * 10 + 200) itemPrice = product.price; // anti-arnaque
      total += itemPrice * qty;
      items.push({
        id: product.id,
        name: product.name,
        price: itemPrice,
        qty: qty,
        options: incomingOpts,
        optionsLabel: optionsLabel,
        customizationLabel: optionsLabel  // alias pour compatibilité affichage caisse
      });
    }
    if (items.length === 0) {
      return jsonRes(res, 400, { error: 'aucun produit valide' });
    }
    // Garde-fou total
    if (total > 100000) {
      return jsonRes(res, 400, { error: 'montant trop élevé' });
    }

    // Mettre à jour la fiche client
    if (!sharedState.customers) sharedState.customers = {};
    const cust = sharedState.customers[phone] || { phone, points: 0, orderCount: 0, createdAt: Date.now() };
    if (body.customer) {
      cust.firstName = sanitizeString(body.customer.firstName, 80) || cust.firstName || '';
      cust.lastName = sanitizeString(body.customer.lastName, 80) || cust.lastName || '';
      cust.email = sanitizeString(body.customer.email, 120) || cust.email || '';
      if (body.customer.address) cust.address = sanitizeString(body.customer.address, 200);
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
      // ★ Pré-commande J+1 : si forTomorrow=true, le créneau est pour le lendemain
      forTomorrow: !!body.forTomorrow,
      scheduledFor: body.scheduledFor || null,
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
      // Calculer l'étape actuelle selon le type
      // Champs réels utilisés par la caisse :
      //  - awaitingConfirmation : en attente confirmation (commande PWA)
      //  - confirmedAt : timestamp confirmation
      //  - kdsStatus = 'prete' + kdsReadyAt : cuisine a marqué prête
      //  - status = 'en_livraison' + takenAt : livreur a pris la commande
      //  - status = 'terminee' + closedAt : commande terminée
      let stage = 'received';
      if (o.awaitingConfirmation) {
        stage = 'received';
      } else if (o.status === 'terminee') {
        stage = 'completed';
      } else if (o.type === 'livraison') {
        // Pour les livraisons : reçue → confirmée → préparation → en livraison → livrée
        if (o.status === 'en_livraison') stage = 'delivering';
        else if (o.kdsStatus === 'prete') stage = 'preparing'; // prête mais pas encore livreur, on garde "préparation"
        else if (o.kdsStatus || o.confirmedAt) stage = 'preparing';
        else stage = 'confirmed';
      } else {
        // Pour à emporter / sur place : reçue → confirmée → préparation → prête → récupérée
        if (o.kdsStatus === 'servie') stage = 'completed';
        else if (o.kdsStatus === 'prete') stage = 'ready';
        else if (o.kdsStatus || o.confirmedAt) stage = 'preparing';
        else stage = 'confirmed';
      }
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
        takenAt: o.takenAt || null,
        closedAt: o.closedAt || null,
        refusedReason: o.refusedReason || null,
        awaitingConfirmation: !!o.awaitingConfirmation,
        // Adresse de livraison (pour la carte)
        deliveryAddress: (o.customer && o.customer.address) || null,
        // Position du livreur (uniquement quand commande en livraison)
        livreurPosition: (o.status === 'en_livraison' && sharedState.livreurPosition) ? {
          lat: sharedState.livreurPosition.lat,
          lon: sharedState.livreurPosition.lon,
          ts: sharedState.livreurPosition.ts,
          livreurName: sharedState.livreurPosition.livreurName
        } : null,
        // Position du restaurant (pour la carte) - configurable
        restoPosition: (sharedState.config && sharedState.config.restoPosition)
          ? sharedState.config.restoPosition
          : { lat: 48.7244, lon: 4.5840, name: 'Le 832 Vitry-le-François' }
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

  // ─── /api/events : Server-Sent Events pour le suivi temps réel PWA ───
  // La PWA s'abonne avec ?phone=XXX et reçoit ping immédiatement
  // chaque fois que ses commandes changent d'état
  if (req.method === 'GET' && pathname === '/api/events') {
    const phone = normalizePhone(url.searchParams.get('phone') || '');
    if (!phone || phone.length < 6) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: 'phone requis' }));
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // désactive le buffering nginx/render
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Envoyer un commentaire pour ouvrir le flux
    res.write(': connected\n\n');

    // Référencer ce client SSE
    if (!sseClients) sseClients = new Map();
    if (!sseClients.has(phone)) sseClients.set(phone, new Set());
    const set = sseClients.get(phone);
    const client = { res, lastSent: Date.now() };
    set.add(client);

    // Heartbeat pour éviter timeout proxy (toutes les 25s)
    const heartbeat = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch (e) {}
    }, 25000);

    // Envoyer l'état initial des commandes du client
    try {
      const myOrders = (sharedState.orders || []).filter(o =>
        o.customer && normalizePhone(o.customer.phone) === phone
      );
      const minimal = myOrders.map(o => ({ id: o.id, number: o.number, status: o.status, awaitingConfirmation: !!o.awaitingConfirmation, kdsStatus: o.kdsStatus || null }));
      res.write('event: snapshot\ndata: ' + JSON.stringify(minimal) + '\n\n');
    } catch (e) { /* silencieux */ }

    // Cleanup à la déconnexion
    req.on('close', () => {
      clearInterval(heartbeat);
      try { set.delete(client); } catch (e) {}
      if (set.size === 0) sseClients.delete(phone);
    });
    return;
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

  // ═══════════════════════════════════════════════════════════════════
  // ★ BOT TÉLÉPHONIQUE VAPI.AI — Endpoints /api/voice/*
  // ═══════════════════════════════════════════════════════════════════

  // POST /api/voice/menu — récupère le menu pour le bot
  if (req.method === 'POST' && pathname === '/api/voice/menu') {
    if (!checkVapiAuth(req, res)) return;
    if (!voiceBotEnabled) return jsonRes(res, 200, { result: 'Bot désactivé', items: [] });
    const menu = (sharedState && sharedState.menu) ? sharedState.menu : [];
    const items = menu
      .filter(p => !p.outOfStock && p.visible !== false)
      .map(p => ({
        id: p.id,
        name: p.name,
        category: p.category || '',
        price: p.price,
        description: p.description || '',
        hasOptions: !!(p.options && Object.keys(p.options).length > 0)
      }));
    const grouped = {};
    items.forEach(p => {
      const c = p.category || 'Autres';
      if (!grouped[c]) grouped[c] = [];
      grouped[c].push({ id: p.id, name: p.name, price: p.price, hasOptions: p.hasOptions });
    });
    return jsonRes(res, 200, {
      result: 'Menu transmis',
      categories: Object.keys(grouped),
      items: items,
      grouped: grouped,
      totalProducts: items.length
    });
  }

  // POST /api/voice/check-zone — vérifie si une adresse est dans la zone de livraison
  if (req.method === 'POST' && pathname === '/api/voice/check-zone') {
    if (!checkVapiAuth(req, res)) return;
    let data = {};
    try { data = await readBody(req); } catch (e) { return jsonRes(res, 400, { error: 'invalid body' }); }
    const address = data.address || '';
    if (!address) return jsonRes(res, 200, { ok: false, reason: 'Adresse manquante', deliverable: false });
    const geo = await geocodeAddress(address);
    if (!geo) {
      return jsonRes(res, 200, {
        ok: false,
        deliverable: false,
        reason: "Je n'arrive pas à trouver cette adresse. Pourriez-vous la répéter ou préciser la ville ?",
        address: address
      });
    }
    const distKm = haversineKm(RESTO_LOCATION.lat, RESTO_LOCATION.lon, geo.lat, geo.lon);
    const distRounded = Math.round(distKm * 10) / 10;
    const deliverable = distKm <= DELIVERY_MAX_KM;
    return jsonRes(res, 200, {
      ok: true,
      address: address,
      geocoded: geo.displayName,
      distanceKm: distRounded,
      maxKm: DELIVERY_MAX_KM,
      deliverable: deliverable,
      reason: deliverable
        ? `Adresse à ${distRounded} km, dans notre zone de livraison.`
        : `Cette adresse est à ${distRounded} km, hors de notre zone de livraison de ${DELIVERY_MAX_KM} km. Je peux vous proposer la commande à emporter.`,
      coords: { lat: geo.lat, lon: geo.lon }
    });
  }

  // POST /api/voice/order — crée une commande à valider depuis le bot
  if (req.method === 'POST' && pathname === '/api/voice/order') {
    if (!checkVapiAuth(req, res)) return;
    if (!voiceBotEnabled) return jsonRes(res, 503, { ok: false, reason: 'Bot désactivé' });
    let data = {};
    try { data = await readBody(req); } catch (e) { return jsonRes(res, 400, { error: 'invalid body' }); }
    const { customer, type, items, total, callDuration, slot, callId, note } = data;
    if (!type || !Array.isArray(items) || items.length === 0) {
      return jsonRes(res, 400, { ok: false, reason: 'Données invalides : type ou items manquants' });
    }
    if (type === 'livraison' && (!customer || !customer.address)) {
      return jsonRes(res, 400, { ok: false, reason: 'Adresse requise pour livraison' });
    }
    // Crée la commande
    if (!sharedState.orders) sharedState.orders = [];
    if (typeof sharedState.counter !== 'number') sharedState.counter = 1;
    const number = sharedState.counter++;
    const order = {
      id: 'voice_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      number: number,
      source: 'voice',
      awaitingValidation: true,
      voiceCallId: callId || null,
      voiceCallDuration: callDuration || null,
      type: type,
      status: 'en_attente',
      items: items.map(i => ({
        id: i.id,
        name: i.name,
        qty: i.qty || 1,
        price: i.price || 0,
        customizationLabel: i.customization || i.customizationLabel || '',
        comment: i.comment || ''
      })),
      customer: customer || {},
      total: typeof total === 'number' ? total : items.reduce((s, i) => s + (i.price || 0) * (i.qty || 1), 0),
      slot: slot || null,
      note: note || '',
      payment: { method: 'en_attente', paid: false },
      createdAt: Date.now()
    };
    sharedState.orders.unshift(order);

    // ★ Auto-création / mise à jour du client dans la base
    try {
      if (customer && customer.phone) {
        if (!sharedState.customers) sharedState.customers = {};
        const phoneNorm = String(customer.phone).replace(/\D/g, '').slice(-10);
        if (phoneNorm) {
          const existing = sharedState.customers[phoneNorm];
          if (!existing) {
            // Nouveau client : on le crée
            sharedState.customers[phoneNorm] = {
              phone: customer.phone,
              phoneNorm: phoneNorm,
              firstName: customer.firstName || '',
              lastName: customer.lastName || '',
              address: customer.address || '',
              source: 'voice',
              firstSeenAt: Date.now(),
              lastSeenAt: Date.now(),
              orderCount: 1,
              totalSpent: order.total || 0,
              loyaltyPoints: 0,
              tags: [],
              notes: 'Client créé automatiquement via bot téléphonique'
            };
            console.log('✓ Nouveau client créé via bot vocal:', customer.firstName, customer.lastName, '(' + customer.phone + ')');
          } else {
            // Client existant : on met à jour les infos
            existing.lastSeenAt = Date.now();
            existing.orderCount = (existing.orderCount || 0) + 1;
            existing.totalSpent = (existing.totalSpent || 0) + (order.total || 0);
            // Compléter les infos si manquantes
            if (!existing.firstName && customer.firstName) existing.firstName = customer.firstName;
            if (!existing.lastName && customer.lastName) existing.lastName = customer.lastName;
            if (!existing.address && customer.address) existing.address = customer.address;
            console.log('✓ Client existant mis à jour via bot vocal:', existing.firstName, '(' + customer.phone + ')');
          }
        }
      }
    } catch (e) { console.error('Erreur auto-création client:', e); }

    // Persist state
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(sharedState, null, 2)); } catch (e) {}
    // Broadcast WS : envoyer le nouvel état complet aux caisses
    try {
      const payload = JSON.stringify({ type: 'state', data: sharedState });
      wss.clients.forEach(client => {
        if (client.readyState === 1) {
          try { client.send(payload); } catch (e) {}
        }
      });
    } catch (e) {}
    return jsonRes(res, 200, {
      ok: true,
      orderId: order.id,
      orderNumber: order.number,
      message: `Commande N°${order.number} enregistrée, elle sera confirmée par le restaurant.`
    });
  }

  // POST /api/voice/check-stock — vérifie la dispo d'un produit
  if (req.method === 'POST' && pathname === '/api/voice/check-stock') {
    if (!checkVapiAuth(req, res)) return;
    let data = {};
    try { data = await readBody(req); } catch (e) { return jsonRes(res, 400, { error: 'invalid body' }); }
    const { productId, productName } = data;
    const menu = (sharedState && sharedState.menu) || [];
    let product = null;
    if (productId) product = menu.find(p => p.id === productId);
    else if (productName) {
      const q = productName.toLowerCase();
      product = menu.find(p => (p.name || '').toLowerCase() === q)
             || menu.find(p => (p.name || '').toLowerCase().includes(q));
    }
    if (!product) return jsonRes(res, 200, { ok: false, available: false, reason: 'Je ne trouve pas ce produit dans notre menu.' });
    const available = !product.outOfStock && product.visible !== false;
    return jsonRes(res, 200, {
      ok: true,
      productId: product.id,
      productName: product.name,
      price: product.price,
      available: available,
      reason: available ? `${product.name} est disponible.` : `Je suis désolée, ${product.name} n'est plus disponible.`
    });
  }

  // POST /api/voice/hours — horaires actuels
  if (req.method === 'POST' && pathname === '/api/voice/hours') {
    if (!checkVapiAuth(req, res)) return;
    const cfg = (sharedState && sharedState.config) ? sharedState.config : {};
    const now = new Date();
    const dayMap = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
    return jsonRes(res, 200, {
      today: dayMap[now.getDay()],
      currentTime: now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
      midi: { start: cfg.midiStart || '11:30', end: cfg.midiEnd || '14:30' },
      soir: { start: cfg.soirStart || '18:30', end: cfg.soirEnd || '22:30' },
      isOpenNow: !!cfg.restoOpen,
      message: cfg.restoOpen
        ? 'Nous sommes actuellement ouverts.'
        : 'Le restaurant est actuellement fermé, mais je peux prendre votre commande pour le prochain service.'
    });
  }

  // GET/POST /api/voice/bot-status — toggle ON/OFF
  if (req.method === 'GET' && pathname === '/api/voice/bot-status') {
    return jsonRes(res, 200, { enabled: voiceBotEnabled });
  }
  if (req.method === 'POST' && pathname === '/api/voice/bot-status') {
    let data = {};
    try { data = await readBody(req); } catch (e) { return jsonRes(res, 400, { error: 'invalid body' }); }
    if (typeof data.enabled === 'boolean') voiceBotEnabled = data.enabled;
    return jsonRes(res, 200, { enabled: voiceBotEnabled });
  }

  // POST /api/voice/recognize-customer — reconnaît un client par téléphone
  if (req.method === 'POST' && pathname === '/api/voice/recognize-customer') {
    if (!checkVapiAuth(req, res)) return;
    let data = {};
    try { data = await readBody(req); } catch (e) { return jsonRes(res, 400, { error: 'invalid body' }); }
    const { phone } = data;
    if (!phone) return jsonRes(res, 200, { ok: false, recognized: false });
    const customers = (sharedState && sharedState.customers) || {};
    const norm = String(phone).replace(/\D/g, '').slice(-10);
    let found = null;
    Object.values(customers).forEach(c => {
      const cNorm = String(c.phone || '').replace(/\D/g, '').slice(-10);
      if (cNorm === norm) found = c;
    });
    if (!found) return jsonRes(res, 200, { ok: true, recognized: false });
    return jsonRes(res, 200, {
      ok: true,
      recognized: true,
      firstName: found.firstName || '',
      lastName: found.lastName || '',
      address: found.address || '',
      loyaltyPoints: found.loyaltyPoints || 0,
      message: `Bonjour ${found.firstName || ''}, content de vous entendre.`
    });
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
      const oldOrders = sharedState.orders || [];
      const oldOpenHours = JSON.stringify((sharedState.config && sharedState.config.openHours) || {});
      const oldMenu = JSON.stringify(sharedState.menu || {});
      sharedState = msg.data;
      // Détection des changements et envoi des notifications PWA
      try { detectOrderChangesAndNotify(oldOrders, sharedState.orders || []); }
      catch (e) { console.error('Erreur notif PWA:', e.message); }
      // ★ Détection changement d'horaires ou de menu : broadcast SSE à toutes les PWA
      // pour qu'elles rafraîchissent immédiatement (au lieu d'attendre le polling 60s)
      try {
        const newOpenHours = JSON.stringify((sharedState.config && sharedState.config.openHours) || {});
        const newMenu = JSON.stringify(sharedState.menu || {});
        if (newOpenHours !== oldOpenHours || newMenu !== oldMenu) {
          broadcastSseToAll({ type: 'menu-updated', ts: Date.now() });
        }
      } catch (e) { console.error('Broadcast SSE menu-updated échoué:', e.message); }
      persistSoon();
      broadcast(ws, { type: 'state', data: sharedState });
    }

    // ★ NOUVEAU : campagne de relance clients inactifs
    // Reçoit un message par client à relancer, envoie push (ou demande SMS si pas PWA)
    if (msg.type === 'relance_send' && msg.phone && msg.code) {
      try {
        const valLabel = msg.type === '€' ? msg.value + ' €' : msg.value + ' %';
        const validityTxt = msg.validity ? ` valable ${msg.validity} jours` : '';
        const restName = msg.restaurantName || 'LE 832 FOOD';
        const firstName = (msg.firstName || '').trim();
        const greeting = firstName ? `Bonjour ${firstName} ! ` : 'Bonjour ! ';
        const title = `🎁 Vous nous manquez !`;
        const body = `${greeting}Profitez de -${valLabel} avec le code ${msg.code}${validityTxt}. À très vite chez ${restName} !`;

        // Tente d'abord le push (gratuit). Si pas d'abonnement push pour ce numéro,
        // demande au Mac d'ouvrir l'app SMS (broadcastSmsRequest)
        const phoneNorm = normalizePhone(msg.phone);
        const subs = subscriptions[phoneNorm];
        if (subs && subs.length > 0) {
          // Le client a la PWA → push
          sendPushTo(msg.phone, title, body, { code: msg.code, type: 'relance' })
            .then(() => console.log(`✓ Push relance envoyé à ${msg.phone}`))
            .catch(e => console.error('Push relance failed:', e.message));
        } else {
          // Pas de PWA → demande SMS au Mac
          broadcastSmsRequest(msg.phone, body, { code: msg.code, type: 'relance' });
          console.log(`✓ SMS relance demandé pour ${msg.phone}`);
        }
      } catch (e) {
        console.error('relance_send error:', e.message);
      }
    }

    // ★ NEWSLETTER : envoie push aux PWA, SMS aux autres
    if (msg.type === 'newsletter_send' && msg.phone && msg.body) {
      try {
        const phoneNorm = normalizePhone(msg.phone);
        const subs = subscriptions[phoneNorm];
        const title = msg.title || '📨 LE 832 FOOD';
        if (subs && subs.length > 0) {
          // PWA → push
          sendPushTo(msg.phone, title, msg.body, { type: 'newsletter' })
            .then(() => console.log(`✓ Push newsletter envoyé à ${msg.phone}`))
            .catch(e => console.error('Push newsletter failed:', e.message));
        } else {
          // Pas de PWA → SMS
          broadcastSmsRequest(msg.phone, msg.body, { type: 'newsletter' });
          console.log(`✓ SMS newsletter demandé pour ${msg.phone}`);
        }
      } catch (e) {
        console.error('newsletter_send error:', e.message);
      }
    }
  });
  ws.on('close', () => console.log(`← Déconnexion (total : ${wss.clients.size})`));
  ws.on('error', (e) => console.error('WS error:', e.message));
});

server.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   LE 832 FOOD — Sync + Carte fidélité PWA        ║');
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
