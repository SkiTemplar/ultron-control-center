#!/usr/bin/env node
/**
 * PreToolUse hook (matcher: Read|Grep) — CodeGraph nudge.
 *
 * Por que existe: ULTRON mantiene un indice CodeGraph (MCP codegraph_*, ~8k
 * simbolos). Leer archivos de codigo enteros para entender arquitectura /
 * ubicacion / callers / impacto gasta cientos de tokens que el indice ya
 * resuelve. Este hook recuerda usar codegraph ANTES de leer codigo.
 *
 * Diseno (token-aware, no molesto):
 *  - Solo dispara en Read de archivos de CODIGO, o en Grep.
 *  - Solo si hay un indice codegraph aplicable (un .codegraph/codegraph.db
 *    hacia arriba, o el archivo vive bajo ~/.ultron, que tiene indice global).
 *  - UNA sola vez por sesion (marcador en temp por session_id).
 *  - NUNCA bloquea el Read: solo inyecta additionalContext. Cualquier error
 *    => exit 0 silencioso (un hook nunca debe romper una lectura).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { observe } = require('./lib/hook-obs');
observe('codegraph-reminder');

const CODE_EXT = new Set([
  '.rs', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go',
  '.java', '.kt', '.swift', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.vue',
]);

// Lectura de stdin robusta en Windows: por eventos, con timeout de seguridad
// para no colgar nunca mas alla del timeout del hook (5s).
function getStdin() {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    let timer = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(data);
    };
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { data += c; });
      process.stdin.on('end', finish);
      process.stdin.on('error', finish);
      process.stdin.resume();
    } catch (_) { finish(); }
    timer = setTimeout(finish, 2500);
  });
}

function findCodegraphDb(startDir) {
  // Sube hasta 8 niveles buscando .codegraph/codegraph.db
  let dir = startDir;
  for (let i = 0; i < 8 && dir; i++) {
    try {
      if (fs.existsSync(path.join(dir, '.codegraph', 'codegraph.db'))) return true;
    } catch (_) { /* ignore */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

function handle(raw) {
  // Strip BOM y espacios (algunos shells/encodings anteponen BOM UTF-8,
  // que hace fallar JSON.parse). Claude Code pasa JSON limpio, pero robustez.
  raw = String(raw || '').replace(/^﻿/, '').trim();
  if (!raw) return;

  let input;
  try {
    input = JSON.parse(raw);
  } catch (_) {
    return;
  }

  const tool = input.tool_name || '';
  if (tool !== 'Read' && tool !== 'Grep') return;

  const ti = input.tool_input || {};
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || 'nosession';

  // Path objetivo + filtro de "es codigo"
  let target = '';
  if (tool === 'Read') {
    target = ti.file_path || '';
    if (!target) return;
    if (!CODE_EXT.has(path.extname(target).toLowerCase())) return; // no recordar para .md/.json/etc
  } else {
    // Grep: busca en codigo; usa path o cwd como ancla
    target = ti.path || cwd;
  }

  // Solo si hay indice codegraph aplicable
  const anchorDir = path.extname(target) ? path.dirname(target) : target;
  const underUltron = /[\\/]\.ultron([\\/]|$)/i.test(target) || /[\\/]\.ultron([\\/]|$)/i.test(cwd);
  if (!underUltron && !findCodegraphDb(anchorDir || cwd)) return;

  // Una vez por sesion
  const marker = path.join(os.tmpdir(), `ultron-cg-reminder-${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '')}`);
  try {
    if (fs.existsSync(marker)) return;
    fs.writeFileSync(marker, '');
  } catch (_) {
    // si no podemos marcar, seguimos: mejor recordar de mas que romper
  }

  const msg =
    '[ULTRON / CodeGraph] Hay un indice CodeGraph para este proyecto ' +
    '(herramientas mcp__codegraph__codegraph_*, ~8k simbolos). ANTES de leer ' +
    'archivos de codigo para entender arquitectura, ubicacion de simbolos, ' +
    'callers/callees o impacto de un cambio, usa codegraph_explore / ' +
    'codegraph_search / codegraph_impact: devuelven el codigo relevante sin ' +
    'leer archivos enteros y ahorran cientos de tokens. Read/Grep directo solo ' +
    'para confirmar un detalle puntual que codegraph no cubra.';

  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: msg,
    },
  };
  return JSON.stringify(out);
}

(async () => {
  let raw = '';
  try { raw = await getStdin(); } catch (_) { /* ignore */ }

  let out = '';
  try { out = handle(raw) || ''; } catch (_) { /* nunca romper una lectura */ }

  // Escribir y salir SOLO tras el flush (en Windows, process.exit inmediato
  // trunca stdout con buffer pendiente). Sin salida => salir ya.
  if (out) {
    process.stdout.write(out, () => process.exit(0));
  } else {
    process.exit(0);
  }
})();
