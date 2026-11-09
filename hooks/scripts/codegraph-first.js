#!/usr/bin/env node
'use strict';

/**
 * codegraph-first.js — PreToolUse (matcher: Grep|Glob|Read|mcp__codegraph__.*).
 *
 * Objetivo del pilar 2 de docs/GOAL.md: que la IA consulte el grafo de
 * CodeGraph en vez de recorrer el codigo fichero a fichero. El check 2.6 del
 * medidor midio un 0,23 de sesiones de codigo que usaban CodeGraph frente al
 * objetivo de 0,80 (2026-11-01). El recordatorio por additionalContext que
 * habia antes se retiro el 2026-09-29 sin efecto medible.
 *
 * Regla: en cada sesion (y en cada subagente, por separado), la SEGUNDA
 * llamada de exploracion (Grep, Glob o Read de un fichero de codigo) sin
 * haber usado antes ninguna herramienta de CodeGraph se deniega UNA vez con
 * el motivo. A partir de ahi todo pasa: el hook no puede saber si el agente
 * tiene la herramienta (doc-summarizer no la tiene), asi que nunca bloquea
 * dos veces.
 *
 * Solo actua si el directorio de trabajo cuelga de un proyecto con indice
 * (.codegraph/codegraph.db en cwd o en un ancestro). Sin indice, silencio.
 *
 * Estado: un JSON por (sesion, agente) en <tmp>/ultron-codegraph-first/. Los
 * de mas de 2 dias se borran al pasar.
 *
 * Fail-open: cualquier error -> exit 0 sin output (nunca bloquea por fallo
 * propio). Opt-out: CLAUDE_NO_HOOKS=1 o ULTRON_CODEGRAPH_FIRST=0.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CODE_EXT = /\.(rs|ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|swift|c|cc|cpp|h|hpp|cs|vue)$/i;
const DENY_AT = 2;
const STATE_TTL_MS = 2 * 24 * 60 * 60 * 1000;

const DENY_REASON =
  '[codegraph-first] Este proyecto tiene indice de CodeGraph. Antes de seguir con Grep/Glob/Read, ' +
  'llama una vez a mcp__codegraph__codegraph_explore con la pregunta o los simbolos: devuelve el ' +
  'codigo fuente con numeros de linea, quien lo llama y el radio de impacto. Este aviso sale una ' +
  'sola vez por sesion: si no tienes esa herramienta, repite la llamada y pasara.';

function stateDir() {
  return path.join(os.tmpdir(), 'ultron-codegraph-first');
}

/** Clasifica la llamada: 'codegraph', 'explore' o null (no cuenta). Pura. */
function classifyTool(toolName, toolInput) {
  const name = String(toolName || '');
  if (/^mcp__codegraph__/i.test(name)) return 'codegraph';
  if (name === 'Grep' || name === 'Glob') return 'explore';
  if (name === 'Read' && CODE_EXT.test(String((toolInput && toolInput.file_path) || ''))) return 'explore';
  return null;
}

/**
 * Busca .codegraph/codegraph.db en dir o en sus ancestros. El home se para la
 * busqueda sin mirarlo: ~/.codegraph es el directorio global de CodeGraph, no
 * el indice de un proyecto, y haria pasar por indexada cualquier carpeta.
 */
function hasCodegraphIndex(dir, home = os.homedir()) {
  let cur = path.resolve(String(dir || ''));
  const stop = path.resolve(home).toLowerCase();
  for (let i = 0; i < 40; i++) {
    if (cur.toLowerCase() === stop) return false;
    if (fs.existsSync(path.join(cur, '.codegraph', 'codegraph.db'))) return true;
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
  return false;
}

/**
 * Transicion de estado. Pura: devuelve el estado nuevo y la decision.
 * state = { explore: n, usedCg: bool, denied: bool }
 */
function decide(state, kind) {
  const prev = { explore: 0, usedCg: false, denied: false, ...(state || {}) };
  if (kind === 'codegraph') return { state: { ...prev, usedCg: true }, deny: false };
  if (kind !== 'explore') return { state: prev, deny: false };
  const next = { ...prev, explore: prev.explore + 1 };
  if (prev.usedCg || prev.denied || next.explore < DENY_AT) return { state: next, deny: false };
  return { state: { ...next, denied: true }, deny: true };
}

function stateKey(payload) {
  const raw = `${payload.session_id || 'nosession'}__${payload.agent_id || 'main'}`;
  return raw.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 160);
}

function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function pruneOld(dir) {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (now - fs.statSync(p).mtimeMs > STATE_TTL_MS) fs.rmSync(p, { force: true });
    }
  } catch {
    /* limpieza best-effort */
  }
}

function main() {
  if (process.env.CLAUDE_NO_HOOKS === '1' || process.env.ULTRON_CODEGRAPH_FIRST === '0') return;
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return;
  }
  const kind = classifyTool(payload.tool_name, payload.tool_input);
  if (!kind) return;

  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stateKey(payload)}.json`);
  const current = readState(file);
  // Sin indice no se cuenta nada: el estado solo se crea donde el hook puede actuar.
  if (!current && kind === 'explore' && !hasCodegraphIndex(payload.cwd || process.cwd())) return;

  const { state, deny } = decide(current, kind);
  fs.writeFileSync(file, JSON.stringify(state));
  if (!current) pruneOld(dir);
  if (!deny) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: DENY_REASON,
      },
    }),
  );
}

if (require.main === module) {
  try {
    main();
  } catch {
    /* fail-open */
  }
  process.exitCode = 0;
} else {
  module.exports = { classifyTool, decide, hasCodegraphIndex, stateKey, DENY_AT };
}
