#!/usr/bin/env node
// hooks/scripts/tests/test-freshness-gate.js
// Tests de readL0Scratch() (lib/l0-scratch.js, reexportado por el resume).
//
// Desde el 2026-10-23 (hooks-4) el scratch es por sesion y solo se inyecta en
// el SessionStart source=compact de la MISMA sesion. Hermetico: trabaja en un
// directorio temporal (ULTRON_L0_DIR), no en ~/.ultron/.tmp.
//
// Uso: node hooks/scripts/tests/test-freshness-gate.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'l0-scratch-test-'));
process.env.ULTRON_L0_DIR = DIR;

const { readL0Scratch, L0_MAX_AGE_MS, L0_MAX_CHARS } = require('../memory-session-resume');
const { l0PathFor, writeL0Scratch, pruneOld } = require('../lib/l0-scratch');

const SID = 'a44b8936-34d8-470f-a125-ec5e4745e1da';
const OTRA = '11111111-2222-3333-4444-555555555555';
const tras = (extra = {}) => ({ sessionId: SID, source: 'compact', ...extra });

function escribe(contenido, { sid = SID, edadMs = 0 } = {}) {
  const p = l0PathFor(sid);
  fs.writeFileSync(p, contenido, 'utf8');
  const t = new Date(Date.now() - edadMs);
  fs.utimesSync(p, t, t);
  return p;
}

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    failed++;
  }
}

try {
  run('fresco, misma sesion y source=compact: se inyecta envuelto', () => {
    escribe('Scratch de trabajo: plan activo cat17.');
    const r = readL0Scratch(null, tras());
    assert.ok(r.includes('<l0-scratch') && r.includes('plan activo cat17') && r.includes('</l0-scratch>'), r);
  });

  run('NEGATIVO: SessionStart que no es compact no lo inyecta', () => {
    escribe('Scratch de trabajo.');
    for (const source of ['startup', 'resume', 'clear', undefined]) {
      assert.strictEqual(readL0Scratch(null, { sessionId: SID, source }), '', `source=${source}`);
    }
  });

  run('NEGATIVO: otra sesion del mismo proyecto no lo ve', () => {
    escribe('Scratch de la sesion A.');
    assert.strictEqual(readL0Scratch('ultron', tras({ sessionId: OTRA })), '');
  });

  run('sin session_id no hay scratch', () => {
    assert.strictEqual(readL0Scratch(null, { source: 'compact' }), '');
  });

  run('stale (>24h) devuelve cadena vacia', () => {
    escribe('Scratch viejo.', { edadMs: L0_MAX_AGE_MS + 3600e3 });
    assert.strictEqual(readL0Scratch(null, tras()), '');
  });

  run('inexistente devuelve cadena vacia (fail-safe)', () => {
    try { fs.unlinkSync(l0PathFor(SID)); } catch { /* no existia */ }
    assert.strictEqual(readL0Scratch(null, tras()), '');
  });

  run('fresco pero vacio devuelve cadena vacia', () => {
    escribe('   \n  ');
    assert.strictEqual(readL0Scratch(null, tras()), '');
  });

  run('contenido > L0_MAX_CHARS queda clipeado con [...]', () => {
    escribe('x'.repeat(L0_MAX_CHARS + 500));
    const r = readL0Scratch(null, tras());
    assert.ok(r.includes('[...]'));
    assert.ok(!r.includes('x'.repeat(L0_MAX_CHARS + 1)));
  });

  run('scratch de OTRO proyecto no se inyecta', () => {
    escribe('> trigger: auto · project: legacy-fc · turns_scanned: 3\n- dato de otro proyecto');
    assert.strictEqual(readL0Scratch('ultron', tras()), '');
  });

  run('scratch del MISMO proyecto si se inyecta', () => {
    escribe('> trigger: auto · project: ultron · turns_scanned: 3\n- plan activo bloque 3');
    assert.ok(readL0Scratch('ultron', tras()).includes('plan activo bloque 3'));
  });

  run('writeL0Scratch sin hechos no escribe y borra el anterior', () => {
    escribe('scratch previo');
    assert.strictEqual(writeL0Scratch(SID, 'cabecera sola', { hasFacts: false }), '');
    assert.strictEqual(fs.existsSync(l0PathFor(SID)), false);
  });

  run('writeL0Scratch con hechos escribe en la ruta de la sesion', () => {
    const p = writeL0Scratch(SID, '- [user] decidimos X', { hasFacts: true });
    assert.strictEqual(p, l0PathFor(SID));
    assert.ok(fs.readFileSync(p, 'utf8').includes('decidimos X'));
  });

  run('un session_id con separadores no escapa del directorio', () => {
    const p = l0PathFor('..\\..\\evil/../x');
    assert.strictEqual(path.dirname(p), DIR);
  });

  run('pruneOld borra los de mas de una semana y deja los recientes', () => {
    const viejo = escribe('viejo', { sid: OTRA, edadMs: 8 * 24 * 3600e3 });
    const nuevo = escribe('nuevo');
    pruneOld(DIR);
    assert.strictEqual(fs.existsSync(viejo), false);
    assert.strictEqual(fs.existsSync(nuevo), true);
  });
} finally {
  fs.rmSync(DIR, { recursive: true, force: true });
}

console.log('');
if (failed === 0) {
  console.log(`PASS  test-freshness-gate (${passed} pruebas, 0 fallos)`);
  process.exitCode = 0;
} else {
  console.error(`FAIL  test-freshness-gate (${passed} ok, ${failed} fallos)`);
  process.exitCode = 1;
}
