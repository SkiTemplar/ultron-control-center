#!/usr/bin/env node
// usage-schedule-fit.mjs — recalibra los pesos del horario de uso con el gasto real.
//
// Lee los transcripts de Claude Code (todos los proyectos), mide cuanto se gasta por
// hora de la semana y lo compara con las franjas de cockpit/usage-schedule.json:
//   - cuanto pesa una hora de franja baja frente a una normal (lowWeight),
//   - cuanto pesa el fin de semana (baseWeight sat/sun),
//   - que franjas declaradas bajas se usan mucho, y que horas normales estan casi vacias.
// Con --apply reescribe SOLO los pesos (guarda una copia .bak); las franjas son del usuario.
//
// Uso:
//   node scripts/usage-schedule-fit.mjs [--weeks 4] [--apply] [--json]
//
// Overrides (tests): ULTRON_USAGE_SCHEDULE_FILE, ULTRON_CLAUDE_PROJECTS_DIR, ULTRON_USAGE_CACHE_DIR.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { hourlyCostMatrix } from './lib/usage-transcripts.mjs';
import { fitSchedule, applyFit } from './lib/usage-fit.mjs';

const require = createRequire(import.meta.url);
const { normalize, scheduleFile } = require(path.join(import.meta.dirname, '..', 'hooks', 'scripts', 'lib', 'usage-schedule.js'));

const args = process.argv.slice(2);
const json = args.includes('--json');
const apply = args.includes('--apply');
const wIdx = args.indexOf('--weeks');
const weeks = wIdx >= 0 ? Number(args[wIdx + 1]) : 4;

function fail(code, message) {
  if (json) console.log(JSON.stringify({ ok: false, error: { code, message } }));
  else console.error(`[usage-schedule-fit] ERROR (${code}): ${message}`);
  process.exit(1);
}

if (!Number.isInteger(weeks) || weeks < 1 || weeks > 26) fail('BAD_ARGS', '--weeks debe ser un entero entre 1 y 26');

const file = scheduleFile();
let raw;
try {
  raw = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
  fail('NO_SCHEDULE', `no se pudo leer ${file}: ${e.code === 'ENOENT' ? 'no existe (copia cockpit/usage-schedule.example.json)' : e.message}`);
}
const { schedule, error } = normalize(raw);
if (!schedule) fail('INVALID_SCHEDULE', `${file} es invalido: ${error}. No se toca.`);

const matrix = hourlyCostMatrix({ weeks });
const fit = fitSchedule(matrix, schedule);
const pct = (n) => (n === null || n === undefined ? 'n/d' : n.toFixed(2).replace('.', ','));
const usd = (n) => `${n.toFixed(2).replace('.', ',')} $`;

if (!fit.sufficient) {
  if (json) console.log(JSON.stringify({ ok: false, error: { code: 'INSUFFICIENT_DATA', message: fit.reason } }));
  else console.error(`[usage-schedule-fit] ${fit.reason}. No se propone ningún cambio.`);
  process.exit(1);
}

let applied = null;
if (apply) {
  const next = applyFit(raw, fit);
  fs.copyFileSync(file, `${file}.bak`);
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  applied = { lowWeight: next.lowWeight, sat: next.baseWeight && next.baseWeight.sat, sun: next.baseWeight && next.baseWeight.sun, backup: `${file}.bak` };
}

if (json) {
  console.log(JSON.stringify({ ok: true, window: { from: matrix.from, to: matrix.to, weeks }, current: { lowWeight: schedule.lowWeight, baseWeight: schedule.baseWeight }, fit, applied }));
  process.exit(0);
}

console.log(`Ventana analizada: ${matrix.from} a ${matrix.to} (${weeks} semanas, ${usd(matrix.totalCost)} nocionales)`);
console.log(`Gasto medio por hora: normal ${usd(fit.means.normal)} · franja baja ${fit.means.low === null ? 'n/d' : usd(fit.means.low)} · fin de semana ${fit.means.weekend === null ? 'n/d' : usd(fit.means.weekend)}`);
console.log(`lowWeight:  actual ${pct(schedule.lowWeight)} · medido ${pct(fit.lowWeight)}`);
console.log(`fin de semana: actual ${pct(schedule.baseWeight.sat ?? 1)} · medido ${pct(fit.weekendWeight)}`);
if (fit.lowButBusy.length) {
  console.log('\nFranjas declaradas bajas donde SÍ usas Claude (media >= la mitad de una hora normal):');
  for (const d of fit.lowButBusy) console.log(`  ${d.day}: ${d.ranges.join(', ')}`);
}
if (fit.normalButQuiet.length) {
  console.log('\nHoras normales entre semana casi vacías (media <= 10 % de una hora normal):');
  for (const d of fit.normalButQuiet) console.log(`  ${d.day}: ${d.ranges.join(', ')}`);
}
if (applied) {
  console.log(`\nAplicado: lowWeight ${pct(applied.lowWeight)}${applied.sat !== undefined ? `, sáb/dom ${pct(applied.sat)}` : ''}. Copia en ${applied.backup}`);
} else {
  console.log('\nSin cambios. Añade --apply para escribir los pesos medidos (las franjas no se tocan).');
}
