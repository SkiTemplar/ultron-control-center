'use strict';

/**
 * lib/research/http.js — cliente HTTP fino compartido por los cuatro
 * proveedores (OpenAlex, Semantic Scholar, Crossref, Unpaywall):
 * limite de ritmo por namespace, timeout con AbortController, reintentos con
 * backoff exponencial + jitter ante 429/5xx (respetando `Retry-After` si la
 * fuente lo manda), cache en disco opcional y errores explicitos (nunca
 * tragados: node fetch() global, sin dependencias).
 */

const { HttpError, TimeoutError } = require('./errors');
const rateLimiter = require('./rate-limiter');
const { withCache } = require('./cache');

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 3;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** ms de espera sugeridos por `Retry-After` (segundos o fecha HTTP), o null. */
function retryAfterMs(headers) {
  const raw = headers.get('retry-after');
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(raw);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

function backoffMs(attempt) {
  const exp = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return exp + Math.floor(Math.random() * BASE_BACKOFF_MS); // jitter: evita reintentos sincronizados
}

async function fetchOnce(url, { method, headers, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { method, headers, signal: controller.signal });
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new TimeoutError(`timeout tras ${timeoutMs}ms: ${url}`, { url, timeoutMs });
    }
    throw new HttpError(`fallo de red: ${String(e.message ?? e)}`, { url });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Peticion HTTP con rate limit + reintentos + timeout. `responseType`
 * controla como se parsea el cuerpo ('json' | 'text'). Lanza HttpError para
 * cualquier 4xx no reintentable o tras agotar reintentos en 429/5xx.
 */
async function request(url, opts = {}) {
  const {
    namespace,
    minIntervalMs = 0,
    method = 'GET',
    headers = {},
    responseType = 'json',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
  } = opts;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (namespace) await rateLimiter.acquire(namespace, minIntervalMs);
    let res;
    try {
      res = await fetchOnce(url, { method, headers, timeoutMs });
    } catch (e) {
      lastErr = e; // timeout o fallo de red: reintentable igual que un 5xx
      if (attempt < retries) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw e;
    }

    if (res.ok) {
      let body;
      if (responseType === 'text') body = await res.text();
      else if (responseType === 'buffer') body = Buffer.from(await res.arrayBuffer());
      else body = await res.json();
      return { status: res.status, headers: res.headers, body };
    }

    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < retries) {
      const wait = retryAfterMs(res.headers) ?? backoffMs(attempt);
      await sleep(wait);
      continue;
    }

    const bodyText = await res.text().catch(() => '');
    throw new HttpError(`HTTP ${res.status} en ${url}`, { status: res.status, url, body: bodyText.slice(0, 500) });
  }
  throw lastErr ?? new HttpError(`fallo desconocido en ${url}`, { url });
}

/** Igual que request(), pero con cache en disco por TTL cuando se pasa cacheKey. */
async function requestCached(url, opts = {}) {
  const { cacheKey, cacheTtlMs, cacheDir, ...rest } = opts;
  if (!cacheKey || !cacheTtlMs) return request(url, rest);
  const { value } = await withCache(cacheKey, cacheTtlMs, () => request(url, rest), { dir: cacheDir });
  return value;
}

module.exports = { request, requestCached };
