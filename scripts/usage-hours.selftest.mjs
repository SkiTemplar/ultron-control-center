// usage-hours.selftest.mjs — checks herméticos del análisis de horas y ritmo
// (scripts/lib/usage-hours.mjs) y del CLI con transcripts falsos en directorios
// temporales: nunca toca ~/.claude ni ~/.ultron.
//
// Uso: node scripts/usage-hours.selftest.mjs   (exit 0 = verde)

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACTIVE_HOUR_USD, daySummary, fromFirstActivity, level, peakHours, relativePace, weekTotals, weekdayHourMatrix, weeksOf,
} from './lib/usage-hours.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'usage-hours.mjs');

/** `n` días consecutivos desde un lunes con el gasto por hora que da fn(díaÍndice, hora). */
function series(n, fn) {
  const days = [];
  const cost = new Map();
  for (let i = 0; i < n; i += 1) {
    const d = new Date(Date.UTC(2026, 9, 5 + i)).toISOString().slice(0, 10); // 2026-10-05 es lunes
    days.push(d);
    cost.set(d, Array.from({ length: 24 }, (_, h) => fn(i, h)));
  }
  return { days, cost };
}

test('daySummary cuenta solo las horas que llegan al umbral y da primera y última', () => {
  const hours = new Array(24).fill(0);
  hours[9] = ACTIVE_HOUR_USD;
  hours[10] = ACTIVE_HOUR_USD / 2;
  hours[18] = 3;
  const s = daySummary(hours);
  assert.equal(s.activeHours, 2);
  assert.equal(s.first, 9);
  assert.equal(s.last, 18);
  assert.equal(s.cost, ACTIVE_HOUR_USD * 1.5 + 3);
});

test('weeksOf parte desde el final y descarta la semana incompleta del principio', () => {
  const { days } = series(17, () => 0);
  const weeks = weeksOf(days);
  assert.equal(weeks.length, 2);
  assert.equal(weeks[1].at(-1), days.at(-1));
  assert.equal(weeks[0][0], days[3]);
});

test('relativePace compara la última semana con la media de las anteriores', () => {
  // Semanas 1-3: 10 $ y 1 h al día; semana 4: el doble de gasto y las mismas horas.
  const { days, cost } = series(28, (i, h) => (h === 10 ? (i >= 21 ? 20 : 10) : 0));
  const pace = relativePace(weekTotals(days, cost));
  assert.equal(pace.baseline.weeks, 3);
  assert.equal(pace.costRatio, 2);
  assert.equal(pace.hoursRatio, 1);
});

test('relativePace sin semanas de referencia devuelve null (caso negativo)', () => {
  const { days, cost } = series(7, () => 1);
  assert.equal(relativePace(weekTotals(days, cost)), null);
});

test('fromFirstActivity quita los días sin transcripts del principio, no los vacíos del medio', () => {
  const { days, cost } = series(10, (i, h) => (i >= 3 && i !== 5 && h === 12 ? 1 : 0));
  const kept = fromFirstActivity(days, cost);
  assert.equal(kept[0], days[3]);
  assert.equal(kept.length, 7);
  assert.deepEqual(fromFirstActivity(days, new Map()), []);
});

test('weekdayHourMatrix promedia por día de la semana y peakHours ordena las franjas', () => {
  // Dos lunes: a las 09 gastan 4 y 2 → media 3; dos martes: uno gasta 5 a las 22 → media 2,5.
  const { days, cost } = series(9, (i, h) => {
    if (i === 0 && h === 9) return 4;
    if (i === 7 && h === 9) return 2;
    if (i === 1 && h === 22) return 5;
    return 0;
  });
  const m = weekdayHourMatrix(days, cost);
  assert.equal(m.avg[1][9], 3);
  assert.equal(m.share[1][9], 1);
  const peaks = peakHours(m.avg, 2);
  assert.deepEqual(peaks.map((p) => [p.dow, p.hour]), [[1, 9], [2, 22]]);
  assert.equal(m.avg[2][22], 2.5);
});

test('level reparte la intensidad en 0-4', () => {
  assert.equal(level(0, 10), 0);
  assert.equal(level(10, 10), 4);
  assert.equal(level(1, 10), 1);
  assert.equal(level(5, 0), 0);
});

test('CLI: con menos de dos semanas de transcripts falla con un mensaje claro', () => {
  const root = mkdtempSync(join(tmpdir(), 'usage-hours-'));
  try {
    const projects = join(root, 'projects');
    mkdirSync(join(projects, 'C--p'), { recursive: true });
    const now = Date.UTC(2026, 10, 6, 12);
    const ts = new Date(now - 2 * 86400000).toISOString();
    const line = { type: 'assistant', timestamp: ts, requestId: 'r1', message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 1000000, output_tokens: 0 } } };
    writeFileSync(join(projects, 'C--p', 's.jsonl'), `${JSON.stringify(line)}\n`);
    const env = {
      ...process.env, ULTRON_CLAUDE_PROJECTS_DIR: projects, ULTRON_USAGE_CACHE_DIR: join(root, 'cache'),
      ULTRON_USAGE_NOW: String(now), ULTRON_CLAUDE_SETTINGS_FILE: join(root, 'no-existe.json'),
    };
    const r = spawnSync(process.execPath, [CLI], { env, encoding: 'utf8' });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /al menos dos semanas completas/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
