import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getCached, setCached, invalidateCached, upsertProduct, markProductUsed, recentProducts, frequentProducts
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_FILE = path.join(__dirname, 'data', 'session.json');
const API_BASE = 'https://api.vivica.health';
const APP_VERSION = '1.63.0'; // matches window.application_version in the app's config.js; the API
                               // gates all requests on this header and 403s with an "update required"
                               // payload if it's missing/stale
const PORT = process.env.PORT || 4173;

const DAY_MS = 24 * 60 * 60 * 1000;
const STATS_TTL_MS = 30 * 60 * 1000; // day stats are cached, but short-lived: they can change from
                                      // the mobile app too, and we explicitly invalidate on our own writes

// --- session (bearer token) persistence, single local user, kept server-side only ---
let session = { access_token: null, user: null };
try {
  session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
} catch { /* no session yet */ }

function saveSession() {
  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session));
}

// --- upstream fetch helper ---
async function upstream(method, urlPath, body) {
  const headers = {
    'Accept': 'application/json',
    'Native-Application-Version': APP_VERSION,
    'Application-Version': APP_VERSION
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (session.access_token) headers['Authorization'] = `Bearer ${session.access_token}`;

  const res = await fetch(API_BASE + urlPath, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });

  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  return { status: res.status, ok: res.ok, data };
}

function requireAuth(res) {
  if (!session.access_token) {
    sendJson(res, 401, { error: 'not_authenticated' });
    return false;
  }
  return true;
}

// --- tiny http helpers ---
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end(); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, data2) => {
        if (err2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(data2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

// --- route handlers ---

async function handleLogin(req, res) {
  const body = await readJsonBody(req);
  const result = await upstream('POST', '/auth/login', {
    email: body.email,
    password: body.password,
    authCodeRequested: body.authCodeRequested || false,
    token: body.token || '',
    lang: ''
  });

  if (result.ok) {
    session.access_token = result.data.access_token;
    session.user = result.data.user;
    saveSession();
    sendJson(res, 200, { ok: true, user: result.data.user });
    return;
  }

  if (result.status === 422 && result.data?.message === 'auth_code sent') {
    sendJson(res, 200, { ok: false, needs2fa: true, method: 'email' });
    return;
  }
  if (result.status === 422 && result.data?.message === 'google_auth_code expected') {
    sendJson(res, 200, { ok: false, needs2fa: true, method: 'google_auth' });
    return;
  }

  sendJson(res, result.status || 400, { ok: false, error: result.data?.message || 'login_failed', errors: result.data?.errors });
}

async function handleLogout(req, res) {
  if (session.access_token) {
    await upstream('POST', '/auth/logout').catch(() => {});
  }
  session = { access_token: null, user: null };
  saveSession();
  sendJson(res, 200, { ok: true });
}

async function handleMe(req, res) {
  if (!requireAuth(res)) return;
  const cacheKey = 'auth:me';
  const cached = getCached(cacheKey, 60 * 60 * 1000); // 1h, this barely changes
  if (cached) { sendJson(res, 200, cached); return; }

  const result = await upstream('POST', '/auth/me');
  if (!result.ok) {
    if (result.status === 401) { session = { access_token: null, user: null }; saveSession(); }
    sendJson(res, result.status, result.data);
    return;
  }
  const dayParts = Object.keys(result.data.nutrient_schedule_cycles || {});
  const payload = { user: result.data.user, day_parts: dayParts };
  setCached(cacheKey, payload);
  sendJson(res, 200, payload);
}

async function handleMedicalForm(req, res) {
  if (!requireAuth(res)) return;
  const cacheKey = 'auth:medical_form';
  const cached = getCached(cacheKey, 60 * 60 * 1000);
  if (cached) { sendJson(res, 200, cached); return; }

  const result = await upstream('GET', '/auth/medical_form');
  if (!result.ok) { sendJson(res, result.status, result.data); return; }
  setCached(cacheKey, result.data);
  sendJson(res, 200, result.data);
}

async function handleCompanyInfo(req, res) {
  if (!requireAuth(res)) return;
  const cacheKey = 'auth:company_info';
  const cached = getCached(cacheKey, 60 * 60 * 1000);
  if (cached) { sendJson(res, 200, cached); return; }

  const result = await upstream('GET', '/auth/company_info');
  if (!result.ok) { sendJson(res, result.status, result.data); return; }
  setCached(cacheKey, result.data);
  sendJson(res, 200, result.data);
}

async function handleNutritionSearch(req, res) {
  if (!requireAuth(res)) return;
  const body = await readJsonBody(req);
  const cacheKey = 'search:' + JSON.stringify(body);
  const cached = getCached(cacheKey, DAY_MS);
  if (cached) { sendJson(res, 200, cached); return; }

  const result = await upstream('POST', '/patient/nutrition/search', body);
  if (!result.ok) { sendJson(res, result.status, result.data); return; }

  setCached(cacheKey, result.data);
  const items = Array.isArray(result.data.data) ? result.data.data : Object.values(result.data.data || result.data || {});
  for (const item of items) {
    if (item && item.id) upsertProduct(item.type_record || body.type || 'product', item.id, item.description, item);
  }
  sendJson(res, 200, result.data);
}

async function handleSearchNutrientProducts(req, res) {
  if (!requireAuth(res)) return;
  const body = await readJsonBody(req);
  const cacheKey = 'meal_search:' + (body.query || '');
  const cached = getCached(cacheKey, DAY_MS);
  if (cached) { sendJson(res, 200, cached); return; }

  const result = await upstream('POST', '/patient/search_nutrient_products', body);
  if (!result.ok) { sendJson(res, result.status, result.data); return; }

  setCached(cacheKey, result.data);
  const items = Array.isArray(result.data.data) ? result.data.data : [];
  for (const item of items) {
    if (item && item.id) upsertProduct('product', item.id, item.description, item);
  }
  sendJson(res, 200, result.data);
}

async function handleItemData(req, res) {
  if (!requireAuth(res)) return;
  const body = await readJsonBody(req);
  const cacheKey = `item_data:${body.type}:${body.id}`;
  const cached = getCached(cacheKey, 7 * DAY_MS);
  if (cached) { sendJson(res, 200, cached); return; }

  const result = await upstream('POST', '/patient/nutrition/item_data', {
    type: body.type,
    id: body.id,
    current_time: new Date().toISOString()
  });
  if (!result.ok) { sendJson(res, result.status, result.data); return; }

  setCached(cacheKey, result.data);
  sendJson(res, 200, result.data);
}

async function handleSubmitItem(req, res) {
  if (!requireAuth(res)) return;
  const body = await readJsonBody(req);
  const result = await upstream('POST', '/patient/nutrition/submit_item', body);
  if (result.ok) {
    if (body.id) markProductUsed(body.type_record || 'product', body.id);
    if (body.date) invalidateCached(`stats:${body.date}`);
  }
  sendJson(res, result.status, result.data);
}

async function handleDeleteScheduledItem(req, res) {
  if (!requireAuth(res)) return;
  const body = await readJsonBody(req);
  const result = await upstream('POST', '/patient/nutrition/delete_scheduled_item', {
    id: body.id,
    type: body.type
  });
  if (result.ok && body.date) invalidateCached(`stats:${body.date}`);
  sendJson(res, result.status, result.data);
}

async function handleStats(req, res, query) {
  if (!requireAuth(res)) return;
  const date = query.get('date');
  if (!date) { sendJson(res, 400, { error: 'date is required' }); return; }

  const cacheKey = `stats:${date}`;
  if (!query.get('refresh')) {
    const cached = getCached(cacheKey, STATS_TTL_MS);
    if (cached) { sendJson(res, 200, cached); return; }
  }

  const result = await upstream('POST', '/patient/nutrition/stats', { date });
  if (!result.ok) { sendJson(res, result.status, result.data); return; }

  setCached(cacheKey, result.data);
  sendJson(res, 200, result.data);
}

async function handleCreateProduct(req, res) {
  if (!requireAuth(res)) return;
  const body = await readJsonBody(req);
  const result = await upstream('POST', '/patient/nutrition/nutrient_product_create', body);
  if (result.ok && result.data?.id) {
    upsertProduct('product', result.data.id, body.description, {
      id: result.data.id,
      type_record: 'product',
      description: body.description,
      measuring_unit: body.amount_unit,
      amount: body.amount_value
    });
  }
  sendJson(res, result.status, result.data);
}

async function handleSubmitMeal(req, res) {
  if (!requireAuth(res)) return;
  const body = await readJsonBody(req);
  const result = await upstream('POST', '/patient/submit_nutrient_meal', body);
  sendJson(res, result.status, result.data);
}

async function handleMealsList(req, res, query) {
  if (!requireAuth(res)) return;
  const params = new URLSearchParams(query);
  const result = await upstream('GET', '/patient/nutrient_meals_data?' + params.toString());
  sendJson(res, result.status, result.data);
}

async function handleSupermarketTypes(req, res) {
  if (!requireAuth(res)) return;
  const cacheKey = 'supermarket_types';
  const cached = getCached(cacheKey, 30 * DAY_MS);
  if (cached) { sendJson(res, 200, cached); return; }
  const result = await upstream('GET', '/patient/nutrition/supermarket_types');
  if (!result.ok) { sendJson(res, result.status, result.data); return; }
  setCached(cacheKey, result.data);
  sendJson(res, 200, result.data);
}

function handleRecentProducts(req, res) {
  if (!requireAuth(res)) return;
  sendJson(res, 200, { data: recentProducts(20) });
}

function handleFrequentProducts(req, res) {
  if (!requireAuth(res)) return;
  sendJson(res, 200, { data: frequentProducts(20) });
}

function handleStatus(req, res) {
  sendJson(res, 200, { authenticated: !!session.access_token, user: session.user });
}

// --- router ---
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname, searchParams } = url;

  try {
    if (pathname === '/api/status' && req.method === 'GET') return handleStatus(req, res);
    if (pathname === '/api/login' && req.method === 'POST') return await handleLogin(req, res);
    if (pathname === '/api/logout' && req.method === 'POST') return await handleLogout(req, res);
    if (pathname === '/api/me' && req.method === 'GET') return await handleMe(req, res);
    if (pathname === '/api/medical_form' && req.method === 'GET') return await handleMedicalForm(req, res);
    if (pathname === '/api/company_info' && req.method === 'GET') return await handleCompanyInfo(req, res);
    if (pathname === '/api/nutrition/search' && req.method === 'POST') return await handleNutritionSearch(req, res);
    if (pathname === '/api/nutrition/item_data' && req.method === 'POST') return await handleItemData(req, res);
    if (pathname === '/api/nutrition/submit_item' && req.method === 'POST') return await handleSubmitItem(req, res);
    if (pathname === '/api/nutrition/delete_scheduled_item' && req.method === 'POST') return await handleDeleteScheduledItem(req, res);
    if (pathname === '/api/nutrition/stats' && req.method === 'GET') return await handleStats(req, res, searchParams);
    if (pathname === '/api/search_nutrient_products' && req.method === 'POST') return await handleSearchNutrientProducts(req, res);
    if (pathname === '/api/nutrition/nutrient_product_create' && req.method === 'POST') return await handleCreateProduct(req, res);
    if (pathname === '/api/submit_nutrient_meal' && req.method === 'POST') return await handleSubmitMeal(req, res);
    if (pathname === '/api/nutrient_meals_data' && req.method === 'GET') return await handleMealsList(req, res, searchParams);
    if (pathname === '/api/supermarket_types' && req.method === 'GET') return await handleSupermarketTypes(req, res);
    if (pathname === '/api/products/recent' && req.method === 'GET') return handleRecentProducts(req, res);
    if (pathname === '/api/products/frequent' && req.method === 'GET') return handleFrequentProducts(req, res);

    if (pathname.startsWith('/api/')) { sendJson(res, 404, { error: 'not_found' }); return; }

    serveStatic(req, res, pathname);
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: 'internal_error', message: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Vivica dashboard running at http://localhost:${PORT}`);
});
