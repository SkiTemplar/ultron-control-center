// engine-usage.selftest.mjs — checks herméticos de hooks/scripts/lib/engine-usage.js
// (uso de Codex y agy), de scripts/engine-usage.mjs y de la ficha de la statusline.
// Todo sale de directorios temporales: nunca lee ~/.codex ni ~/.gemini ni lanza agy.
//
// Uso: node hooks/scripts/engine-usage.selftest.mjs   (exit 0 = verde)

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const require = createRequire(import.meta.url);
const eu = require(join(HERE, 'lib', 'engine-usage.js'));

const NOW = Date.parse('2026-10-19T00:00:00Z');
const S = (ms) => Math.floor(ms / 1000);
const H = 3600000;

const dirs = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'engine-usage-'));
  dirs.push(d);
  return d;
}
test.after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Evento `token_count` de un rollout de Codex. */
function codexEvent({ five = 6, week = 2, fiveReset = NOW + 2 * H, weekReset = NOW + 100 * H, ts = NOW - 60000, limitId = 'codex' } = {}) {
  return JSON.stringify({
    timestamp: new Date(ts).toISOString(),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        limit_id: limitId,
        primary: { used_percent: five, window_minutes: 300, resets_at: S(fiveReset) },
        secondary: { used_percent: week, window_minutes: 10080, resets_at: S(weekReset) },
        plan_type: 'plus',
      },
    },
  });
}

function codexHome(files) {
  const home = tmp();
  const day = join(home, 'sessions', '2026', '10', '18');
  mkdirSync(day, { recursive: true });
  files.forEach(({ name, lines, mtimeMs }) => {
    const f = join(day, name);
    writeFileSync(f, `${lines.join('\n')}\n`);
    utimesSync(f, new Date(mtimeMs), new Date(mtimeMs));
  });
  return home;
}

/** Salida real (recortada) de `agy -p /usage --output-format json`. */
function agyJson({ geminiWeek = 0.98, gemini5h = 0.94, weekReset = NOW + 150 * H, fiveReset = NOW + 3 * H } = {}) {
  return {
    status: 'SUCCESS',
    num_turns: 0,
    command: {
      name: 'usage',
      data: {
        groups: [
          { name: 'Gemini Models', buckets: [
            { id: 'gemini-weekly', window: 'weekly', remaining_fraction: geminiWeek, reset_time: new Date(weekReset).toISOString() },
            { id: 'gemini-5h', window: '5h', remaining_fraction: gemini5h, reset_time: new Date(fiveReset).toISOString() },
          ] },
          { name: 'Claude and GPT models', buckets: [
            { id: '3p-5h', window: '5h', remaining_fraction: 1, reset_time: new Date(fiveReset).toISOString() },
          ] },
        ],
      },
    },
  };
}

function agyHomeWithTranscript(steps) {
  const home = tmp();
  const logs = join(home, 'brain', 'conv-1', '.system_generated', 'logs');
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, 'transcript.jsonl'), `${steps.map((s) => (typeof s === 'string' ? s : JSON.stringify(s))).join('\n')}\n`);
  return home;
}

const planner = (agoMs, input, output) => ({ type: 'PLANNER_RESPONSE', created_at: new Date(NOW - agoMs).toISOString(), input_tokens: input, output_tokens: output });

test('Codex sin directorio: estado none y sin ventanas', () => {
  const e = eu.readCodexUsage({ codexHome: join(tmp(), 'no-existe'), nowMs: NOW });
  assert.equal(e.status, 'none');
  assert.deepEqual(e.windows, []);
  assert.match(e.note, /no existe/);
});

test('Codex: última lectura válida del rollout más nuevo; ignora líneas rotas y otros limit_id', () => {
  const home = codexHome([{
    name: 'rollout-a.jsonl',
    mtimeMs: NOW - 1000,
    lines: [codexEvent({ five: 1, week: 1 }), codexEvent({ five: 6, week: 2 }), '{"timestamp":"x","payload":{"rate_limits":', codexEvent({ five: 99, limitId: 'otro' })],
  }]);
  const e = eu.readCodexUsage({ codexHome: home, nowMs: NOW });
  assert.equal(e.status, 'ok');
  assert.equal(e.plan, 'plus');
  assert.deepEqual(e.windows.map((w) => [w.kind, w.usedPct, w.expired]), [['five_hour', 6, false], ['seven_day', 2, false]]);
  assert.equal(e.readAtMs, NOW - 60000);
  assert.equal(e.note, null);
});

test('Codex: si el rollout más nuevo aún no trae límites, usa el anterior', () => {
  const home = codexHome([
    { name: 'rollout-viejo.jsonl', mtimeMs: NOW - 5 * H, lines: [codexEvent({ five: 30, week: 9 })] },
    { name: 'rollout-nuevo.jsonl', mtimeMs: NOW - 1000, lines: ['{"type":"session_meta"}', 'no es json'] },
  ]);
  const e = eu.readCodexUsage({ codexHome: home, nowMs: NOW });
  assert.deepEqual(e.windows.map((w) => w.usedPct), [30, 9]);
});

test('Codex: resets_at vencido = uso desconocido, nunca el % viejo', () => {
  const home = codexHome([{ name: 'rollout-a.jsonl', mtimeMs: NOW, lines: [codexEvent({ five: 80, fiveReset: NOW - 60000 })] }]);
  const e = eu.readCodexUsage({ codexHome: home, nowMs: NOW });
  const five = e.windows.find((w) => w.kind === 'five_hour');
  assert.equal(five.usedPct, null);
  assert.equal(five.expired, true);
  assert.match(e.note, /desconocido/);
  assert.equal(eu.compactToken(e, 'CX'), 'CX ?/2%');
});

test('Codex: ningún rollout con rate_limits', () => {
  const home = codexHome([{ name: 'rollout-a.jsonl', mtimeMs: NOW, lines: ['{"type":"session_meta"}'] }]);
  const e = eu.readCodexUsage({ codexHome: home, nowMs: NOW });
  assert.equal(e.status, 'none');
  assert.match(e.note, /rate_limits/);
});

test('agy /usage: % usado = 1 - remaining_fraction, 5 h antes que la semana, y caché', () => {
  const cachePath = join(tmp(), 'agy-usage.json');
  let calls = 0;
  const run = () => {
    calls += 1;
    return { json: agyJson() };
  };
  const e = eu.readAgyUsage({ agyHome: tmp(), cachePath, nowMs: NOW, run });
  assert.equal(e.status, 'ok');
  assert.equal(e.source, 'agy-usage');
  assert.deepEqual(e.windows.map((w) => [w.group, w.kind, Math.round(w.usedPct)]), [
    ['Gemini Models', 'five_hour', 6], ['Gemini Models', 'seven_day', 2], ['Claude and GPT models', 'five_hour', 0],
  ]);
  assert.equal(eu.compactToken(e, 'AG'), 'AG 6/2%');
  assert.ok(existsSync(cachePath), 'escribe la caché');
  eu.readAgyUsage({ agyHome: tmp(), cachePath, nowMs: NOW + 60000, run });
  assert.equal(calls, 1, 'la caché fresca evita relanzar agy');
  eu.readAgyUsage({ agyHome: tmp(), cachePath, nowMs: NOW + 60000, run, force: true });
  assert.equal(calls, 2, 'force salta la caché');
  const fromCache = eu.readAgyUsage({ cachePath, nowMs: NOW + 60000, allowSpawn: false });
  assert.equal(fromCache.readAtMs, NOW + 60000);
});

test('agy sin cuota en /usage: actividad de los transcripts, sin porcentaje', () => {
  const home = agyHomeWithTranscript([
    planner(H, 1000, 200),
    planner(30 * H, 5000, 500),
    planner(10 * 24 * H, 9999, 9999),
    { type: 'USER_INPUT', created_at: new Date(NOW - H).toISOString() },
    'línea rota {',
  ]);
  const run = () => ({ json: { status: 'SUCCESS', response: 'hola' } });
  const e = eu.readAgyUsage({ agyHome: home, cachePath: join(tmp(), 'c.json'), nowMs: NOW, run });
  assert.equal(e.status, 'ok');
  assert.equal(e.source, 'activity');
  assert.deepEqual(e.windows, [], 'sin límite conocido no hay porcentaje');
  assert.deepEqual(e.activity, { fiveHour: { turns: 1, tokens: 1200 }, sevenDay: { turns: 2, tokens: 6700 } });
  assert.match(e.note, /sin límite conocido/);
  assert.equal(eu.compactToken(e, 'AG'), null);
  assert.match(eu.describeEngine(e, NOW).join('\n'), /actividad sin límite conocido/);
});

test('agy ausente: sin binario ni carpeta = error explícito; statusline sin caché = none', () => {
  const run = () => ({ error: "no se encontró 'agy' en el PATH" });
  const e = eu.readAgyUsage({ agyHome: join(tmp(), 'no'), cachePath: join(tmp(), 'c.json'), nowMs: NOW, run });
  assert.equal(e.status, 'error');
  assert.match(e.note, /PATH/);
  const s = eu.readAgyUsage({ cachePath: join(tmp(), 'c.json'), nowMs: NOW, allowSpawn: false });
  assert.equal(s.status, 'none');
});

test('Codex: caché — un acierto no relee la cola; mtime nuevo o force la invalidan', () => {
  const name = 'rollout-a.jsonl';
  const mtime = NOW - 1000;
  const home = codexHome([{ name, mtimeMs: mtime, lines: [codexEvent({ five: 6 })] }]);
  const file = join(home, 'sessions', '2026', '10', '18', name);
  const codexCachePath = join(tmp(), 'codex-usage.json');
  const TTL = eu.CODEX_CACHE_TTL_MS;
  /** Mismo tamaño y, salvo que se diga, mismo mtime: solo una relectura lo ve. */
  const rewrite = (five, mtimeMs = mtime) => {
    writeFileSync(file, `${codexEvent({ five })}\n`);
    utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  };
  const five = (nowMs, extra = {}) => eu.readCodexUsage({ codexHome: home, codexCachePath, nowMs, ...extra }).windows[0].usedPct;

  assert.equal(five(NOW), 6);
  assert.ok(existsSync(codexCachePath), 'escribe la caché');
  rewrite(7);
  assert.equal(five(NOW + 10000), 6, 'dentro del plazo no mira el disco');
  const t1 = NOW + TTL + 1000;
  assert.equal(five(t1), 6, 'pasado el plazo, misma ruta+mtime+tamaño: no relee la cola');
  rewrite(7, mtime + 5000);
  assert.equal(five(t1 + 1000), 6, 'el plazo se renueva al comprobar la clave');
  assert.equal(five(t1 + TTL + 1000), 7, 'mtime nuevo: relee');
  rewrite(8, mtime + 5000);
  assert.equal(five(t1 + TTL + 2000, { force: true }), 8, 'force salta la caché');
});

test('Codex: la caducidad de las ventanas se recalcula al servir desde la caché', () => {
  const home = codexHome([{ name: 'rollout-a.jsonl', mtimeMs: NOW, lines: [codexEvent({ five: 40, fiveReset: NOW + 10000 })] }]);
  const codexCachePath = join(tmp(), 'codex-usage.json');
  const first = eu.readCodexUsage({ codexHome: home, codexCachePath, nowMs: NOW });
  assert.equal(first.windows[0].usedPct, 40);
  const later = eu.readCodexUsage({ codexHome: home, codexCachePath, nowMs: NOW + 30000 });
  assert.equal(later.windows[0].expired, true);
  assert.equal(later.windows[0].usedPct, null, 'nunca el % de antes del reinicio');
});

test('Codex: caso negativo — con `codexHome` explícito y sin ruta de caché, cada lectura va al disco', () => {
  const name = 'rollout-a.jsonl';
  const home = codexHome([{ name, mtimeMs: NOW, lines: [codexEvent({ five: 6 })] }]);
  const file = join(home, 'sessions', '2026', '10', '18', name);
  assert.equal(eu.readCodexUsage({ codexHome: home, nowMs: NOW }).windows[0].usedPct, 6);
  writeFileSync(file, `${codexEvent({ five: 7 })}
`);
  utimesSync(file, new Date(NOW), new Date(NOW));
  assert.equal(eu.readCodexUsage({ codexHome: home, nowMs: NOW + 1000 }).windows[0].usedPct, 7);
});

/** Sondeos de la pestaña Uso cada `pollMs` (con 50 ms de deriva) durante una hora; cuántas veces se lanza agy. */
function agySpawnsWithPoll(pollMs) {
  const cachePath = join(tmp(), 'agy-usage.json');
  let spawns = 0;
  let polls = 0;
  const run = () => {
    spawns += 1;
    return { json: agyJson() };
  };
  const agyHome = tmp();
  for (let t = NOW; t <= NOW + 60 * 60000; t += pollMs + 50) {
    polls += 1;
    eu.readAgyUsage({ agyHome, cachePath, nowMs: t, run });
  }
  return { spawns, polls };
}

test('agy: el sondeo de la pestaña Uso va por debajo de la caché y agy corre como mucho una vez por plazo', () => {
  const tsx = readFileSync(join(ROOT, 'control-center', 'src', 'sesiones', 'components', 'inspector', 'UsoMotores.tsx'), 'utf8');
  const m = /const REFRESH_MS = (\d+) \* 60000;/.exec(tsx);
  assert.ok(m, 'UsoMotores.tsx declara REFRESH_MS');
  const pollMs = Number(m[1]) * 60000;
  assert.ok(pollMs < eu.CACHE_TTL_MS, `sondeo ${pollMs} ms < caché ${eu.CACHE_TTL_MS} ms`);
  const { spawns, polls } = agySpawnsWithPoll(pollMs);
  assert.ok(spawns < polls, 'algún sondeo reutiliza la caché');
  assert.ok(spawns <= Math.ceil((60 * 60000) / eu.CACHE_TTL_MS) + 1, `agy lanzado ${spawns} veces en una hora`);
  // Caso negativo: con el sondeo igual a la caché, cada sondeo relanza agy.
  const same = agySpawnsWithPoll(eu.CACHE_TTL_MS);
  assert.equal(same.spawns, same.polls);
});


test('parseJsonOutput: tolera una línea de aviso antes del JSON y rechaza basura', () => {
  assert.deepEqual(eu.parseJsonOutput('aviso\n{"a":1}\n'), { a: 1 });
  assert.equal(eu.parseJsonOutput('nada'), null);
  assert.equal(eu.parseAgyUsage({ command: { data: { groups: [{ buckets: [{ window: 'weekly' }] }] } } }, NOW), null);
});

test('compactToken: sin ventanas o sin ningún dato vigente no pinta nada', () => {
  assert.equal(eu.compactToken({ status: 'none', windows: [] }, 'CX'), null);
  const both = { status: 'ok', windows: [{ kind: 'five_hour', group: null, usedPct: null }, { kind: 'seven_day', group: null, usedPct: null }] };
  assert.equal(eu.compactToken(both, 'CX'), null);
});

test('CLI --json y statusline con directorios de prueba', () => {
  const home = codexHome([{ name: 'rollout-a.jsonl', mtimeMs: Date.now(), lines: [codexEvent({ five: 7, week: 3, fiveReset: Date.now() + H, weekReset: Date.now() + 50 * H })] }]);
  const env = {
    ...process.env,
    ULTRON_CODEX_HOME: home,
    ULTRON_AGY_HOME: join(tmp(), 'no'),
    ULTRON_AGY_CACHE: join(tmp(), 'c.json'),
    ULTRON_CODEX_CACHE: join(tmp(), 'codex.json'),
    ULTRON_AGY_BIN: join(tmp(), 'no-hay-agy.exe'),
  };
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'engine-usage.mjs'), '--json'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.engines.map((e) => [e.id, e.status]), [['codex', 'ok'], ['agy', 'error']]);
  const sl = spawnSync(process.execPath, [join(ROOT, 'cockpit', 'statusline.js')], { env, input: '{}', encoding: 'utf8' });
  const plain = sl.stdout.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(plain, /CX 7\/3%/);
  assert.doesNotMatch(plain, /AG /, 'sin caché de agy no hay ficha AG');
});
