#!/usr/bin/env node
/**
 * regen-manifest.js — regenera hooks/manifest.json desde la config VIVA
 * (~/.claude/settings.json) con checksums sha256 frescos de los ficheros reales.
 *
 * Motivo (Kirkardo Pass1 2026-06-10, cat9/H1): el manifest se editaba a mano y
 * acumulo 11/15 checksums desactualizados + 7 hooks vivos sin documentar.
 * La SoT de QUE corre es settings.json; el manifest es el espejo versionado y
 * auditado. Este script hace el espejo reproducible:
 *
 *   node hooks/regen-manifest.js          # regenera manifest.json
 *   node hooks/regen-manifest.js --check  # exit 1 si el manifest esta desfasado (gate CI/local)
 *
 * Metadatos que el settings.json no tiene (description, env_allowlist,
 * writes_memory, writer_path, version) se conservan del manifest anterior por
 * id; los hooks nuevos reciben placeholders marcados para completar a mano.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const HOME = os.homedir();
const SETTINGS = path.join(HOME, '.claude', 'settings.json');
const MANIFEST = path.join(__dirname, 'manifest.json');
const CHECK_MODE = process.argv.includes('--check');

function sha256(file) {
  try {
    // Normaliza CRLF->LF antes de hashear (card vrwxcf): con core.autocrlf=true los
    // hooks estan CRLF en el working tree pero LF en el indice, asi que hashear los
    // BYTES CRUDOS hacia fluctuar el checksum -> el gate de paridad fallaba en casi
    // cada commit. Hashear el contenido normalizado lo hace estable y portable
    // (mismo hash en Windows/Linux, con o sin autocrlf). latin1 preserva bytes 1:1.
    const normalized = fs.readFileSync(file).toString('latin1').replace(/\r\n/g, '\n');
    return crypto.createHash('sha256').update(normalized, 'latin1').digest('hex');
  } catch (_) {
    return 'FILE_MISSING';
  }
}

/** Despersonaliza rutas (repo publico, gate PII): C:/Users/<yo> -> ~. */
function dehome(s) {
  if (!s) return s;
  const homes = [HOME, HOME.replace(/\\/g, '/'), HOME.replace(/\//g, '\\')];
  let out = s;
  for (const h of homes) out = out.split(h).join('~');
  return out;
}

/** Re-expande ~ al HOME real (para leer ficheros al regenerar/checkear). */
function rehome(s) {
  return s && s.startsWith('~') ? HOME.replace(/\\/g, '/') + s.slice(1) : s;
}

/** Extrae la ruta del script de un command de hook (node X / uv run python X / powershell -File X). */
function scriptPathOf(command) {
  const m = command.match(/(?:node|python|-File)\s+("?)([A-Za-z]:[^\s"]+|\/[^\s"]+)\1/);
  return m ? m[2] : null;
}

function idOf(scriptPath, command) {
  if (scriptPath) return path.basename(scriptPath).replace(/\.(js|py|ps1)$/, '');
  return command.slice(0, 40).replace(/\W+/g, '-');
}

function main() {
  const settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  const old = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : {};
  const oldById = new Map((old.hooks || []).map((h) => [h.id, h]));

  const hooks = [];
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    for (const group of groups) {
      for (const h of group.hooks || []) {
        const sp = scriptPathOf(h.command);
        const id = idOf(sp, h.command);
        const prev = oldById.get(id) || {};
        hooks.push({
          id,
          event,
          matcher: group.matcher || '*',
          command: dehome(h.command),
          script: dehome(sp),
          timeout_s: h.timeout != null ? h.timeout : null,
          // Semantica critica (ver rules/common/hooks.md): async=true corre
          // fire-and-forget y su stdout JSON SE DESCARTA — sin este campo el
          // manifest vendia como sincronos hooks que no pueden hablar al modelo.
          async: h.async === true,
          checksum_sha256: sp ? sha256(sp) : null,
          version: prev.version || '1.0.0',
          env_allowlist: prev.env_allowlist || [],
          failure_policy: prev.failure_policy || 'no_op',
          writes_memory: prev.writes_memory != null ? prev.writes_memory : false,
          writer_path: prev.writer_path || 'NONE',
          description: prev.description || 'TODO: describir (hook nuevo detectado por regen-manifest)',
        });
      }
    }
  }

  const manifest = {
    $schema: 'https://ultron.local/schemas/hooks-manifest-v2.json',
    manifest_version: 2,
    generated_at: new Date().toISOString().slice(0, 10),
    generated_by: 'hooks/regen-manifest.js (NO editar hooks[] a mano; editar settings.json y regenerar)',
    source_of_truth: '~/.claude/settings.json (config viva) -> scripts versionados en ~/.ultron',
    notes: [
      'Los hooks PROPONEN candidates; NUNCA escriben memoria directa. El unico escritor del SoT (brain.db) es MemoryService (sidecar ultron-memory).',
      'writer_path PROHIBIDO: qdrant_direct, mem0. Solo MemoryService o NONE.',
      'Regenerar tras cualquier cambio en settings.json: node hooks/regen-manifest.js',
      'Gate de paridad: node hooks/regen-manifest.js --check (exit 1 si hay drift).',
    ],
    writer_paths_allowed: ['MemoryService', 'NONE'],
    writer_paths_forbidden: ['qdrant_direct', 'mem0'],
    hooks,
    deregistered: old.deregistered || [],
  };

  const next = JSON.stringify(manifest, null, 2) + '\n';

  if (CHECK_MODE) {
    const cur = fs.existsSync(MANIFEST) ? fs.readFileSync(MANIFEST, 'utf8') : '';
    // Comparar ignorando generated_at (cambia cada dia sin drift real) y
    // line-endings: git en Windows (autocrlf) puede reescribir el manifest a
    // CRLF mientras next siempre es LF — eso NO es drift (card vrwxcf).
    const norm = (s) =>
      s.replace(/\r\n/g, '\n').replace(/"generated_at": "[^"]*"/, '"generated_at": "X"');
    if (norm(cur) !== norm(next)) {
      console.error('DRIFT: hooks/manifest.json no coincide con settings.json + checksums reales. Ejecuta: node hooks/regen-manifest.js');
      process.exit(1);
    }
    console.log('OK: manifest en paridad con settings.json (' + hooks.length + ' hooks)');
    return;
  }

  fs.writeFileSync(MANIFEST, next);
  const missing = hooks.filter((h) => h.checksum_sha256 === 'FILE_MISSING');
  const todo = hooks.filter((h) => h.description.startsWith('TODO'));
  console.log('manifest regenerado: ' + hooks.length + ' hooks');
  if (missing.length) console.log('AVISO scripts faltantes: ' + missing.map((h) => h.id).join(', '));
  if (todo.length) console.log('AVISO descripciones TODO: ' + todo.map((h) => h.id).join(', '));
}

main();
