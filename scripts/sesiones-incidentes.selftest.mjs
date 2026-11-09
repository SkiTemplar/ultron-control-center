// sesiones-incidentes.selftest.mjs — checks herméticos del resumen del registro
// de incidentes de Sessions (scripts/lib/sesiones-incidentes.mjs y el CLI sobre
// un fichero temporal).
//
// Uso: node scripts/sesiones-incidentes.selftest.mjs   (exit 0 = verde)

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agrupar, filtrarDesde, normalizar, parsear } from './lib/sesiones-incidentes.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'sesiones-incidentes.mjs');

const inc = (ts, texto, origen = 'note') => ({ ts, origen, nivel: 'error', texto, sesion: 's1', app: '15.8.0', pantalla: ['> hola'] });

test('normalizar quita cifras, rutas, uuids e ids de herramienta', () => {
  assert.equal(normalizar('Bash lleva 2 min en C:\\Users\\x\\repo'), 'Bash lleva N min en <ruta>');
  assert.equal(normalizar('toolu_01AoDq falló en 3,5 s'), '<tool> falló en N s');
  assert.equal(normalizar('sesión 43defda7-ca1c-4a16-b3d4-188fb133e2b5'), 'sesión <uuid>');
});

test('agrupar junta repeticiones con cifras distintas y ordena por frecuencia', () => {
  const grupos = agrupar([
    inc('2026-10-16T08:00:00Z', 'Bash lleva 2 min'),
    inc('2026-10-16T08:05:00Z', 'La cola se ha parado'),
    inc('2026-10-16T08:09:00Z', 'Bash lleva 7 min'),
  ]);
  assert.equal(grupos.length, 2);
  assert.deepEqual([grupos[0].patron, grupos[0].veces, grupos[0].ultima, grupos[0].ejemplo], ['Bash lleva N min', 2, '2026-10-16T08:09:00Z', 2]);
});

test('el mismo texto con otro origen es otro grupo', () => {
  assert.equal(agrupar([inc('a', 'x', 'note'), inc('b', 'x', 'stall')]).length, 2);
});

test('parsear cuenta las líneas corruptas sin perder las buenas', () => {
  const { incidentes, corruptas } = parsear(`${JSON.stringify(inc('a', 'x'))}\n{roto\n\n`);
  assert.equal(incidentes.length, 1);
  assert.equal(corruptas, 1);
});

test('filtrarDesde incluye la fecha dada', () => {
  const lista = [inc('2026-10-15T23:00:00Z', 'a'), inc('2026-10-16T00:00:00Z', 'b')];
  assert.deepEqual(filtrarDesde(lista, '2026-10-16').map((i) => i.texto), ['b']);
  assert.equal(filtrarDesde(lista, null).length, 2);
});

test('CLI: resumen, --ver y error con un índice que no existe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'incidentes-selftest-'));
  const fichero = join(dir, 'sesiones-incidentes.jsonl');
  writeFileSync(fichero, [inc('2026-10-16T08:00:00Z', 'Bash lleva 2 min'), inc('2026-10-16T08:01:00Z', 'Bash lleva 3 min')].map((i) => JSON.stringify(i)).join('\n'));
  const resumen = spawnSync(process.execPath, [CLI, '--fichero', fichero], { encoding: 'utf8' });
  assert.equal(resumen.status, 0, resumen.stderr);
  assert.match(resumen.stdout, /2 × \[note\] Bash lleva N min/);
  const ver = spawnSync(process.execPath, [CLI, '--fichero', fichero, '--ver', '1'], { encoding: 'utf8' });
  assert.equal(ver.status, 0, ver.stderr);
  assert.match(ver.stdout, /Bash lleva 3 min/);
  assert.match(ver.stdout, /│ > hola/);
  const fuera = spawnSync(process.execPath, [CLI, '--fichero', fichero, '--ver', '9'], { encoding: 'utf8' });
  assert.equal(fuera.status, 1);
});

test('CLI: sin registro no falla', () => {
  const r = spawnSync(process.execPath, [CLI, '--fichero', join(tmpdir(), 'no-existe-incidentes.jsonl')], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Sin incidentes/);
});
