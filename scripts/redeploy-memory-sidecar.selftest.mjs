#!/usr/bin/env node
// redeploy-memory-sidecar.selftest.mjs — verificación del despliegue del sidecar.
//
// Cubre (2026-10-23):
//   - checkVersionOutput: el SHA tiene que ser el HEAD; `dirty` se detecta; una
//     salida que no es JSON o sin git_sha no se da por buena (casos negativos).
//   - build:local despliega con este script (`--no-build`), no con el
//     deploy-sidecar.mjs que solo comparaba tamaños y salía con 0 al fallar.
//
// Hermético: no compila, no copia ni toca procesos; solo importa la función pura
// y lee build-local.mjs.
// Ejecutar: node scripts/redeploy-memory-sidecar.selftest.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkVersionOutput } from './redeploy-memory-sidecar.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let n = 0;
const check = (fn) => { fn(); n += 1; };
const version = (o) => JSON.stringify({ bin: 'ultron-memory', pkg_version: '15.8.0', ...o });

// 1. Binario del HEAD con el árbol limpio: ok, sin aviso.
check(() => assert.deepEqual(checkVersionOutput(version({ git_sha: 'abc1234', dirty: false }), 'abc1234'),
  { ok: true, dirty: false, reason: null }));

// 2. Binario del HEAD compilado con cambios: ok (se despliega) pero dirty.
check(() => assert.equal(checkVersionOutput(version({ git_sha: 'abc1234', dirty: true }), 'abc1234').dirty, true));

// 3. NEGATIVO: otro SHA es un despliegue stale.
check(() => {
  const v = checkVersionOutput(version({ git_sha: '0000000', dirty: false }), 'abc1234');
  assert.equal(v.ok, false);
  assert.match(v.reason, /no el HEAD abc1234/);
});

// 4. NEGATIVO: un SHA que solo CONTIENE el HEAD ya no cuela (antes era includes()).
check(() => assert.equal(checkVersionOutput(version({ git_sha: 'abc12345' }), 'abc1234').ok, false));

// 5. NEGATIVO: salida que no es JSON, o JSON sin git_sha.
check(() => assert.equal(checkVersionOutput('error: algo', 'abc1234').ok, false));
check(() => assert.equal(checkVersionOutput(version({}), 'abc1234').ok, false));

// 6. Binario anterior al campo dirty: ok con dirty desconocido (null).
check(() => assert.deepEqual(checkVersionOutput(version({ git_sha: 'abc1234' }), 'abc1234'),
  { ok: true, dirty: null, reason: null }));

// 7. build:local despliega con el redeploy y sin recompilar.
const buildLocal = fs.readFileSync(path.join(ROOT, 'control-center', 'scripts', 'build-local.mjs'), 'utf8');
check(() => assert.match(buildLocal, /run\("node", \["\.\.\/scripts\/redeploy-memory-sidecar\.mjs", "--no-build"\]\)/,
  'build-local.mjs termina con el redeploy --no-build'));
check(() => assert.ok(!buildLocal.includes('deploy-sidecar.mjs"'), 'build-local.mjs ya no llama a deploy-sidecar.mjs'));
check(() => assert.ok(!fs.existsSync(path.join(ROOT, 'control-center', 'scripts', 'deploy-sidecar.mjs')),
  'deploy-sidecar.mjs retirado'));

console.log(`redeploy-memory-sidecar.selftest: OK (${n} asserts)`);
