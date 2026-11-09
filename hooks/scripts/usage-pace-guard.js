#!/usr/bin/env node
/**
 * usage-pace-guard.js — UserPromptSubmit. Avisa al agente y al usuario cuando
 * el consumo del plan (ventana de 5 h o semanal) va por encima del ritmo que
 * permite llegar al reset: % usado > % de ventana transcurrido, con un suelo
 * de uso (lib/usage-pace.js). Ejemplo: 50 % usado con 1 h de 5 transcurrida
 * (20 %) proyecta un 250 % -> REDUCIR USO. NUNCA bloquea el prompt.
 *
 * Fuente: el snapshot que cockpit/statusline.js escribe con el ultimo payload
 * de Claude Code (rate_limits.*.used_percentage + resets_at). Sin red. Si el
 * snapshot tiene mas de STALE_MIN minutos, silencio (dato no fiable).
 *
 * Anti-ruido: el aviso de ritmo sale una vez por sesion y ventana (misma
 * resets_at) y se repite solo si la proyeccion sube REWARN_DELTA puntos o mas.
 * Las dos ventanas siguen la misma regla (el techo absoluto del 25 % en la de
 * 5 h se retiro el 2026-10-26).
 *
 * Horario inválido (cockpit/usage-schedule.json con JSON roto o reglas
 * incumplidas): el ritmo semanal pasa a lineal y el hook lo anota en
 * hook-errors.jsonl una vez por motivo y versión del fichero.
 *
 * Escape: ULTRON_USAGE_PACE=0. Umbrales (env): ULTRON_USAGE_PACE_STALE_MIN (15),
 * ULTRON_USAGE_PACE_REWARN (50).
 * Seams de test: ULTRON_USAGE_PACE_PAYLOAD, ULTRON_USAGE_PACE_STATE_DIR.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { paceAll } = require('./lib/usage-pace');
const { loadScheduleResult, scheduleFile } = require('./lib/usage-schedule');

const HOME = os.homedir();
const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
const STALE_MS = num(process.env.ULTRON_USAGE_PACE_STALE_MIN, 15) * 60 * 1000;
const REWARN_DELTA = num(process.env.ULTRON_USAGE_PACE_REWARN, 50);

const payloadPath = () =>
  process.env.ULTRON_USAGE_PACE_PAYLOAD || path.join(HOME, '.ultron', '.tmp', 'statusline-last-payload.json');
const stateDir = () => process.env.ULTRON_USAGE_PACE_STATE_DIR || path.join(HOME, '.ultron', 'run', 'usage-pace');
const safe = (id) => String(id || 'sin-sesion').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);

const LABELS = { five_hour: 'ventana de 5 h', seven_day: 'semanal' };
const label = (key) => LABELS[key] || key;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeState(sessionId, state) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    const p = path.join(stateDir(), `${safe(sessionId)}.json`);
    fs.writeFileSync(`${p}.tmp`, JSON.stringify(state));
    fs.renameSync(`${p}.tmp`, p);
  } catch {
    /* best effort: sin estado se repite el aviso */
  }
}

/** Tiempo hasta el reset en texto corto ("3 h 40 min", "4 d 2 h"). */
function untilReset(resetSec, nowSec) {
  const mins = Math.max(0, Math.round((resetSec - nowSec) / 60));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  if (h < 24) return mins % 60 ? `${h} h ${mins % 60} min` : `${h} h`;
  return h % 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : `${Math.floor(h / 24)} d`;
}

const fmtProjected = (p) => (Number.isFinite(p) ? `${Math.round(p)} %` : 'sin techo');

/**
 * Anota en el log del hook (hook-errors.jsonl) un horario de uso inválido, que
 * deja el ritmo semanal en lineal. Una sola vez por motivo y mtime del fichero
 * (marca en stateDir) para no escribir una línea por prompt.
 * @returns {string|null} el motivo, o null si el horario es válido o no existe
 */
function noteInvalidSchedule() {
  const { error } = loadScheduleResult();
  if (!error) return null;
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(scheduleFile()).mtimeMs;
  } catch {
    /* sin mtime: la marca se compara solo por motivo */
  }
  const marker = path.join(stateDir(), 'schedule-error.json');
  const prev = readJson(marker, {});
  if (prev.error === error && prev.mtimeMs === mtimeMs) return error;
  const obs = require('./lib/hook-obs');
  obs.logHookError('usage-pace-guard', `horario de uso inválido, ritmo semanal lineal: ${error}`);
  obs.annotate({ schedule: 'invalid' });
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ error, mtimeMs }));
  } catch {
    /* best effort: sin marca se vuelve a anotar en el siguiente prompt */
  }
  return error;
}

/**
 * Decide la salida del hook.
 * @param {object} input  payload de UserPromptSubmit ({session_id})
 * @param {{now?: number}} deps  ahora en ms (tests)
 * @returns {object|null} JSON de salida, o null = silencio
 */
function decide(input, deps = {}) {
  if (process.env.ULTRON_USAGE_PACE === '0' || process.env.CLAUDE_NO_HOOKS === '1') return null;
  noteInvalidSchedule();
  const nowMs = deps.now || Date.now();
  let mtime;
  try {
    mtime = fs.statSync(payloadPath()).mtimeMs;
  } catch {
    return null;
  }
  if (nowMs - mtime > STALE_MS) return null;

  const payload = readJson(payloadPath(), {});
  const paces = paceAll(payload.rate_limits, nowMs / 1000);
  const sessionId = input && input.session_id;
  const statePath = path.join(stateDir(), `${safe(sessionId)}.json`);
  const state = readJson(statePath, {});

  const paceFresh = [];
  const nextState = { ...state };
  for (const [key, p] of Object.entries(paces)) {
    if (!p.alert) continue;
    // Proyeccion sin techo (0 % de ventana transcurrida) como numero finito para el JSON.
    const projected = Number.isFinite(p.projectedPct) ? p.projectedPct : 1e6;
    const prev = state[key];
    const sameWindow = prev && prev.resetsAt === p.resetsAt;
    if (sameWindow && projected - Number(prev.projectedPct || 0) < REWARN_DELTA) continue;
    paceFresh.push([key, p]);
    nextState[key] = { resetsAt: p.resetsAt, projectedPct: projected };
  }
  if (!paceFresh.length) return null;
  writeState(sessionId, nextState);

  const nowSec = nowMs / 1000;
  const paceLines = paceFresh.map(([key, p]) =>
    `${label(key)}: ${Math.round(p.used)} % usado con ${Math.round(p.elapsedPct)} % ` +
    (p.scheduled
      ? `de uso esperado según tu horario (${Math.round(p.linearElapsedPct)} % del tiempo) `
      : 'de ventana transcurrida ') +
    `(ritmo ${fmtProjected(p.projectedPct)}; reset en ${untilReset(p.resetsAt, nowSec)})`
  );
  return {
    systemMessage: `ULTRON usage-pace: REDUCIR USO. ${paceLines.join(' | ')}`,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: [
        `[ULTRON usage-pace] REDUCIR USO: el consumo del plan pasa del ritmo que llega al reset.`,
        ...paceLines.map((l) => `- ${l}`),
        'Atiende el prompt, pero con menos gasto: no lances subagentes ni workflows salvo que sea imprescindible,',
        'usa lecturas acotadas (codegraph, offset/limit) y respuestas cortas. Menciona el aviso al usuario en una linea.',
      ].join('\n'),
    },
  };
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(data);
    };
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { data += c; });
      process.stdin.on('end', finish);
      process.stdin.on('error', finish);
    } catch {
      finish();
    }
    setTimeout(finish, 2500).unref();
  });
}

if (require.main === module) {
  require('./lib/hook-obs').observe('usage-pace-guard');
  (async () => {
    let out = null;
    try {
      out = decide(JSON.parse((await readStdin()) || '{}'));
    } catch (e) {
      try { require('./lib/hook-obs').logHookError('usage-pace-guard', e); } catch { /* ignore */ }
    }
    if (out) process.stdout.write(JSON.stringify(out), () => process.exit(0));
    else process.exit(0);
  })();
} else {
  module.exports = { decide, untilReset, noteInvalidSchedule };
}
