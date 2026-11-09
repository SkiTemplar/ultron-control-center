// usage-schedule-fit.selftest.mjs — checks herméticos de la recalibración del horario de
// uso (scripts/lib/usage-fit.mjs y scripts/usage-schedule-fit.mjs). Usa directorios
// temporales de transcripts, cache y horario: nunca toca ~/.claude ni ~/.ultron.
//
// Uso: node scripts/usage-schedule-fit.selftest.mjs   (exit 0 = verde)

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hoursToRanges, fitSchedule, applyFit } from './lib/usage-fit.mjs';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'usage-schedule-fit.mjs');
const { normalize } = require(join(HERE, '..', 'hooks', 'scripts', 'lib', 'usage-schedule.js'));

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

/** Matriz 7x24 con `occ` apariciones por dia y coste medio por hora dado por fn(dow, h). */
function matrix(fn, occ = 4) {
  const cost = Array.from({ length: 7 }, (_, dow) => Array.from({ length: 24 }, (_, h) => fn(dow, h) * occ));
  return { cost, occurrences: new Array(7).fill(occ) };
}

const scheduleOf = (raw) => normalize(raw).schedule;
// Franja baja de lunes a viernes: de 00:00 a 08:00.
const NIGHTS = { lowWeight: 0.12, baseWeight: { sat: 0.8, sun: 0.8 }, low: Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri'].map((d) => [d, [['00:00', '08:00']]])) };

test('hoursToRanges: agrupa horas contiguas', () => {
  assert.deepEqual(hoursToRanges([9, 10, 11, 15]), ['09:00-12:00', '15:00-16:00']);
  assert.deepEqual(hoursToRanges([23]), ['23:00-24:00']);
  assert.deepEqual(hoursToRanges([]), []);
  assert.deepEqual(hoursToRanges([5, 3, 4]), ['03:00-06:00'], 'no exige orden');
});

test('fitSchedule: mide lowWeight y el peso del fin de semana', () => {
  // Normal entre semana 10 $/h, franja baja 1 $/h, fin de semana 8 $/h.
  const m = matrix((dow, h) => (dow === 0 || dow === 6 ? 8 : h < 8 ? 1 : 10));
  const fit = fitSchedule(m, scheduleOf(NIGHTS));
  assert.equal(fit.sufficient, true);
  assert.ok(near(fit.lowWeight, 0.1), `lowWeight ${fit.lowWeight}`);
  assert.ok(near(fit.weekendWeight, 0.8), `weekendWeight ${fit.weekendWeight}`);
  assert.deepEqual(fit.lowButBusy, []);
  assert.deepEqual(fit.normalButQuiet, []);
});

test('fitSchedule: avisa de franjas bajas con uso alto y de horas normales vacias', () => {
  const m = matrix((dow, h) => {
    if (dow === 0 || dow === 6) return 8;
    if (dow === 2 && h === 3) return 9; // martes 03:00: declarada baja pero muy usada
    if (dow === 3 && h === 12) return 0.5; // miercoles 12:00: normal pero casi vacia
    return h < 8 ? 1 : 10;
  });
  const fit = fitSchedule(m, scheduleOf(NIGHTS));
  assert.deepEqual(fit.lowButBusy, [{ day: 'mar', ranges: ['03:00-04:00'] }]);
  assert.deepEqual(fit.normalButQuiet, [{ day: 'mié', ranges: ['12:00-13:00'] }]);
});

test('fitSchedule: sin datos suficientes no propone nada', () => {
  const m = matrix((dow, h) => (dow === 1 && h >= 9 && h <= 11 ? 5 : 0));
  const fit = fitSchedule(m, scheduleOf(NIGHTS));
  assert.equal(fit.sufficient, false);
  assert.match(fit.reason, /datos insuficientes/);
  assert.throws(() => applyFit(NIGHTS, fit), /datos insuficientes/);
});

test('applyFit: solo toca los pesos y conserva franjas y comentarios', () => {
  const raw = { _comment: 'mio', ...NIGHTS, baseWeight: { _nota: 'x', sat: 0.8, sun: 0.8 } };
  const next = applyFit(raw, { sufficient: true, lowWeight: 0.1234, weekendWeight: 0.9149 });
  assert.equal(next.lowWeight, 0.12);
  assert.equal(next.baseWeight.sat, 0.91);
  assert.equal(next.baseWeight.sun, 0.91);
  assert.equal(next._comment, 'mio');
  assert.equal(next.baseWeight._nota, 'x');
  assert.deepEqual(next.low, raw.low);
  assert.equal(raw.lowWeight, 0.12, 'no muta el original');
});

test('applyFit: acota los pesos a rangos validos para el horario', () => {
  const hi = applyFit(NIGHTS, { sufficient: true, lowWeight: 5, weekendWeight: 9 });
  assert.equal(hi.lowWeight, 1);
  assert.equal(hi.baseWeight.sat, 2);
  const lo = applyFit(NIGHTS, { sufficient: true, lowWeight: 0, weekendWeight: 0 });
  assert.equal(lo.lowWeight, 0.02);
  assert.equal(lo.baseWeight.sun, 0.1);
  assert.ok(normalize(lo).schedule, 'el resultado sigue siendo un horario valido');
});

// --- CLI de extremo a extremo -------------------------------------------------

/** Transcripts sinteticos: 4 semanas, 5 mensajes/h de 09 a 17 y 1 mensaje a las 03 (franja baja) entre semana. */
function makeWorkspace({ withData = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'usage-fit-selftest-'));
  const claude = join(dir, 'claude-projects');
  mkdirSync(join(claude, 'C--fx-demo'), { recursive: true });
  if (withData) {
    const lines = [];
    let n = 0;
    const usage = { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 10000, cache_creation_input_tokens: 2000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2000 } };
    const msg = (d, h) => {
      n += 1;
      const ts = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, 30).toISOString();
      lines.push(JSON.stringify({ timestamp: ts, message: { id: `m${n}`, model: 'claude-sonnet-5-5', usage } }));
    };
    for (let i = 1; i <= 28; i += 1) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      if (d.getDay() === 0 || d.getDay() === 6) continue;
      for (let h = 9; h <= 17; h += 1) for (let k = 0; k < 5; k += 1) msg(d, h);
      msg(d, 3);
    }
    writeFileSync(join(claude, 'C--fx-demo', 's.jsonl'), lines.join('\n'));
  }
  const schedule = join(dir, 'usage-schedule.json');
  const env = {
    ULTRON_CLAUDE_PROJECTS_DIR: claude,
    ULTRON_USAGE_CACHE_DIR: join(dir, 'cache'),
    ULTRON_USAGE_SCHEDULE_FILE: schedule,
  };
  return { dir, schedule, env };
}

function run(ws, args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...ws.env }, timeout: 60_000 });
  let json = null;
  try {
    json = JSON.parse(r.stdout.trim().split('\n').pop());
  } catch {
    /* json = null */
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

const CLI_SCHEDULE = { lowWeight: 0.12, baseWeight: { sat: 0.8, sun: 0.8 }, low: Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri'].map((d) => [d, [['03:00', '04:00']]])) };

test('CLI: informa sin cambiar nada y con --apply reescribe solo los pesos y guarda copia', () => {
  const ws = makeWorkspace();
  writeFileSync(ws.schedule, JSON.stringify({ _comment: 'mio', ...CLI_SCHEDULE }));
  const before = readFileSync(ws.schedule, 'utf8');

  const dry = run(ws, ['--json']);
  assert.equal(dry.status, 0, dry.stderr || dry.stdout);
  assert.equal(dry.json.ok, true);
  assert.equal(dry.json.applied, null);
  // Normal = 23 horas por dia con 45 mensajes en 9 de ellas; baja = 1 mensaje: 23/45.
  assert.ok(Math.abs(dry.json.fit.lowWeight - 23 / 45) < 1e-6, `lowWeight ${dry.json.fit.lowWeight}`);
  assert.equal(dry.json.fit.weekendWeight, 0);
  assert.equal(readFileSync(ws.schedule, 'utf8'), before, 'sin --apply no se escribe nada');
  assert.equal(existsSync(`${ws.schedule}.bak`), false);

  const done = run(ws, ['--apply', '--json']);
  assert.equal(done.status, 0, done.stderr || done.stdout);
  const written = JSON.parse(readFileSync(ws.schedule, 'utf8'));
  assert.equal(written.lowWeight, 0.51);
  assert.equal(written.baseWeight.sat, 0.1, 'sin uso en fin de semana: el peso se acota al minimo valido');
  assert.equal(written._comment, 'mio');
  assert.deepEqual(written.low, CLI_SCHEDULE.low, 'las franjas del usuario no se tocan');
  assert.equal(readFileSync(`${ws.schedule}.bak`, 'utf8'), before, 'la copia es el fichero original');
  rmSync(ws.dir, { recursive: true, force: true });
});

test('CLI: horario ausente o invalido termina con error y no toca el fichero', () => {
  const ws = makeWorkspace();
  const missing = run(ws, ['--json']);
  assert.equal(missing.status, 1);
  assert.equal(missing.json.error.code, 'NO_SCHEDULE');

  const broken = JSON.stringify({ lowWeight: 0, low: {} });
  writeFileSync(ws.schedule, broken);
  const invalid = run(ws, ['--apply', '--json']);
  assert.equal(invalid.status, 1);
  assert.equal(invalid.json.error.code, 'INVALID_SCHEDULE');
  assert.equal(readFileSync(ws.schedule, 'utf8'), broken);
  assert.equal(existsSync(`${ws.schedule}.bak`), false);
  rmSync(ws.dir, { recursive: true, force: true });
});

test('CLI: sin datos suficientes no propone ni escribe nada', () => {
  const ws = makeWorkspace({ withData: false });
  writeFileSync(ws.schedule, JSON.stringify(CLI_SCHEDULE));
  const r = run(ws, ['--apply', '--json']);
  assert.equal(r.status, 1);
  assert.equal(r.json.error.code, 'INSUFFICIENT_DATA');
  assert.equal(readFileSync(ws.schedule, 'utf8'), JSON.stringify(CLI_SCHEDULE));
  assert.equal(existsSync(`${ws.schedule}.bak`), false);
  rmSync(ws.dir, { recursive: true, force: true });
});

test('CLI: rechaza --weeks fuera de rango', () => {
  const ws = makeWorkspace();
  writeFileSync(ws.schedule, JSON.stringify(CLI_SCHEDULE));
  for (const w of ['0', '27', 'x']) {
    const r = run(ws, ['--weeks', w, '--json']);
    assert.equal(r.status, 1);
    assert.equal(r.json.error.code, 'BAD_ARGS');
  }
  rmSync(ws.dir, { recursive: true, force: true });
});
