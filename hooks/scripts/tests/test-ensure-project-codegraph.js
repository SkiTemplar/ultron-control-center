#!/usr/bin/env node
// Test de ensure-project: `codegraph init` solo se lanza en carpetas dadas de
// alta como proyecto. Regresion 2026-09-18: se lanzaba en CUALQUIER cwd y una
// sesion headless con cwd=%TEMP% dejo un indice de 364 MB sobre los temporales.
// Ejecutar: node hooks/scripts/tests/test-ensure-project-codegraph.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { debeIndexarCodegraph } = require('../ensure-project.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-ep-'));
try {
  const proyecto = path.join(dir, 'proyecto');
  fs.mkdirSync(proyecto);

  assert.strictEqual(debeIndexarCodegraph(proyecto, 'mi-proyecto', '/otra/tmp'), true,
    'proyecto dado de alta y sin indice => indexa');
  assert.strictEqual(debeIndexarCodegraph(proyecto, undefined, '/otra/tmp'), false,
    'carpeta que NO es proyecto => no indexa');
  assert.strictEqual(debeIndexarCodegraph(dir, 'temporal', dir), false,
    'la carpeta temporal del sistema nunca se indexa, ni dada de alta');
  assert.strictEqual(debeIndexarCodegraph(proyecto, 'mi-proyecto', dir), false,
    'un proyecto DENTRO de la carpeta temporal tampoco');

  fs.mkdirSync(path.join(proyecto, '.codegraph'));
  assert.strictEqual(debeIndexarCodegraph(proyecto, 'mi-proyecto', '/otra/tmp'), false,
    'con indice ya presente => no reindexa');

  console.log('test-ensure-project-codegraph: OK (5 asserts)');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
