#!/usr/bin/env node
// usage-hours.mjs — tu ritmo frente a lo que sueles usar y tus horas punta.
//
// Lee los transcripts de Claude Code (todos los proyectos, misma caché que
// project-usage y usage-schedule-fit) y saca, en USD nocionales:
//   - el ritmo de los últimos 7 días frente a la media de las semanas anteriores,
//   - las semanas una a una (gasto, horas trabajadas, días con actividad),
//   - el perfil por día de la semana (horas trabajadas, horario típico),
//   - el mapa día × hora y las horas punta.
// Una hora cuenta como trabajada si gasta al menos ACTIVE_HOUR_USD.
//
// Uso: node scripts/usage-hours.mjs [--weeks 8] [--json]
// Overrides (tests): ULTRON_CLAUDE_PROJECTS_DIR, ULTRON_USAGE_CACHE_DIR, ULTRON_USAGE_NOW (ms).

import { loadRecentDays } from './lib/usage-hours-data.mjs';
import {
  ACTIVE_HOUR_USD, WEEK_ORDER, dowLabel, level, peakHours, relativePace, weekTotals, weekdayHourMatrix, weekdayProfile,
} from './lib/usage-hours.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const wi = args.indexOf('--weeks');
const weeks = wi >= 0 ? Number(args[wi + 1]) : 8;
if (!Number.isInteger(weeks) || weeks < 2 || weeks > 26) {
  console.error('[usage-hours] --weeks tiene que ser un entero entre 2 y 26');
  process.exit(2);
}
const now = process.env.ULTRON_USAGE_NOW ? Number(process.env.ULTRON_USAGE_NOW) : Date.now();

const data = loadRecentDays({ weeks, now });
const { retention, windowWeeks } = data;
if (data.days.length < 14) {
  console.error(`[usage-hours] hacen falta al menos dos semanas completas de transcripts (hay ${data.days.length} días)`);
  process.exit(1);
}
const totals = weekTotals(data.days, data.cost);
const pace = relativePace(totals);
const matrix = weekdayHourMatrix(data.days, data.cost);
const peaks = peakHours(matrix.avg, 10);
const profile = weekdayProfile(data.days, data.cost);

if (json) {
  console.log(JSON.stringify({ ok: true, window: { from: data.days[0], to: data.days.at(-1), weeks: totals.length }, activeHourUsd: ACTIVE_HOUR_USD, pace, weeks: totals, profile, peaks, matrix }));
  process.exit(0);
}

const usd = (n) => `${Math.round(n).toLocaleString('es-ES')} $`;
const num = (n, d = 1) => (n === null ? 'n/d' : n.toFixed(d).replace('.', ','));
const pct = (r) => (r === null ? 'n/d' : `${r >= 1 ? '+' : ''}${Math.round((r - 1) * 100)} %`);
const hh = (h) => (h === null ? '—' : `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`);

const capped = windowWeeks < weeks ? ` · tope de ${windowWeeks} semanas: Claude Code borra los transcripts a los ${retention} días (cleanupPeriodDays)` : '';
console.log(`Ventana: ${data.days[0]} a ${data.days.at(-1)} (${totals.length} semanas completas con transcripts${capped}, ${usd(data.totalCost)} nocionales; hora trabajada = gasto >= ${num(ACTIVE_HOUR_USD, 2)} $)\n`);

if (pace) {
  console.log(`Ritmo de los últimos 7 días frente a tu media de ${pace.baseline.weeks} semanas:`);
  console.log(`  gasto  ${usd(pace.last.cost)} frente a ${usd(pace.baseline.cost)}  (${pct(pace.costRatio)})`);
  console.log(`  horas  ${pace.last.activeHours} h frente a ${num(pace.baseline.activeHours)} h  (${pct(pace.hoursRatio)})\n`);
}

console.log('Semana            gasto      horas  días');
for (const w of totals) console.log(`${w.from.slice(5)} → ${w.to.slice(5)}   ${usd(w.cost).padStart(8)}   ${String(w.activeHours).padStart(4)} h   ${w.activeDays}/7`);

console.log('\nDía   horas/día  gasto/día  empieza  termina');
for (const p of profile) console.log(`${dowLabel(p.dow).padEnd(5)} ${num(p.activeHours).padStart(8)}   ${usd(p.cost).padStart(8)}   ${hh(p.first).padStart(6)}   ${hh(p.last).padStart(6)}`);

const max = Math.max(...matrix.avg.flat());
const BLOCK = [' ·', ' ░', ' ▒', ' ▓', ' █'];
console.log('\nMapa día × hora (gasto medio; █ = máximo):');
console.log(`      ${Array.from({ length: 24 }, (_, h) => String(h).padStart(2)).join('')}`);
for (const dow of WEEK_ORDER) console.log(`${dowLabel(dow).padEnd(5)} ${matrix.avg[dow].map((c) => BLOCK[level(c, max)]).join('')}`);

console.log('\nHoras punta (gasto medio por hora · % de esos días en que trabajas a esa hora):');
for (const p of peaks) console.log(`  ${dowLabel(p.dow)} ${String(p.hour).padStart(2, '0')}:00  ${usd(p.avg).padStart(6)}  ${Math.round(matrix.share[p.dow][p.hour] * 100)} %`);
