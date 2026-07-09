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
const AI_CONFIG_FILE = path.join(__dirname, 'data', 'ai_config.json');
const API_BASE = 'https://api.vivica.health';
const OPENAI_API_BASE = 'https://api.openai.com';
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
const APP_VERSION = process.env.APP_VERSION || '1.63.0'; // matches window.application_version in the
                               // app's config.js; the API gates all requests on this header and
                               // responds 307 with an "update required" payload if it's missing/stale
const PORT = process.env.PORT || 4173;
const HOST = process.env.HOST || '127.0.0.1'; // set HOST=0.0.0.0 to expose on the LAN
const MAX_BODY_BYTES = 1 * 1024 * 1024;

const DAY_MS = 24 * 60 * 60 * 1000;
const STATS_TTL_MS = 30 * 60 * 1000; // day stats are cached, but short-lived: they can change from
                                      // the mobile app too, and we explicitly invalidate on our own writes

// --- session (bearer token) persistence, single local user, kept server-side only ---

// Persist only what the UI needs from the login user payload — the full /auth/me user object also
// carries ssn, auth_token, biometrics and other PHI that must never sit in session.json (mirrors
// the render allowlist in profile.js).
const SESSION_USER_FIELDS = [
  'id', 'first_name', 'last_name', 'nickname', 'initials',
  'preferred_form_of_address', 'email', 'avatar_url', 'language', 'gender'
];
function toSessionUser(user) {
  if (!user || typeof user !== 'object') return null;
  const out = {};
  for (const key of SESSION_USER_FIELDS) {
    if (user[key] !== undefined) out[key] = user[key];
  }
  return out;
}

let session = { access_token: null, user: null };
try {
  const loaded = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  session = { access_token: loaded.access_token || null, user: toSessionUser(loaded.user) };
  saveSession(); // rewrite: scrubs sensitive fields persisted by older versions, tightens file mode
} catch { /* no session yet */ }

function saveSession() {
  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session), { mode: 0o600 });
  fs.chmodSync(SESSION_FILE, 0o600); // { mode } only applies on create; fix pre-existing files
}

// --- AI chat config (OpenAI API key), same on-disk hardening as the session file ---

let aiConfig = { openai_api_key: null, openai_model: null, custom_instructions: null };
try {
  const loaded = JSON.parse(fs.readFileSync(AI_CONFIG_FILE, 'utf8'));
  aiConfig = {
    openai_api_key: loaded.openai_api_key || null,
    openai_model: loaded.openai_model || null,
    custom_instructions: loaded.custom_instructions || null
  };
} catch { /* not configured yet */ }

function saveAiConfig() {
  fs.mkdirSync(path.dirname(AI_CONFIG_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(AI_CONFIG_FILE, JSON.stringify(aiConfig), { mode: 0o600 });
  fs.chmodSync(AI_CONFIG_FILE, 0o600);
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

  // Version gate: when Vivica bumps the required app version, every request gets a 307
  // (or 403) "update required" payload before credentials are even checked. Verified live:
  // { message: { title, buttons, urls, ... }, application_version }. Without this, the UI
  // would show an opaque generic error on every action.
  if ((res.status === 307 || res.status === 403) && data?.message?.urls) {
    return {
      status: 503,
      ok: false,
      data: {
        error: 'app_version_outdated',
        message: `The Vivica API no longer accepts app version ${APP_VERSION} — ` +
          'set the APP_VERSION environment variable to the current Vivica app version and restart the dashboard.'
      }
    };
  }

  return { status: res.status, ok: res.ok, data };
}

// --- OpenAI chat helper ---
async function callOpenAI(messages, model) {
  const res = await fetch(OPENAI_API_BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${aiConfig.openai_api_key}`
    },
    body: JSON.stringify({ model: model || DEFAULT_OPENAI_MODEL, messages, temperature: 0.5 })
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
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(httpError(413, 'payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(httpError(400, 'invalid_json')); }
    });
    req.on('error', reject);
  });
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
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
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
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
    session.user = toSessionUser(result.data.user);
    saveSession();
    sendJson(res, 200, { ok: true, user: session.user });
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

// Shared by handleStats and handleChat so both hit the same cache instead of duplicating
// the upstream call.
async function fetchDayStats(date, { refresh = false } = {}) {
  const cacheKey = `stats:${date}`;
  if (!refresh) {
    const cached = getCached(cacheKey, STATS_TTL_MS);
    if (cached) return { status: 200, ok: true, data: cached };
  }

  const result = await upstream('POST', '/patient/nutrition/stats', { date });
  if (result.ok) setCached(cacheKey, result.data);
  return result;
}

async function handleStats(req, res, query) {
  if (!requireAuth(res)) return;
  const date = query.get('date');
  if (!date) { sendJson(res, 400, { error: 'date is required' }); return; }

  const result = await fetchDayStats(date, { refresh: !!query.get('refresh') });
  sendJson(res, result.status, result.data);
}

async function handleHasNutritionDays(req, res) {
  if (!requireAuth(res)) return;
  // Not cached: the counts change with every log/delete, and it's one cheap request.
  const result = await upstream('GET', '/patient/nutrition/has_nutrition_days');
  sendJson(res, result.status, result.data);
}

async function handleDuplicateItems(req, res) {
  if (!requireAuth(res)) return;
  const body = await readJsonBody(req);
  const result = await upstream('POST', '/patient/nutrition/duplicate_items_to_date', {
    from_date: body.from_date,
    to_date: body.to_date,
    items: Array.isArray(body.items) ? body.items : []
  });
  if (result.ok && body.to_date) invalidateCached(`stats:${body.to_date}`);
  sendJson(res, result.status, result.data);
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

// --- AI chat settings & endpoint ---

const MAX_CUSTOM_INSTRUCTIONS_LENGTH = 1000;

function handleGetAiSettings(req, res) {
  if (!requireAuth(res)) return;
  sendJson(res, 200, {
    configured: !!aiConfig.openai_api_key,
    model: aiConfig.openai_model || DEFAULT_OPENAI_MODEL,
    custom_instructions: aiConfig.custom_instructions || ''
  });
}

async function handleSaveAiSettings(req, res) {
  if (!requireAuth(res)) return;
  const body = await readJsonBody(req);

  if (typeof body.api_key === 'string' && body.api_key.trim()) {
    aiConfig.openai_api_key = body.api_key.trim();
  }
  if (typeof body.model === 'string' && body.model.trim()) {
    aiConfig.openai_model = body.model.trim();
  }
  if (typeof body.custom_instructions === 'string') {
    aiConfig.custom_instructions = body.custom_instructions.trim().slice(0, MAX_CUSTOM_INSTRUCTIONS_LENGTH) || null;
  }
  saveAiConfig();

  sendJson(res, 200, {
    configured: !!aiConfig.openai_api_key,
    model: aiConfig.openai_model || DEFAULT_OPENAI_MODEL,
    custom_instructions: aiConfig.custom_instructions || ''
  });
}

const MAX_CHAT_MESSAGE_LENGTH = 2000;

// Only these fields ever leave this function into the LLM prompt — no user identity,
// no medical_form, no raw upstream payloads (mirrors the SESSION_USER_FIELDS boundary above).
function buildNutritionContext(date, statsData) {
  const stats = statsData?.stats || {};
  const goal = statsData?.goal || {};
  const itemsByDayPart = statsData?.items || {};

  const lines = [`Today's date: ${date}`, ''];
  lines.push('Daily goal vs. consumed so far:');
  for (const [key, label] of [['enercc_kcal', 'Energy (kcal)'], ['prot_g', 'Protein (g)'], ['fat_g', 'Fat (g)'], ['cho_g', 'Carbs (g)'], ['fibt_g', 'Fiber (g)']]) {
    const consumed = Number(stats[key]) || 0;
    const goalVal = Number(goal[key]) || 0;
    const remaining = goalVal ? Math.round((goalVal - consumed) * 10) / 10 : null;
    lines.push(`- ${label}: ${Math.round(consumed * 10) / 10} consumed / ${goalVal || 'no goal set'} goal` +
      (remaining !== null ? ` (${remaining} remaining)` : ''));
  }

  lines.push('', 'Items logged today:');
  let itemCount = 0;
  for (const [dayPart, items] of Object.entries(itemsByDayPart)) {
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (itemCount >= 40) break;
      const kcal = item?.values?.enercc_kcal ? `${Math.round(item.values.enercc_kcal)} kcal` : '';
      lines.push(`- ${dayPart}: ${item?.description || 'item'}${kcal ? ` (${kcal})` : ''}`);
      itemCount++;
    }
  }
  if (!itemCount) lines.push('- (nothing logged yet)');

  return lines.join('\n');
}

async function handleChat(req, res) {
  if (!requireAuth(res)) return;
  const body = await readJsonBody(req);

  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message || message.length > MAX_CHAT_MESSAGE_LENGTH) {
    sendJson(res, 400, { error: 'invalid_message' });
    return;
  }
  const date = typeof body.date === 'string' && body.date ? body.date : new Date().toISOString().slice(0, 10);

  if (!aiConfig.openai_api_key) {
    sendJson(res, 400, { error: 'ai_not_configured', message: 'Add your OpenAI API key in Settings first.' });
    return;
  }

  const statsResult = await fetchDayStats(date);
  const context = buildNutritionContext(date, statsResult.ok ? statsResult.data : null);

  const customInstructions = aiConfig.custom_instructions
    ? `\n\nAdditional instructions from the user (apply these to every reply):\n${aiConfig.custom_instructions}`
    : '';

  const systemPrompt = 'You are a friendly, practical nutrition assistant inside the Vivica health dashboard. ' +
    'Answer using only the nutrition data provided below — do not invent numbers. Keep answers concise and ' +
    'actionable. You are not a medical professional; avoid medical advice.' + customInstructions + '\n\n' + context;

  const history = Array.isArray(body.history) ? body.history : [];
  const trimmedHistory = history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-16)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHAT_MESSAGE_LENGTH) }));

  const messages = [
    { role: 'system', content: systemPrompt },
    ...trimmedHistory,
    { role: 'user', content: message }
  ];

  const result = await callOpenAI(messages, aiConfig.openai_model);
  if (!result.ok) {
    console.error('OpenAI chat request failed', result.status, result.data);
    sendJson(res, 502, { error: 'openai_error' });
    return;
  }

  const reply = result.data?.choices?.[0]?.message?.content || '';
  sendJson(res, 200, { reply });
}

// --- router ---
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const { pathname, searchParams } = url;

    if (pathname.startsWith('/api/') && req.method !== 'GET') {
      // Cross-site "simple" requests can only send text/plain and friends without a CORS
      // preflight; requiring JSON here forces the preflight, which the browser then blocks.
      const hasBody = Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding'];
      if (hasBody && !/^application\/json\b/i.test(req.headers['content-type'] || '')) {
        sendJson(res, 415, { error: 'unsupported_content_type' });
        return;
      }
    }

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
    if (pathname === '/api/nutrition/has_nutrition_days' && req.method === 'GET') return await handleHasNutritionDays(req, res);
    if (pathname === '/api/nutrition/duplicate_items_to_date' && req.method === 'POST') return await handleDuplicateItems(req, res);
    if (pathname === '/api/nutrition/stats' && req.method === 'GET') return await handleStats(req, res, searchParams);
    if (pathname === '/api/search_nutrient_products' && req.method === 'POST') return await handleSearchNutrientProducts(req, res);
    if (pathname === '/api/nutrition/nutrient_product_create' && req.method === 'POST') return await handleCreateProduct(req, res);
    if (pathname === '/api/submit_nutrient_meal' && req.method === 'POST') return await handleSubmitMeal(req, res);
    if (pathname === '/api/nutrient_meals_data' && req.method === 'GET') return await handleMealsList(req, res, searchParams);
    if (pathname === '/api/supermarket_types' && req.method === 'GET') return await handleSupermarketTypes(req, res);
    if (pathname === '/api/products/recent' && req.method === 'GET') return handleRecentProducts(req, res);
    if (pathname === '/api/products/frequent' && req.method === 'GET') return handleFrequentProducts(req, res);
    if (pathname === '/api/settings/ai' && req.method === 'GET') return handleGetAiSettings(req, res);
    if (pathname === '/api/settings/ai' && req.method === 'POST') return await handleSaveAiSettings(req, res);
    if (pathname === '/api/chat' && req.method === 'POST') return await handleChat(req, res);

    if (pathname.startsWith('/api/')) { sendJson(res, 404, { error: 'not_found' }); return; }

    serveStatic(req, res, pathname);
  } catch (err) {
    console.error(err);
    const status = err.status || 500;
    try {
      sendJson(res, status, { error: status === 500 ? 'internal_error' : err.message, message: err.message });
    } catch { /* socket may already be destroyed (e.g. oversized body) */ }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Vivica dashboard running at http://${HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST}:${PORT} (bound to ${HOST})`);
});
