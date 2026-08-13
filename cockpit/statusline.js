#!/usr/bin/env node
// cockpit/statusline.js — statusline custom de Claude Code (card vy7sve).
//
// Pinta: ⚡ PROYECTO (color estable por nombre) · rama git · modelo · 🎭 tono
// activo (el último que el orchestrate detectó para ESTA sesión, leído del
// log orchestrate.jsonl — misma fuente que el Live Session Monitor).
//
// Contrato Claude Code: recibe JSON por stdin (model.display_name,
// workspace.current_dir, session_id, …) y la PRIMERA línea de stdout es la
// statusline (ANSI permitido). Fail-safe: ante cualquier error pinta una
// línea mínima y sale 0 — una statusline rota no puede tumbar la terminal.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// Overrides SOLO para test (nunca en producción): permiten probar la lectura
// del tono sin depender del log real de la sesión viva.
const ORCH_LOG =
  process.env.ULTRON_STATUSLINE_ORCH_LOG ||
  path.join(os.homedir(), '.claude', 'logs', 'orchestrate.jsonl');
const TONE_STATUS_PATH =
  process.env.ULTRON_STATUSLINE_TONE_STATUS ||
  path.join(os.homedir(), '.ultron', 'cockpit', 'tone-status.json');

/** Status por personalidad (tone-status.json, editable por el usuario). */
function toneStatusVerb(toneId) {
  if (!toneId) return '';
  try {
    const map = JSON.parse(fs.readFileSync(TONE_STATUS_PATH, 'utf8'));
    const v = map[toneId];
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}

// Paleta ANSI-256 con contraste alto sobre fondo oscuro (nada de blanco plano).
const PALETTE = [45, 208, 118, 199, 214, 81, 141, 220, 203, 84, 39, 172];

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

function color256(n) {
  return `\x1b[38;5;${n}m`;
}

/** Hash estable → cada proyecto SIEMPRE sale del mismo color. */
function projectColor(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function projectName(cwd) {
  const base = path.basename(String(cwd || '')).replace(/^\.+/, '');
  return base || 'sin-proyecto';
}

function gitBranch(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/** Último tono detectado para esta sesión (orchestrate.jsonl, cola del log). */
function activeTone(sessionId) {
  if (!sessionId) return '';
  try {
    const raw = fs.readFileSync(ORCH_LOG, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean).slice(-80);
    for (let i = lines.length - 1; i >= 0; i--) {
      let e;
      try { e = JSON.parse(lines[i]); } catch { continue; }
      if (e.session_id !== sessionId) continue;
      if (e.tone && e.tone.id) return e.tone.id;
      return ''; // el último prompt de esta sesión fue sin tono → default
    }
  } catch {
    /* sin log → sin tono */
  }
  return '';
}

/** % redondeado o null (payload trae used_percentage pre-calculado). */
function pct(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Color por umbral de consumo: verde <60, amarillo 60-84, rojo >=85. */
function usageColor(p) {
  if (p >= 85) return color256(196);
  if (p >= 60) return color256(214);
  return color256(114);
}

function main() {
  let inp = {};
  try {
    inp = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    /* stdin ilegible → defaults */
  }

  const cwd =
    (inp.workspace && (inp.workspace.current_dir || inp.workspace.cwd)) ||
    inp.cwd ||
    process.cwd();
  const project = projectName(cwd);
  const pcol = color256(projectColor(project));
  const model = (inp.model && (inp.model.display_name || inp.model.id)) || '';
  const branch = gitBranch(cwd);
  const tone = activeTone(inp.session_id || inp.sessionId || '');

  const parts = [`${pcol}${BOLD}⚡ ${project.toUpperCase()}${RESET}`];
  if (branch) parts.push(`${color256(245)} ${branch}${RESET}`);
  if (model) parts.push(`${DIM}${model}${RESET}`);

  // Contexto actual (payload v2.1.x: context_window.used_percentage, 0-100).
  const ctxPct = pct(inp.context_window && inp.context_window.used_percentage);
  if (ctxPct !== null) parts.push(`${usageColor(ctxPct)}▓ ctx ${ctxPct}%${RESET}`);

  // Límites de suscripción (rate_limits.five_hour / seven_day; solo presentes
  // tras la primera respuesta de la API en cuentas de suscripción).
  const rl = inp.rate_limits || {};
  const fh = rl.five_hour ? pct(rl.five_hour.used_percentage) : null;
  if (fh !== null) parts.push(`${usageColor(fh)}5h ${fh}%${RESET}`);
  const sd = rl.seven_day ? pct(rl.seven_day.used_percentage) : null;
  if (sd !== null) parts.push(`${usageColor(sd)}wk ${sd}%${RESET}`);

  if (tone) {
    const verb = toneStatusVerb(tone);
    const label = verb ? `${tone} · ${verb}` : tone;
    parts.push(`${color256(213)}🎭 ${label}${RESET}`);
  }

  process.stdout.write(parts.join(`${DIM} · ${RESET}`));
}

try {
  main();
} catch {
  process.stdout.write('⚡ ULTRON');
} finally {
  process.exitCode = 0;
}
