#!/usr/bin/env node
// hooks/scripts/qdrant-mirror-sync.js — coleccion espejo READ-ONLY para el MCP.
//
// POR QUE: el MCP generico `mcp-server-qdrant` y el escritor nativo
// `ultron-memory` discrepan en DOS cosas sobre `ultron_memory` (VERIFICADO en
// vivo: ultron_memory = {size:1024, Cosine, vector DEFAULT}, payload tiene
// 'summary', NO 'document'):
//   1) NOMBRE DE VECTOR — el MCP store/search usa un vector NAMED
//      "fast-multilingual-e5-large"; el escritor usa el vector DEFAULT (sin
//      nombre). => qdrant-find del MCP siempre falla por name-mismatch.
//   2) CLAVE DE PAYLOAD — el MCP lee payload["document"]; el escritor guarda el
//      texto bajo "summary". => KeyError aunque el vector coincidiera.
//
// FIX (KISS, no destructivo): NO mutar la coleccion canonica (da recall@8=0.917
// al lector nativo). Proyectar un ESPEJO derivado read-only "ultron_mcp_mirror"
// con la forma que el MCP espera: vector NAMED "fast-multilingual-e5-large"
// (1024d, Cosine) + payload {document:<summary>, metadata:{...}}. El vector se
// REUTILIZA del punto canonico (mismo modelo E5/espacio — solo cambia el NOMBRE
// del vector y la CLAVE del payload), asi que NO hay que reembeber.
//
// USO: node qdrant-mirror-sync.js  (desde el Stop hook, DESPUES de embed_vault
// para no propagar el desfase de reconcile). Upsert idempotente por id canonico.
// Solo points status=active. FAIL-SAFE: loguea y sale 0 ante cualquier error.
// Apuntar el MCP a este espejo en .claude.json (COLLECTION_NAME=ultron_mcp_mirror).

'use strict';

const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const SRC = process.env.ULTRON_QDRANT_COLLECTION || 'ultron_memory';
const DST = process.env.ULTRON_MCP_MIRROR || 'ultron_mcp_mirror';
const VECTOR_NAME = 'fast-multilingual-e5-large';
const PAGE = 256;
const LOG = path.join(os.homedir(), '.ultron', 'logs', 'qdrant-mirror-sync.jsonl');

const { appendJsonl } = require('./lib/jsonl-log');
// cat15.4: JSONL acotado (rota a 1 MiB) via helper compartido.
function log(rec) { appendJsonl(LOG, { ts: Date.now(), ...rec }); }

function req(method, urlPath, body) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(QDRANT_URL + urlPath); } catch { return resolve(null); }
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const opts = { hostname: u.hostname, port: u.port || 6333, path: u.pathname + u.search, method, headers: { 'content-type': 'application/json' } };
    if (data) opts.headers['content-length'] = data.length;
    const r = http.request(opts, (res) => { let buf = ''; res.on('data', (c) => (buf += c)); res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(buf || '{}') }); } catch { resolve({ status: res.statusCode, json: null }); } }); });
    r.on('error', () => resolve(null));
    if (data) r.write(data);
    r.end();
  });
}

async function ensureMirror() {
  const existing = await req('GET', `/collections/${DST}`);
  if (existing && existing.status === 200) return true;
  const created = await req('PUT', `/collections/${DST}`, { vectors: { [VECTOR_NAME]: { size: 1024, distance: 'Cosine' } } });
  return !!(created && created.status >= 200 && created.status < 300);
}

async function scrollPage(offset) {
  const body = { limit: PAGE, with_payload: true, with_vector: true, filter: { must: [{ key: 'status', match: { value: 'active' } }] } };
  if (offset) body.offset = offset;
  const r = await req('POST', `/collections/${SRC}/points/scroll`, body);
  if (!r || r.status !== 200 || !r.json || !r.json.result) return { points: [], next: null };
  return { points: r.json.result.points || [], next: r.json.result.next_page_offset || null };
}

function extractVector(p) {
  if (Array.isArray(p.vector)) return p.vector;
  if (p.vector && typeof p.vector === 'object') {
    if (Array.isArray(p.vector[''])) return p.vector[''];
    const vals = Object.values(p.vector).filter(Array.isArray);
    if (vals.length === 1) return vals[0];
  }
  return null;
}

function toMirrorPoint(p) {
  const vec = extractVector(p);
  if (!vec) return null;
  const pl = p.payload || {};
  return { id: p.id, vector: { [VECTOR_NAME]: vec }, payload: { document: pl.summary || pl.title || '', metadata: { canonical_id: pl.canonical_id || p.id, type: pl.type, scope: pl.scope, project_id: pl.project_id, tags: pl.tags, confidence: pl.confidence, importance: pl.importance, symbol: pl.symbol, file_path: pl.file_path, line: pl.line, updated_at: pl.updated_at } } };
}

async function upsert(points) { if (!points.length) return 0; const r = await req('PUT', `/collections/${DST}/points?wait=true`, { points }); return r && r.status >= 200 && r.status < 300 ? points.length : 0; }

/** Collect all point IDs currently in the mirror (any status). */
async function scrollMirrorIds() {
  const ids = new Set();
  let offset = null;
  for (let i = 0; i < 10000; i++) {
    const body = { limit: PAGE, with_payload: false, with_vector: false };
    if (offset) body.offset = offset;
    const r = await req('POST', `/collections/${DST}/points/scroll`, body);
    if (!r || r.status !== 200 || !r.json || !r.json.result) break;
    for (const p of (r.json.result.points || [])) ids.add(String(p.id));
    const next = r.json.result.next_page_offset;
    if (!next) break;
    offset = next;
  }
  return ids;
}

/** Delete stale mirror points whose source item is no longer active. */
async function pruneStale(activeIds) {
  const mirrorIds = await scrollMirrorIds();
  const stale = [];
  for (const id of mirrorIds) if (!activeIds.has(id)) stale.push(id);
  if (!stale.length) return 0;
  // Qdrant delete-by-ids: POST /collections/{name}/points/delete
  const r = await req('POST', `/collections/${DST}/points/delete?wait=true`, { points: stale });
  return r && r.status >= 200 && r.status < 300 ? stale.length : 0;
}

async function main() {
  const started = Date.now();
  const ok = await ensureMirror();
  if (!ok) { log({ msg: 'ensure_failed' }); process.exitCode = 0; return; }
  let offset = null, total = 0, synced = 0, skipped = 0;
  // Collect the set of IDs that are currently active in the source collection.
  const activeIds = new Set();
  for (let i = 0; i < 10000; i++) {
    const { points, next } = await scrollPage(offset);
    if (!points.length) break;
    total += points.length;
    const mirror = points.map(toMirrorPoint).filter(Boolean);
    skipped += points.length - mirror.length;
    synced += await upsert(mirror);
    for (const p of points) activeIds.add(String(p.id));
    if (!next) break;
    offset = next;
  }
  // PRUNE: remove mirror points whose source item is no longer active.
  // Without this, deprecated/rejected items remain in ultron_mcp_mirror
  // forever and can resurface in MCP recall — a correctness bug.
  const pruned = await pruneStale(activeIds);
  log({ msg: 'sync_done', total, synced, skipped, pruned, ms: Date.now() - started });
  process.exitCode = 0;
}

main().catch((e) => { log({ msg: 'unhandled', error: String(e && e.message) }); process.exitCode = 0; });

