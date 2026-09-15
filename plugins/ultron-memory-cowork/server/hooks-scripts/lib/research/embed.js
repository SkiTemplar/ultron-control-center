'use strict';

/**
 * lib/research/embed.js — re-rank semantico via el daemon de memoria de
 * ULTRON (E5-large 1024d). Reutiliza el cliente ya existente de los hooks
 * (`../ultron-memory-cli.js`, protocolo `{cmd:'embed',text}` sobre el socket
 * TCP local que ya habla `daemon_client.rs::embed_prefer_daemon` en Rust) en
 * vez de reimplementar el transporte. FAIL-SAFE: si el daemon no responde
 * (no esta arrancado, timeout, error), embedText() devuelve null — nunca
 * lanza — para que rankAndFilter pueda degradar al lexico con un aviso
 * explicito en vez de romper la busqueda.
 */

const path = require('path');
const { daemonRequest } = require(path.join('..', 'ultron-memory-cli.js'));
const { withCache } = require('./cache');

const EMBED_TIMEOUT_MS = 8_000;
const EMBED_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d: el vector de un texto no cambia
const MAX_EMBED_CHARS = 2_000; // titulo+abstract recortado: mas no mejora la senal y encarece la llamada

/** Embedding E5 de `text` via el daemon, o null si no responde (nunca lanza). */
async function embedText(text) {
  // Interruptor explicito (selftests herméticos y despliegues sin daemon):
  // degrada exactamente igual que un daemon caido, mismo camino de aviso.
  if (process.env.RESEARCH_DISABLE_SEMANTIC === '1') return null;
  const trimmed = String(text ?? '').slice(0, MAX_EMBED_CHARS).trim();
  if (!trimmed) return null;
  try {
    const resp = await daemonRequest({ cmd: 'embed', text: trimmed }, EMBED_TIMEOUT_MS);
    if (resp && Array.isArray(resp.vector) && resp.vector.length > 0) return resp.vector;
    return null;
  } catch {
    return null; // fail-safe: la busqueda nunca debe caerse por un fallo de embedding
  }
}

/** Igual que embedText() pero con cache en disco (30d) por hash del texto. */
async function embedTextCached(text) {
  const trimmed = String(text ?? '').slice(0, MAX_EMBED_CHARS).trim();
  if (!trimmed) return null;
  const { value } = await withCache(`embed:${trimmed}`, EMBED_CACHE_TTL_MS, () => embedText(trimmed));
  return value;
}

// E5 exige los prefijos "query: "/"passage: " para separar bien consulta y
// documento (confirmado 2026-09-11: sin prefijo, cos(relevante)=0.854 vs
// cos(irrelevante)=0.803, delta 0.05; con prefijo, 0.874 vs 0.773, delta
// 0.10 -- el mismo convenio que usa daemon_client.rs::embed_prefer_daemon
// ("lado QUERY, prefijo query:") para el recall de memoria de ULTRON.
const embedQuery = (text) => embedTextCached(`query: ${text}`);
const embedPassage = (text) => embedTextCached(`passage: ${text}`);

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return null;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

module.exports = { embedText, embedTextCached, embedQuery, embedPassage, cosineSimilarity };
