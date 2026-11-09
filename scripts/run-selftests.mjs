#!/usr/bin/env node
// run-selftests.mjs — ejecuta los selftests de hooks/ y scripts/ con un manifiesto
// unico (scripts/selftests.manifest.json).
//
// Por que: el CI listaba a mano una parte de los selftests y los nuevos entraban
// sin que nadie los ejecutara (mismo fallo que el 2026-08-10 con los de memoria).
// Ahora el manifiesto obliga a CLASIFICAR cada fichero: `ci: true` (hermetico, corre
// en el runner limpio) o `ci: false` con el motivo. `--check` falla si hay un
// selftest sin clasificar o una entrada que ya no existe, igual que
// hooks/regen-manifest.js con los hooks.
//
// Descubre: hooks/**/*.selftest.mjs, scripts/**/*.selftest.mjs,
// cockpit/skill-lazy/*.selftest.mjs (routing de skills, desde 2026-10-03) y
// hooks/scripts/tests/test-*.js.
//
// Uso:
//   node scripts/run-selftests.mjs --check                 solo comprueba el manifiesto
//   node scripts/run-selftests.mjs --list                  lista lo descubierto y su clase
//   node scripts/run-selftests.mjs --ci                    ejecuta los `ci: true` (lo que corre el CI)
//   node scripts/run-selftests.mjs                         ejecuta todos
//   node scripts/run-selftests.mjs --fake-home             HOME/USERPROFILE limpios (simula el runner del CI)
//   node scripts/run-selftests.mjs --filter <texto>        solo los que contengan el texto
//   node scripts/run-selftests.mjs --exclude <texto>       todos menos los que lo contengan (el CI
//                                                          parte la bateria en dos jobs)
//   node scripts/run-selftests.mjs --json <fichero>        escribe el resultado (para clasificar)
//   --timeout <s>   tope por selftest (120 por defecto); una entrada del manifiesto
//                   puede subirlo con `timeoutSec` (selftests lentos, p. ej. delegate)
//   --jobs <n>      selftests a la vez (1 por defecto). Con --fake-home cada uno
//                   recibe su propio HOME limpio, para que no se pisen.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const MANIFEST = path.join(ROOT, 'scripts', 'selftests.manifest.json');
const SCAN_DIRS = ['hooks', 'scripts', 'cockpit/skill-lazy'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'fixtures', '_legacy_archive']);

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const value = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const timeoutSec = Number(value('--timeout') || 120);
const jobs = Math.max(1, Math.floor(Number(value('--jobs') || 1)) || 1);

const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(path.join(dir, e.name));
    } else {
      yield path.join(dir, e.name);
    }
  }
}

export function isSelftest(relPath) {
  return /\.selftest\.mjs$/.test(relPath) || /^hooks\/scripts\/tests\/test-[^/]+\.js$/.test(relPath);
}

export function discover() {
  const found = [];
  for (const d of SCAN_DIRS) for (const f of walk(path.join(ROOT, d))) if (isSelftest(rel(f))) found.push(rel(f));
  return found.sort();
}

export function loadManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).tests || {};
  } catch {
    return {};
  }
}

/** Diferencias entre lo descubierto y el manifiesto. */
export function drift(found, tests) {
  return {
    unregistered: found.filter((f) => !(f in tests)),
    stale: Object.keys(tests).filter((f) => !found.includes(f)),
    missingReason: Object.entries(tests)
      .filter(([, v]) => v.ci === false && !(typeof v.reason === 'string' && v.reason.trim()))
      .map(([f]) => f),
  };
}

function report(found, tests) {
  const d = drift(found, tests);
  let bad = false;
  if (d.unregistered.length) {
    bad = true;
    console.error(`Selftests SIN CLASIFICAR en scripts/selftests.manifest.json (${d.unregistered.length}):`);
    for (const f of d.unregistered) console.error(`  + ${f}`);
  }
  if (d.stale.length) {
    bad = true;
    console.error(`Entradas del manifiesto sin fichero (${d.stale.length}):`);
    for (const f of d.stale) console.error(`  - ${f}`);
  }
  if (d.missingReason.length) {
    bad = true;
    console.error(`Entradas con ci:false sin motivo (${d.missingReason.length}):`);
    for (const f of d.missingReason) console.error(`  ? ${f}`);
  }
  return !bad;
}

/**
 * Entorno del runner del CI: HOME limpio y sin las variables ULTRON_* de la
 * maquina del usuario (ULTRON_DENSE, ULTRON_ORCHESTRATE...), que el runner no
 * tiene. Sin quitarlas, `--fake-home` daba verde a selftests que en CI fallan.
 */
export function fakeHomeEnv(baseEnv, home) {
  const env = Object.fromEntries(Object.entries(baseEnv).filter(([k]) => !k.startsWith('ULTRON_')));
  for (const k of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) env[k] = home;
  return env;
}

/** Tope en segundos: el mayor entre el comun y el `timeoutSec` de la entrada del manifiesto. */
export function selftestTimeoutSec(entry, defaultSec) {
  const declared = Number(entry?.timeoutSec);
  return Number.isFinite(declared) ? Math.max(declared, defaultSec) : defaultSec;
}

const FAILURE_LINE = /^\s*(not ok\b|FAIL|FALLO|AssertionError|Error\b|\S*Error:)/;

/**
 * Lo que se enseña de un selftest fallido: las lineas que nombran el fallo
 * (`not ok`, FAIL, errores; hasta 8) y las 6 ultimas. Con solo la cola, el
 * resumen de node:test tapaba que subtest habia caido (CI 2026-11-02).
 */
export function failureTail(text) {
  const lines = text.trim().split('\n');
  const last = lines.slice(-6);
  const named = lines.slice(0, -6).filter((l) => FAILURE_LINE.test(l)).slice(0, 8);
  return [...named, ...last].join('\n');
}

/** Ejecuta un selftest; al vencer el tope lo mata y lo da por fallido. */
function runOne(relPath, env, limitSec) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, relPath)], { cwd: ROOT, env, windowsHide: true });
    let out = '';
    const keep = (c) => {
      out = (out + c).slice(-64 * 1024);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, limitSec * 1000);
    const finish = (status, error) => {
      clearTimeout(timer);
      const text = error ? `${out}\n${error.message}` : out;
      resolve({
        file: relPath,
        ok: status === 0 && !error && !timedOut,
        status,
        timedOut,
        ms: Date.now() - t0,
        tail: failureTail(text),
      });
    };
    child.on('error', (e) => finish(null, e));
    child.on('close', (code) => finish(code, null));
  });
}

/** Separa los selftests marcados `serial: true` del resto (orden conservado). */
export function splitSerial(files, tests) {
  const serial = files.filter((f) => tests[f] && tests[f].serial === true);
  return { serial, pool: files.filter((f) => !serial.includes(f)) };
}

/**
 * Pool de `limit` tareas a la vez; conserva el orden de `items` en el
 * resultado. `onDone` se llama al acabar cada una (para imprimir en vivo).
 */
export async function runPool(items, limit, task, onDone = () => {}) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await task(items[i], i);
      onDone(results[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

async function main() {
  const found = discover();
  const tests = loadManifest();

  if (flag('--check')) {
    if (report(found, tests)) {
      const ci = Object.values(tests).filter((v) => v.ci).length;
      console.log(`OK: ${found.length} selftests clasificados (${ci} en CI, ${found.length - ci} solo locales).`);
      return 0;
    }
    return 1;
  }

  if (flag('--list')) {
    for (const f of found) {
      const v = tests[f];
      console.log(`${v ? (v.ci ? 'ci   ' : 'local') : '???  '} ${f}${v && !v.ci && v.reason ? `  — ${v.reason}` : ''}`);
    }
    return 0;
  }

  let selected = found;
  if (flag('--ci')) {
    if (!report(found, tests)) return 1;
    selected = found.filter((f) => tests[f] && tests[f].ci);
  }
  const filter = value('--filter');
  if (filter) selected = selected.filter((f) => f.includes(filter));
  const exclude = value('--exclude');
  if (exclude) selected = selected.filter((f) => !f.includes(exclude));

  // ULTRON_SELFTEST=1: lib/hook-obs.js escribe la telemetria de los hooks que
  // lanzan las pruebas en <tmp>/ultron-selftest-logs y no en ~/.ultron/logs
  // (hooks-7: los selftests contaminaban hook-errors y hook-timing).
  let env = { ...process.env, ULTRON_SELFTEST: '1' };
  let fakeHome = null;
  if (flag('--fake-home')) {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'selftests-home-'));
    env = { ...fakeHomeEnv(process.env, fakeHome), ULTRON_SELFTEST: '1' };
  }

  // Con --fake-home y --jobs > 1, un HOME limpio por selftest: en paralelo,
  // compartirlo haria que uno viera lo que escribe otro.
  const envFor = (i) => {
    if (!fakeHome || jobs === 1) return env;
    const home = path.join(fakeHome, String(i));
    fs.mkdirSync(home, { recursive: true });
    return { ...fakeHomeEnv(process.env, home), ULTRON_SELFTEST: '1' };
  };
  const print = (r) => {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.file}  (${(r.ms / 1000).toFixed(1)} s)${r.timedOut ? '  TIMEOUT' : ''}`);
    if (!r.ok) console.log(r.tail.split('\n').map((l) => `      ${l}`).join('\n'));
  };
  // `serial: true` en el manifiesto: selftests con topes de tiempo ajustados.
  // Van primero y de uno en uno, sin la carga del pool (CI 2026-11-02:
  // guardrails-pre.adversarial dio 2960 ms frente a 2500 con --jobs 4).
  const { serial, pool } = splitSerial(selected, tests);
  const first = await runPool(serial, 1, (f) => runOne(f, env, selftestTimeoutSec(tests[f], timeoutSec)), print);
  const rest = await runPool(pool, jobs, (f, i) => runOne(f, envFor(i), selftestTimeoutSec(tests[f], timeoutSec)), print);
  const results = [...first, ...rest];
  if (fakeHome) fs.rmSync(fakeHome, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} selftests en verde${failed.length ? `; fallan ${failed.length}` : ''}.`);
  const out = value('--json');
  if (out) fs.writeFileSync(out, JSON.stringify(results, null, 2));
  return failed.length ? 1 : 0;
}

if (import.meta.url === `file:///${process.argv[1].split(path.sep).join('/')}` || process.argv[1] === import.meta.filename) {
  main().then((code) => process.exit(code));
}
