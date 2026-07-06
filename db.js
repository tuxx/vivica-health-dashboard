import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'vivica.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS response_cache (
    cache_key   TEXT PRIMARY KEY,
    payload     TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS products (
    type_record  TEXT NOT NULL,
    external_id  TEXT NOT NULL,
    description  TEXT,
    data_json    TEXT NOT NULL,
    use_count    INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (type_record, external_id)
  );
`);

function now() {
  return Date.now();
}

export function getCached(key, ttlMs) {
  const row = db.prepare('SELECT payload, updated_at FROM response_cache WHERE cache_key = ?').get(key);
  if (!row) return null;
  if (now() - Number(row.updated_at) > ttlMs) return null;
  return JSON.parse(row.payload);
}

export function setCached(key, payload) {
  db.prepare(`
    INSERT INTO response_cache (cache_key, payload, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(payload), now());
}

export function invalidateCached(key) {
  db.prepare('DELETE FROM response_cache WHERE cache_key = ?').run(key);
}

export function upsertProduct(typeRecord, externalId, description, data) {
  if (!externalId) return;
  db.prepare(`
    INSERT INTO products (type_record, external_id, description, data_json, use_count, last_used_at, updated_at)
    VALUES (?, ?, ?, ?, 0, NULL, ?)
    ON CONFLICT(type_record, external_id) DO UPDATE SET
      description = excluded.description,
      data_json = excluded.data_json,
      updated_at = excluded.updated_at
  `).run(String(typeRecord), String(externalId), description ?? null, JSON.stringify(data), now());
}

export function markProductUsed(typeRecord, externalId) {
  if (!externalId) return;
  db.prepare(`
    UPDATE products SET use_count = use_count + 1, last_used_at = ?
    WHERE type_record = ? AND external_id = ?
  `).run(now(), String(typeRecord), String(externalId));
}

export function recentProducts(limit = 20) {
  return db.prepare(`
    SELECT type_record, external_id, description, data_json, use_count, last_used_at
    FROM products
    WHERE last_used_at IS NOT NULL
    ORDER BY last_used_at DESC
    LIMIT ?
  `).all(limit).map(rowToProduct);
}

export function frequentProducts(limit = 20) {
  return db.prepare(`
    SELECT type_record, external_id, description, data_json, use_count, last_used_at
    FROM products
    WHERE use_count > 0
    ORDER BY use_count DESC
    LIMIT ?
  `).all(limit).map(rowToProduct);
}

function rowToProduct(row) {
  return {
    type_record: row.type_record,
    id: row.external_id,
    description: row.description,
    use_count: row.use_count,
    last_used_at: row.last_used_at,
    ...JSON.parse(row.data_json)
  };
}

export default db;
