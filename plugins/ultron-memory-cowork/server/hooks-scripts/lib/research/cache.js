'use strict';

/**
 * lib/research/cache.js — cache en disco con TTL para no repetir consultas
 * contra el presupuesto diario de OpenAlex/Semantic Scholar. Vive fuera del
 * repo (junto a las sesiones de investigacion), un fichero JSON por clave.
 * Fail-safe: un fallo de lectura/escritura de cache nunca debe romper una
 * busqueda, solo degradarla a "sin cache".
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

/** RESEARCH_CACHE_DIR_OVERRIDE (solo selftests) evita tocar la cache real del usuario. */
function defaultCacheDir() {
  return process.env.RESEARCH_CACHE_DIR_OVERRIDE || path.join(os.homedir(), '.ultron', 'research', '.cache');
}

function keyToFile(dir, key) {
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  return path.join(dir, `${hash}.json`);
}

/** Lee una entrada de cache si existe y no ha caducado; si no, null. */
function readCache(key, { dir = defaultCacheDir() } = {}) {
  try {
    const file = keyToFile(dir, key);
    if (!fs.existsSync(file)) return null;
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof entry.expiresAt !== 'number' || Date.now() > entry.expiresAt) return null;
    return entry.value;
  } catch {
    return null; // cache corrupta o inaccesible: se trata como cache-miss, no como error
  }
}

/** Escribe una entrada de cache con TTL (ms). */
function writeCache(key, value, ttlMs, { dir = defaultCacheDir() } = {}) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = keyToFile(dir, key);
    const entry = { expiresAt: Date.now() + ttlMs, value };
    fs.writeFileSync(file, JSON.stringify(entry));
  } catch {
    /* cache es una optimizacion, no una garantia: si no se puede escribir, se sigue sin ella */
  }
}

/** Envuelve `fetcher` (async, sin argumentos) con lectura/escritura de cache. */
async function withCache(key, ttlMs, fetcher, opts = {}) {
  const cached = readCache(key, opts);
  if (cached !== null) return { value: cached, fromCache: true };
  const value = await fetcher();
  writeCache(key, value, ttlMs, opts);
  return { value, fromCache: false };
}

module.exports = { readCache, writeCache, withCache, defaultCacheDir };
