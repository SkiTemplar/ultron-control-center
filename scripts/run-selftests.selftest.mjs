#!/usr/bin/env node
// run-selftests.selftest.mjs: un selftest lento puede declarar su tope en el manifiesto.
//
// Por que: delegate.selftest tarda 137 s con la maquina cargada y el tope comun es de
// 120 s, asi que `--ci` daba un rojo por tiempo y no por regresion (check 12.7).
// Hermetico: comprueba la funcion pura y lanza el ejecutor real con un selftest temporal.
// Uso: node scripts/run-selftests.selftest.mjs   (exit 0 = verde)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { failureTail, runPool, selftestTimeoutSec, splitSerial } from './run-selftests.mjs';

assert.equal(selftestTimeoutSec(undefined, 120), 120, 'sin entrada: el tope comun');
assert.equal(selftestTimeoutSec({ ci: true }, 120), 120, 'entrada sin tope: el tope comun');
assert.equal(selftestTimeoutSec({ ci: true, timeoutSec: 300 }, 120), 300, 'el manifiesto sube el tope');
assert.equal(selftestTimeoutSec({ ci: true, timeoutSec: 60 }, 120), 120, 'un tope menor no recorta el comun');
assert.equal(selftestTimeoutSec({ ci: true, timeoutSec: 300 }, 600), 600, '--timeout mayor manda');
assert.equal(selftestTimeoutSec({ ci: true, timeoutSec: 'mucho' }, 120), 120, 'un valor no numerico se ignora');

// El selftest lento real lleva su tope: sin el, el check 12.7 vuelve a depender de la carga.
const manifest = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'selftests.manifest.json'), 'utf8'));
const delegate = manifest.tests['scripts/delegate.selftest.mjs'];
assert.ok(delegate && delegate.timeoutSec >= 300, 'delegate.selftest declara un tope de al menos 300 s');

// runPool (--jobs): conserva el orden y nunca pasa del limite de concurrencia.
const delays = [30, 5, 20, 1, 10, 2, 15];
let activos = 0;
let maximo = 0;
const vistos = [];
const res = await runPool(delays, 3, async (ms, i) => {
  activos++;
  maximo = Math.max(maximo, activos);
  await new Promise((r) => setTimeout(r, ms));
  activos--;
  return i;
}, (r) => vistos.push(r));
assert.deepEqual(res, [0, 1, 2, 3, 4, 5, 6], 'runPool: el resultado conserva el orden de entrada');
assert.ok(maximo <= 3 && maximo > 1, `runPool: concurrencia entre 2 y 3 (${maximo})`);
assert.equal(vistos.length, delays.length, 'runPool: onDone se llama una vez por tarea');
const uno = await runPool([3, 1, 2], 1, async (x) => x * 2);
assert.deepEqual(uno, [6, 2, 4], 'runPool con limite 1: secuencial');
assert.deepEqual(await runPool([], 4, async () => 1), [], 'runPool sin tareas: vacio');

// failureTail: el subtest caido se ve aunque quede lejos de la cola.
const tapLike = ['TAP version 13', 'ok 1 - a', 'not ok 2 - restaura el zip', '  ---', 'ok 3 - c', ...Array.from({ length: 8 }, (_, i) => `# resumen ${i}`)].join('\n');
const shown = failureTail(tapLike).split('\n');
assert.ok(shown.includes('not ok 2 - restaura el zip'), 'failureTail conserva el not ok aunque no este en la cola');
assert.ok(!shown.includes('ok 1 - a'), 'failureTail no copia los ok');
assert.equal(shown.at(-1), '# resumen 7', 'failureTail termina con la cola');
assert.equal(failureTail('uno\ndos'), 'uno\ndos', 'salida corta: entera');

// serial: los marcados van aparte y en su orden; el resto, al pool.
const parts = splitSerial(['a', 'b', 'c', 'd'], { a: { ci: true }, b: { ci: true, serial: true }, d: { serial: true } });
assert.deepEqual(parts, { serial: ['b', 'd'], pool: ['a', 'c'] }, 'splitSerial separa los serial: true');
assert.deepEqual(splitSerial(['a'], {}), { serial: [], pool: ['a'] }, 'sin entrada en el manifiesto: al pool');
// Los selftests con topes de tiempo ajustados siguen marcados (si no, el pool los tumba).
for (const f of ['hooks/scripts/guardrails-pre.adversarial.selftest.mjs', 'hooks/scripts/deny-secrets.selftest.mjs']) {
  assert.equal(manifest.tests[f]?.serial, true, `${f} va en serie`);
}

console.log('SELFTEST run-selftests: VERDE');
