#!/usr/bin/env node
// Selftest de codegraph-index-projects: el plan de indexado clasifica cada
// proyecto con el mismo criterio que ensure-project y no propone indexar la
// carpeta personal, el temporal, carpetas inexistentes ni indices completos.
//
// Hermetico: carpetas temporales y el indice real de fixture de los tests de
// Rust; no lee el projects.json real ni lanza codegraph.
// Ejecutar: node scripts/codegraph-index-projects.selftest.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planIndexado } from './codegraph-index-projects.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(
  here, '..', 'control-center', 'src-tauri', 'src', 'commands', 'projects',
  'git_ops', 'codegraph', 'fixtures', 'mini.db'
);

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-cgip-'));
try {
  // Las carpetas de proyecto viven bajo `raiz`; el "temporal" del plan es otra.
  const tmpDir = path.join(raiz, 'tmp');
  const home = path.join(raiz, 'home');
  const mk = (nombre) => {
    const d = path.join(raiz, nombre);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  fs.mkdirSync(tmpDir);
  fs.mkdirSync(path.join(home, '.codegraph'), { recursive: true });
  fs.copyFileSync(FIXTURE, path.join(home, '.codegraph', 'codegraph.db'));
  const nuevo = mk('nuevo');
  const indexado = mk('indexado');
  fs.mkdirSync(path.join(indexado, '.codegraph'));
  fs.copyFileSync(FIXTURE, path.join(indexado, '.codegraph', 'codegraph.db'));
  const temporal = path.join(tmpDir, 'pruebas');
  fs.mkdirSync(temporal);

  const plan = planIndexado(
    [
      { id: 'nuevo', path: nuevo },
      { id: 'indexado', path: indexado },
      { id: '__home', path: home },
      { id: 'temporal', path: temporal },
      { id: 'borrado', path: path.join(raiz, 'no-existe') },
      { id: 'sin-ruta', path: null },
    ],
    { home, tmpDir },
  );
  const por = Object.fromEntries(plan.map((e) => [e.id, e]));

  assert.equal(por.nuevo.accion, 'init', 'proyecto sin indice => init');
  assert.equal(por.indexado.estado, 'ok');
  assert.equal(por.indexado.ficheros, 3);
  assert.equal(por.indexado.accion, null, 'indice completo => nada');
  assert.equal(por.__home.estado, 'carpeta-personal');
  assert.equal(por.__home.accion, null, 'la carpeta personal nunca se indexa');
  assert.equal(por.temporal.accion, null, 'el temporal nunca se indexa');
  assert.equal(por.borrado.estado, 'carpeta-inexistente');
  assert.equal(por['sin-ruta'].estado, 'sin-carpeta');
  assert.deepEqual(plan.filter((e) => e.accion).map((e) => e.id), ['nuevo']);

  console.log('codegraph-index-projects.selftest: OK (10 asserts)');
} finally {
  fs.rmSync(raiz, { recursive: true, force: true });
}
