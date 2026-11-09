#!/usr/bin/env node
// run-mod-tests.selftest.mjs — descubrimiento y resumen del runner de tests de mods.
//
// Hermético: no ejecuta `claude`; usa un árbol de mods temporal y salidas fijas.
// Ejecutar: node scripts/run-mod-tests.selftest.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildSuites, discoverMods, summarize } from './run-mod-tests.mjs';

let n = 0;
const check = (fn) => { fn(); n += 1; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mods-selftest-'));
try {
  const mk = (name, files) => {
    fs.mkdirSync(path.join(dir, name, 'tests'), { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(dir, name, 'tests', f), '');
  };
  mk('b-con-tests', ['x.test.ts']);
  mk('a-con-tsx', ['y.test.tsx']);
  mk('sin-tests', ['fixtures.ts']); // NEGATIVO: tests/ sin *.test.ts no cuenta
  fs.mkdirSync(path.join(dir, 'sin-carpeta'));

  check(() => assert.deepEqual(discoverMods(dir), ['a-con-tsx', 'b-con-tests']));
  check(() => assert.deepEqual(discoverMods(path.join(dir, 'no-existe')), []));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// El MCP de escritorio va siempre, aunque no haya mods.
const suites = buildSuites(['m1']);
check(() => assert.deepEqual(suites.map((s) => s.name), ['mods/m1', 'tools/ultron-desktop-mcp/server.test.mjs']));
check(() => assert.deepEqual(suites[0].argv, ['plugin', 'test']));

// El repo real tiene mods con tests (si da 0, el gate no mediría nada).
check(() => assert.ok(discoverMods().length >= 18, `mods descubiertos: ${discoverMods().length}`));

check(() => assert.equal(summarize(' 35 pass\n 1 fail\nRan 36 tests'), '35 pass, 1 fail'));
check(() => assert.equal(summarize('ℹ tests 6\nℹ pass 6\nℹ fail 0'), '6 pass, 0 fail'));
check(() => assert.equal(summarize('# pass 2\n# fail 1'), '2 pass, 1 fail'));
check(() => assert.equal(summarize('nada'), 'sin resumen'));

console.log(`run-mod-tests.selftest: OK (${n} asserts)`);
