#!/usr/bin/env node
/**
 * usage-outlook.mjs — cuanto te queda de verdad de la cuota semanal.
 *
 * Usa el ultimo snapshot de la statusline (rate_limits) y el horario de uso
 * (cockpit/usage-schedule.json): en vez de suponer un uso uniforme, reparte lo
 * que queda de cuota segun las horas en que realmente usas Claude. Un jueves
 * casi sin uso cuenta poco: el 80 % que sobra ese dia no es un problema.
 *
 * Uso: node scripts/usage-outlook.mjs
 * Sin horario valido (ver `node hooks/scripts/lib/usage-schedule.js --check`)
 * muestra solo el ritmo lineal y lo dice.
 *
 * Al final, en segundo plano, el uso de Codex y agy (hooks/scripts/lib/engine-usage.js).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { recentPace } from './lib/usage-hours-data.mjs';

const require = createRequire(import.meta.url);
const lib = path.join(import.meta.dirname, '..', 'hooks', 'scripts', 'lib');
const { windowPace, toEpochSeconds } = require(path.join(lib, 'usage-pace.js'));
const { loadSchedule, weightAt } = require(path.join(lib, 'usage-schedule.js'));
const { readEngines, describeEngine } = require(path.join(lib, 'engine-usage.js'));

const PAYLOAD = process.env.ULTRON_USAGE_PACE_PAYLOAD || path.join(os.homedir(), '.ultron', '.tmp', 'statusline-last-payload.json');
const STALE_MIN = 15;
const DAY_NAMES = ['dom', 'lun', 'mar', 'mie', 'jue', 'vie', 'sab'];
const f1 = (n) => n.toFixed(1).replace('.', ',');

/** Codex y agy despues de Claude, salga como salga lo de Claude; luego termina. */
function finish(code) {
  printRelativePace();
  const { engines, generatedAtMs } = readEngines();
  console.log('\nOtros motores:');
  for (const e of engines) console.log(describeEngine(e, generatedAtMs).map((l) => `  ${l}`).join('\n'));
  process.exit(code);
}

/** Tu ritmo frente a lo que sueles usar (transcripts): no depende del snapshot de la cuota. */
function printRelativePace() {
  try {
    const pace = recentPace({ weeks: 8 });
    if (!pace) {
      console.log('\nRitmo frente a tu media: faltan dos semanas completas de transcripts.');
      return;
    }
    const pct = (r) => (r === null ? 'n/d' : `${r >= 1 ? '+' : ''}${Math.round((r - 1) * 100)} %`);
    console.log(`\nRitmo frente a tu media de ${pace.baseline.weeks} semanas (ultimos 7 dias): gasto ${pct(pace.costRatio)}, horas trabajadas ${pct(pace.hoursRatio)}. Detalle: node scripts/usage-hours.mjs`);
  } catch (e) {
    console.log(`\nRitmo frente a tu media: no se pudo calcular (${e.message}).`);
  }
}

let payload;
let ageMin;
try {
  ageMin = (Date.now() - fs.statSync(PAYLOAD).mtimeMs) / 60000;
  payload = JSON.parse(fs.readFileSync(PAYLOAD, 'utf8'));
} catch {
  console.log(`Sin snapshot de la statusline (${PAYLOAD}). Abre una sesion de Claude Code y vuelve a probar.`);
  finish(1);
}
const week = payload.rate_limits && payload.rate_limits.seven_day;
if (!week) {
  console.log('El snapshot no trae la ventana semanal (seven_day).');
  finish(1);
}

const now = Date.now() / 1000;
const reset = toEpochSeconds(week.resets_at);
const p = windowPace('seven_day', week.used_percentage, week.resets_at, now);
const resetTxt = new Date(reset * 1000).toLocaleString('es-ES', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

console.log(`Semanal: ${f1(p.used)} % usado · reset ${resetTxt}` + (ageMin > STALE_MIN ? ` · OJO: snapshot de hace ${Math.round(ageMin)} min` : ''));
if (!p.scheduled) {
  console.log(`Sin horario valido: ritmo lineal ${Math.round(p.projectedPct)} % (tiempo transcurrido ${f1(p.linearElapsedPct)} %).`);
  finish(0);
}

const projected = p.projectedPct;
const left = Math.max(0, 100 - p.used);
console.log(`Uso esperado hasta ahora segun tu horario: ${f1(p.elapsedPct)} % (el tiempo va por el ${f1(p.linearElapsedPct)} %)`);
console.log(`Ritmo ${Math.round(projected)} %: si sigues tu patron llegas al reset con ${f1(Math.min(100, projected))} % usado, sobran ${f1(Math.max(0, 100 - projected))} % de cuota.`);
if (projected > 100) console.log('Vas a quedarte sin cuota antes del reset si sigues asi.');

// Reparto de lo que queda por dia natural, segun el peso de cada hora restante.
const schedule = loadSchedule();
const STEP = 900;
const perDay = new Map();
let totalW = 0;
for (let t = now; t < reset; t += STEP) {
  const seg = Math.min(STEP, reset - t);
  const d = new Date((t + seg / 2) * 1000);
  const key = `${DAY_NAMES[d.getDay()]} ${String(d.getDate()).padStart(2, '0')}`;
  const w = weightAt(d, schedule) * seg;
  perDay.set(key, (perDay.get(key) || 0) + w);
  totalW += w;
}
// Uso extra esperado hasta el reset si sigues tu patron (lo ya gastado / lo esperado hasta ahora).
const habitual = p.elapsedPct > 0 ? (p.used * (100 - p.elapsedPct)) / p.elapsedPct : 0;
console.log(`\nPor dia hasta el reset (habitual = a tu ritmo; maximo = sin pasarte de los ${f1(left)} % que quedan):`);
console.log('  dia      habitual   maximo');
for (const [key, w] of perDay) {
  const share = totalW > 0 ? w / totalW : 0;
  console.log(`  ${key}   ${f1(share * habitual).padStart(6)} %  ${f1(share * left).padStart(6)} %`);
}
finish(0);
