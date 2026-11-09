#!/usr/bin/env node
/**
 * Puente del mod ultron-uso con las librerias de ritmo de ULTRON.
 *
 * Entrada (stdin): { "rateLimits": [{ "kind", "percentUsed", "resetsAt" }] }, tal
 * como lo da `$.session.usage()`. Salida (stdout): JSON con cada ventana
 * (lib/usage-pace.js) y la hora a la que llega al 100 % al ritmo actual, mas
 * cuanto vale la semana en ventanas de 5 h segun logs/usage-history.jsonl.
 *
 * Ritmo = % usado entre el peso ya vivido de la ventana. En la semanal el peso
 * sale del horario (cockpit/usage-schedule.json); en la de 5 h, o sin horario,
 * cada hora pesa 1.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ULTRON_HOME = path.resolve(__dirname, '..', '..', '..');
const LIB = path.join(ULTRON_HOME, 'hooks', 'scripts', 'lib');
const HISTORY = path.join(ULTRON_HOME, 'logs', 'usage-history.jsonl');
const DAY_NAMES = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const STEP_S = 900;
// Ultimo cambio de plan (hora local): antes, la relacion 5 h / semana era otra.
// Al cambiar de plan, mover esta fecha al momento del cambio.
const PLAN_SINCE = new Date('2026-10-28T00:00:00');
const MIN_FIVE_HOUR_POINTS = 50;

const finite = (n) => (Number.isFinite(n) ? n : null);
const pad2 = (n) => String(n).padStart(2, '0');
const sameDay = (a, b) => a.toDateString() === b.toDateString();

/** `hoy 18:30`, `mañana 09:15` o `mié 07 18:30`, en hora local. */
function whenLabel(ms, nowMs) {
  const d = new Date(ms);
  const hour = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (sameDay(d, new Date(nowMs))) return `hoy ${hour}`;
  if (sameDay(d, new Date(nowMs + 86400000))) return `mañana ${hour}`;
  return `${DAY_NAMES[d.getDay()]} ${pad2(d.getDate())} ${hour}`;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { text += chunk; });
    process.stdin.on('end', () => resolve(text));
    process.stdin.on('error', reject);
  });
}

/** Recorre [fromSec, toSec) en tramos de 15 min: fn(inicio, duracion, peso del tramo). */
function walk(fromSec, toSec, weight, fn) {
  for (let t = fromSec; t < toSec; t += STEP_S) {
    const seg = Math.min(STEP_S, toSec - t);
    fn(t, seg, weight(new Date((t + seg / 2) * 1000)) * seg);
  }
}

/** Instante (ms) en que la ventana llega al 100 % al ritmo actual; null si llega antes al reset. */
function runsOutAtMs(used, startSec, nowSec, resetSec, weight) {
  if (used >= 100) return nowSec * 1000;
  let done = 0;
  walk(startSec, Math.min(nowSec, resetSec), weight, (_t, _s, w) => { done += w; });
  if (done <= 0 || used <= 0) return null;
  const rate = used / done;
  let acc = used;
  let hit = null;
  walk(nowSec, resetSec, weight, (t, seg, w) => {
    const add = rate * w;
    if (hit === null && acc + add >= 100) hit = t + (add > 0 ? ((100 - acc) / add) * seg : 0);
    acc += add;
  });
  return hit === null ? null : hit * 1000;
}

function windowOf(pace, weightFor, limit, nowSec) {
  const p = pace.windowPace(limit.kind, limit.percentUsed, limit.resetsAt, nowSec);
  if (!p) return null;
  const resetSec = pace.toEpochSeconds(limit.resetsAt);
  const startSec = resetSec - pace.windowSeconds(limit.kind);
  const weight = p.scheduled ? weightFor : () => 1;
  const outMs = runsOutAtMs(p.used, startSec, nowSec, resetSec, weight);
  return {
    kind: limit.kind,
    used: p.used,
    elapsedPct: p.elapsedPct,
    linearElapsedPct: p.linearElapsedPct,
    projectedPct: finite(p.projectedPct),
    isScheduled: p.scheduled,
    isAlert: Boolean(p.alert),
    resetsAtMs: resetSec * 1000,
    runsOutLabel: outMs === null ? null : whenLabel(outMs, nowSec * 1000),
  };
}

/**
 * Cuanto vale la semana en % de una ventana de 5 h: suma de puntos de 5 h entre
 * suma de puntos semanales gastados entre muestras consecutivas de la misma
 * pareja de ventanas desde PLAN_SINCE. null sin muestras suficientes.
 */
function weekInFiveHourPct() {
  let lines;
  try {
    lines = fs.readFileSync(HISTORY, 'utf8').split('\n');
  } catch {
    return null;
  }
  const since = PLAN_SINCE.toISOString();
  const samples = lines
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((s) => s && s.ts >= since && s.limites && s.limites.five_hour && s.limites.seven_day)
    .sort((a, b) => a.ts.localeCompare(b.ts));
  let five = 0;
  let week = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1].limites;
    const b = samples[i].limites;
    if (a.five_hour.resets_at !== b.five_hour.resets_at || a.seven_day.resets_at !== b.seven_day.resets_at) continue;
    const df = b.five_hour.pct - a.five_hour.pct;
    const dw = b.seven_day.pct - a.seven_day.pct;
    if (df < 0 || dw < 0) continue;
    five += df;
    week += dw;
  }
  return five >= MIN_FIVE_HOUR_POINTS && week > 0 ? (100 * five) / week : null;
}

async function main() {
  const input = JSON.parse((await readStdin()).trim() || '{}');
  const limits = Array.isArray(input.rateLimits) ? input.rateLimits : [];
  const pace = require(path.join(LIB, 'usage-pace.js'));
  const scheduleLib = require(path.join(LIB, 'usage-schedule.js'));
  const data = scheduleLib.loadSchedule();
  const weightFor = data ? (d) => scheduleLib.weightAt(d, data) : () => 1;
  const nowSec = Date.now() / 1000;
  const windows = limits.map((l) => windowOf(pace, weightFor, l, nowSec)).filter(Boolean);
  process.stdout.write(JSON.stringify({ windows, weekInFiveHourPct: weekInFiveHourPct() }));
}

main().catch((err) => {
  process.stderr.write(String((err && err.stack) || err));
  process.exit(1);
});
