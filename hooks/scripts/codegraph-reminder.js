#!/usr/bin/env node
/**
 * PreToolUse hook (matcher: Read|Grep|Glob|Bash) — CodeGraph nudge.
 *
 * Por que existe: ULTRON mantiene un indice CodeGraph (MCP codegraph_*, ~8k
 * simbolos). Leer archivos de codigo enteros, o explorar el arbol a ciegas
 * (Glob / find / ls / grep) para UBICAR algo, gasta cientos de tokens que el
 * indice ya resuelve. Este hook recuerda usar codegraph ANTES de explorar.
 *
 * Root cause que cierra (sesion 2026-06-22): el matcher era solo Read|Grep, asi
 * que un agente que localizaba un fichero con `Glob cockpit/projects/**` + `ls`
 * no recibia el nudge y exploraba el FS a mano teniendo el indice la respuesta.
 *
 * Diseno (token-aware, no molesto):
 *  - Dispara en Read de CODIGO, Grep, Glob, o Bash de EXPLORACION a ciegas
 *    (find/ls/grep/rg/cat/head/tail/tree/wc/fd/dir) — NO en build/run
 *    (cargo/npm/node/python/git/tsc...) ni en Read de no-codigo (.md/.json).
 *  - Solo si hay un indice codegraph aplicable (un .codegraph/codegraph.db
 *    hacia arriba, o el archivo vive bajo ~/.ultron, que tiene indice global).
 *  - Nudge en la 1a exploracion de la sesion y RE-nudge tras cada 10
 *    exploraciones seguidas sin ninguna llamada codegraph intermedia (contador
 *    persistente en temp por session_id; uso de mcp__codegraph__* detectado en
 *    el transcript resetea el contador).
 *  - NUNCA bloquea el Read: solo inyecta additionalContext. Cualquier error
 *    => exit 0 silencioso (un hook nunca debe romper una lectura).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { observe, logHookError } = require('./lib/hook-obs');
observe('codegraph-reminder');

const CODE_EXT = new Set([
  '.rs', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go',
  '.java', '.kt', '.swift', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.vue',
]);

// Comandos Bash cuyo PROPOSITO es localizar/leer codigo en el FS a ciegas:
// justo lo que codegraph_search/explore resuelve sin barrer el arbol.
const EXPLORE_CMDS = new Set([
  'find', 'grep', 'rg', 'ls', 'cat', 'head', 'tail', 'tree', 'wc', 'fd', 'dir', 'glob',
]);

// True si el comando Bash es exploracion a ciegas (algun comando LIDER esta en
// EXPLORE_CMDS). Mira solo los lideres de cada segmento secuenciado (&&/||/;);
// IGNORA lo que va tras un pipe (`| head`, `| wc -l` son post-proceso de, p.ej.,
// `cargo test | tail` — que NO debe disparar).
function isBlindCodeExploration(command) {
  const cmd = String(command || '');
  if (!cmd.trim()) return false;
  const segments = cmd.split(/&&|\|\||;/);
  for (const seg of segments) {
    const leader = seg.split('|')[0].trim();
    if (!leader) continue;
    // Descarta prefijos VAR=val y toma el primer token; basename sin ruta.
    const tokens = leader.split(/\s+/).filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
    if (!tokens.length) continue;
    const base = tokens[0].split(/[\\/]/).pop().toLowerCase();
    if (EXPLORE_CMDS.has(base)) return true;
  }
  return false;
}

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

// Nudges: 1a exploracion de la sesion y, despues, cada multiplo de 10
// exploraciones sin uso de codegraph intermedio (el uso resetea el contador).
const RENUDGE_EVERY = 10;

// Offset (bytes) del ULTIMO tool_use mcp__codegraph__* en el transcript, o 0.
// Busca el patron compacto '"name":"mcp__codegraph__' sobre el TAIL (256KB):
// los tool_use del transcript son JSON compacto sin espacios, y las menciones
// de esas tools dentro de texto (p.ej. este propio nudge) quedan con comillas
// escapadas \" -> no matchean. Fail-safe: cualquier error => 0 (sin reset).
const CG_USE_PATTERN = Buffer.from('"name":"mcp__codegraph__');
function lastCodegraphUseOffset(transcriptPath) {
  try {
    if (!transcriptPath) return 0;
    const size = fs.statSync(transcriptPath).size;
    if (!size) return 0;
    const start = Math.max(0, size - 256 * 1024);
    const buf = Buffer.alloc(size - start);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      fs.readSync(fd, buf, 0, buf.length, start);
    } finally {
      fs.closeSync(fd);
    }
    const idx = buf.lastIndexOf(CG_USE_PATTERN);
    return idx < 0 ? 0 : start + idx;
  } catch (_) {
    return 0;
  }
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
  if (tool !== 'Read' && tool !== 'Grep' && tool !== 'Glob' && tool !== 'Bash') return;

  const ti = input.tool_input || {};
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || 'nosession';

  // Path objetivo segun la herramienta (+ filtros para no ser ruido).
  let target = '';
  if (tool === 'Read') {
    target = ti.file_path || '';
    if (!target) return;
    if (!CODE_EXT.has(path.extname(target).toLowerCase())) return; // no recordar para .md/.json/etc
  } else if (tool === 'Grep' || tool === 'Glob') {
    // Grep/Glob: localizar en el arbol; usa path objetivo o cwd como ancla.
    target = ti.path || cwd;
  } else { // Bash
    // Solo si el comando es EXPLORACION a ciegas (find/ls/grep/...), NO build/run.
    if (!isBlindCodeExploration(ti.command)) return;
    target = cwd;
  }

  // Solo si hay indice codegraph aplicable
  const anchorDir = path.extname(target) ? path.dirname(target) : target;
  const underUltron = /[\\/]\.ultron([\\/]|$)/i.test(target) || /[\\/]\.ultron([\\/]|$)/i.test(cwd);
  if (!underUltron && !findCodegraphDb(anchorDir || cwd)) return;

  // Contador persistente por sesion (mismo fichero temp que el viejo marker
  // booleano): explores = exploraciones desde el ultimo uso de codegraph;
  // cgOffset = offset del ultimo tool_use codegraph visto; nudged = ya se
  // emitio el nudge inicial de la sesion.
  const marker = path.join(os.tmpdir(), `ultron-cg-reminder-${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '')}`);
  let state = { explores: 0, cgOffset: 0, nudged: false };
  try {
    const st = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (st && typeof st.explores === 'number') {
      state = { explores: st.explores, cgOffset: st.cgOffset || 0, nudged: !!st.nudged };
    }
  } catch (_) {
    // primer disparo de la sesion (o marker legacy vacio): estado fresco
  }

  const cgUse = lastCodegraphUseOffset(input.transcript_path);
  if (cgUse > state.cgOffset) {
    // Hubo llamada(s) codegraph desde el ultimo disparo: contador a cero.
    state.cgOffset = cgUse;
    state.explores = 0;
  }
  state.explores += 1;
  const shouldNudge =
    !state.nudged || (state.explores > 0 && state.explores % RENUDGE_EVERY === 0);
  if (shouldNudge) state.nudged = true;
  try {
    fs.writeFileSync(marker, JSON.stringify(state));
  } catch (_) {
    // si no podemos persistir, seguimos: mejor recordar de mas que romper
  }
  if (!shouldNudge) return;

  const msg =
    '[ULTRON / CodeGraph] Hay un indice CodeGraph para este proyecto ' +
    '(herramientas mcp__codegraph__codegraph_*, ~8k simbolos). ANTES de explorar ' +
    'el arbol o leer codigo a ciegas (Glob/find/ls/grep/Read) para ubicar ' +
    'simbolos, archivos, callers/callees o impacto de un cambio, usa ' +
    'codegraph_search (ubicacion) y codegraph_explore (codigo + rutas en 1 ' +
    'llamada): resuelven "donde esta X" sin barrer el FS y ahorran cientos de ' +
    'tokens. Exploracion directa solo para confirmar un detalle puntual, o para ' +
    'datos de runtime/JSON que el indice no cubre (p.ej. cockpit/projects/*/kanban.json). ' +
    'Las tools mcp__codegraph__* son deferred: si no estan cargadas, cargalas primero con ' +
    'ToolSearch "select:mcp__codegraph__codegraph_explore,mcp__codegraph__codegraph_search".';

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
  try { out = handle(raw) || ''; } catch (e) { logHookError('codegraph-reminder', e); /* nunca romper una lectura */ }

  // Escribir y salir SOLO tras el flush (en Windows, process.exit inmediato
  // trunca stdout con buffer pendiente). Sin salida => salir ya.
  if (out) {
    process.stdout.write(out, () => process.exit(0));
  } else {
    process.exit(0);
  }
})();
