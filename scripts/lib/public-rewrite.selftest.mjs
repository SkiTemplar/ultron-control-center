#!/usr/bin/env node
// Selftest de public-rewrite: la reescritura reapunta el repo privado sin tocar
// los repos cuyo nombre lo tiene como prefijo.
// Ejecutar: node scripts/lib/public-rewrite.selftest.mjs
import assert from 'node:assert';
import { reapuntarRepo, FICHEROS_REESCRITOS } from './public-rewrite.mjs';

const casos = [
  [
    'https://raw.githubusercontent.com/SkiTemplar/ultron/main/bootstrap.ps1',
    'https://raw.githubusercontent.com/SkiTemplar/ultron-control-center/main/bootstrap.ps1',
    'one-liner de bootstrap',
  ],
  [
    '$Repo = "SkiTemplar/ultron",',
    '$Repo = "SkiTemplar/ultron-control-center",',
    'parametro del script de arranque',
  ],
  [
    'https://github.com/SkiTemplar/ultron/releases/latest/download/latest.json',
    'https://github.com/SkiTemplar/ultron-control-center/releases/latest/download/latest.json',
    'endpoint del updater de Tauri',
  ],
  [
    'git clone https://github.com/SkiTemplar/ultron.git ~/.ultron',
    'git clone https://github.com/SkiTemplar/ultron-control-center.git ~/.ultron',
    'clonado con sufijo .git',
  ],
];
for (const [entrada, esperado, que] of casos) {
  assert.strictEqual(reapuntarRepo(entrada).texto, esperado, que);
}

// NEGATIVOS: lo que NO se debe tocar.
const intactos = [
  ['https://github.com/SkiTemplar/ultron-control-center.git', 'el propio espejo ya apuntado'],
  ['https://github.com/SkiTemplar/ultron-skills', 'otro repo con el mismo prefijo'],
  ['El directorio ~/.ultron y el paquete ultron-memory', 'texto que no es una ruta de repo'],
];
for (const [entrada, que] of intactos) {
  const r = reapuntarRepo(entrada);
  assert.strictEqual(r.texto, entrada, que);
  assert.strictEqual(r.cambios, 0, `${que}: no debe contar cambios`);
}

// Cuenta de ocurrencias y entradas vacias.
assert.strictEqual(reapuntarRepo('SkiTemplar/ultron y SkiTemplar/ultron').cambios, 2,
  'cuenta todas las ocurrencias');
assert.strictEqual(reapuntarRepo('').cambios, 0, 'contenido vacio => 0 cambios');
assert.strictEqual(reapuntarRepo(undefined).texto, '', 'undefined => cadena vacia, sin lanzar');

assert.ok(FICHEROS_REESCRITOS.includes('control-center/src-tauri/tauri.conf.json'),
  'el updater entra en la lista de ficheros reescritos');
assert.ok(!FICHEROS_REESCRITOS.some((f) => f.startsWith('docs/audits/')),
  'los informes fechados NO se reescriben');

console.log('SELFTEST public-rewrite: VERDE (15 asserts)');
