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

// Paleta ANSI-256 MUTED (rediseño 2026-08-13, feedback del usuario: "menos
// goofy, más profesional"): tonos acero/cobre/salvia apagados, cero neón.
const PALETTE = [67, 109, 138, 173, 108, 103, 74, 137, 95, 144, 66, 132];

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

/** Valor de consumo: gris neutro <60, ámbar apagado 60-84, rojo seco >=85. */
function usageColor(p) {
  if (p >= 85) return color256(160);
  if (p >= 60) return color256(178);
  return color256(250);
}

/** Mini-barra: llenas en el color del umbral, vacías en gris. 10 celdas
 *  (una por cada 10%) — el usuario pidió más resolución que las 5 iniciales. */
const BAR_CELLS = 10;
function bar(p) {
  const filled = Math.max(0, Math.min(BAR_CELLS, Math.round((p / 100) * BAR_CELLS)));
  return (
    usageColor(p) + '▰'.repeat(filled) + color256(238) + '▱'.repeat(BAR_CELLS - filled) + RESET
  );
}

/** Métrica con etiqueta apagada, mini-barra y valor. */
function metric(label, p) {
  return `${color256(240)}${label} ${bar(p)} ${usageColor(p)}${p}%${RESET}`;
}

/** Etiquetas cortas por ventana de rate limit. Claves desconocidas se
 *  renderizan igualmente (mayúsculas recortadas): si el binario añade p.ej.
 *  seven_day_opus al payload (existe en sus strings pero NO en los docs del
 *  statusline), aparece solo — sin esperar a otra release nuestra. */
const RATE_LABELS = {
  five_hour: '5H',
  seven_day: 'WK',
  seven_day_opus: 'FBL',
  seven_day_sonnet: 'SNT',
};

function rateLabel(key) {
  if (RATE_LABELS[key]) return RATE_LABELS[key];
  return String(key).replace(/[^a-z0-9]/gi, '').slice(0, 3).toUpperCase() || 'LIM';
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

  // Diseño "professional hard" (2026-08-13): sin emojis, barra de acento ▌ en
  // el color del proyecto como única marca, etiquetas MAYÚSCULAS apagadas,
  // separador │ fino; el color solo aparece cuando una métrica arde.
  const parts = [`${pcol}${BOLD}▌${project.toUpperCase()}${RESET}`];
  if (branch) parts.push(`${color256(245)}${branch}${RESET}`);
  if (model) parts.push(`${color256(250)}${model.toUpperCase()}${RESET}`);

  // Contexto actual (payload v2.1.x: context_window.used_percentage, 0-100).
  const ctxPct = pct(inp.context_window && inp.context_window.used_percentage);
  if (ctxPct !== null) parts.push(metric('CTX', ctxPct));

  // Límites de suscripción (rate_limits.*; presentes tras la primera
  // respuesta de la API). Se renderiza TODA clave con used_percentage, no
  // solo las documentadas — a la caza del límite semanal por-modelo.
  const rl = inp.rate_limits || {};
  for (const key of Object.keys(rl)) {
    const p = rl[key] ? pct(rl[key].used_percentage) : null;
    if (p !== null) parts.push(metric(rateLabel(key), p));
  }

  // Snapshot best-effort del último payload real (receipts para verificar
  // qué claves llegan de verdad en sesiones vivas). Nunca rompe la barra.
  try {
    fs.writeFileSync(
      path.join(os.homedir(), '.ultron', '.tmp', 'statusline-last-payload.json'),
      JSON.stringify(inp),
    );
  } catch {
    /* best-effort */
  }

  // Badges de sesión: effort si viene, FAST solo cuando está activo.
  const effort = inp.effort && (inp.effort.level || inp.effort);
  if (typeof effort === 'string' && effort) {
    parts.push(`${color256(240)}E:${color256(250)}${effort.toUpperCase()}${RESET}`);
  }
  if (inp.fast_mode === true) parts.push(`${BOLD}${color256(255)}FAST${RESET}`);

  if (tone) {
    const verb = toneStatusVerb(tone);
    const label = (verb ? `${tone}·${verb}` : tone).toUpperCase();
    parts.push(`${color256(139)}${label}${RESET}`);
  }

  process.stdout.write(parts.join(` ${color256(238)}│${RESET} `));
}

try {
  main();
} catch {
  process.stdout.write('⚡ ULTRON');
} finally {
  process.exitCode = 0;
}
