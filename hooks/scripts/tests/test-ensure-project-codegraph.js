#!/usr/bin/env node
// Test de ensure-project: `codegraph init` solo se lanza en carpetas dadas de
// alta como proyecto. Regresion 2026-09-18: se lanzaba en CUALQUIER cwd y una
// sesion headless con cwd=%TEMP% dejo un indice de 364 MB sobre los temporales.
//
// Regresion 2026-10-23: bastaba con que existiera la carpeta `.codegraph` para
// darlo por indexado, asi que un init interrumpido no se reintentaba nunca y
// la carpeta personal (cuyo `~/.codegraph` es el directorio global de
// CodeGraph) parecia indexada con 0 ficheros. Se prueba contra un indice real
// de CodeGraph 1.6.0 (el fixture de los tests de Rust).
// Ejecutar: node hooks/scripts/tests/test-ensure-project-codegraph.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { accionCodegraph, debeIndexarCodegraph } = require('../ensure-project.js');
const { estadoIndice } = require('../lib/codegraph-index.js');

const FIXTURE = path.join(
  __dirname, '..', '..', '..', 'control-center', 'src-tauri', 'src', 'commands',
  'projects', 'git_ops', 'codegraph', 'fixtures', 'mini.db'
);
const OTRO_HOME = path.join(os.tmpdir(), 'no-es-este-home');

/** Copia el indice de fixture al proyecto; `estado` reescribe index_state. */
function conIndice(proyecto, estado) {
  const cg = path.join(proyecto, '.codegraph');
  fs.mkdirSync(cg, { recursive: true });
  const db = path.join(cg, 'codegraph.db');
  fs.copyFileSync(FIXTURE, db);
  if (estado) {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const conn = new DatabaseSync(db);
    conn.prepare("UPDATE project_metadata SET value = ? WHERE key = 'index_state'").run(estado);
    conn.close();
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-ep-'));
let asserts = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); asserts++; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, msg); asserts++; };
try {
  const proyecto = path.join(dir, 'proyecto');
  fs.mkdirSync(proyecto);

  eq(accionCodegraph(proyecto, 'mi-proyecto', '/otra/tmp', OTRO_HOME), 'init',
    'proyecto dado de alta y sin indice => init');
  eq(debeIndexarCodegraph(proyecto, undefined, '/otra/tmp', OTRO_HOME), false,
    'carpeta que NO es proyecto => no indexa');
  eq(debeIndexarCodegraph(dir, 'temporal', dir, OTRO_HOME), false,
    'la carpeta temporal del sistema nunca se indexa, ni dada de alta');
  eq(debeIndexarCodegraph(proyecto, 'mi-proyecto', dir, OTRO_HOME), false,
    'un proyecto DENTRO de la carpeta temporal tampoco');

  // Init interrumpido: la carpeta existe pero sin codegraph.db.
  fs.mkdirSync(path.join(proyecto, '.codegraph'));
  fs.writeFileSync(path.join(proyecto, '.codegraph', 'daemon.log'), 'x');
  eq(accionCodegraph(proyecto, 'mi-proyecto', '/otra/tmp', OTRO_HOME), 'init',
    '.codegraph sin codegraph.db => se reintenta el init');

  conIndice(proyecto);
  const completo = estadoIndice(proyecto, OTRO_HOME);
  eq(completo.estado, 'ok', JSON.stringify(completo));
  eq(completo.ficheros, 3, 'el fixture tiene 3 ficheros');
  eq(debeIndexarCodegraph(proyecto, 'mi-proyecto', '/otra/tmp', OTRO_HOME), false,
    'con indice completo => no reindexa');

  conIndice(proyecto, 'indexing');
  eq(accionCodegraph(proyecto, 'mi-proyecto', '/otra/tmp', OTRO_HOME), 'index',
    'indice a medias (index_state != complete) => codegraph index');

  // Carpeta personal: aunque tenga .codegraph/codegraph.db, nunca se indexa.
  eq(estadoIndice(proyecto, proyecto).estado, 'carpeta-personal', 'home detectado');
  eq(debeIndexarCodegraph(proyecto, 'home', '/otra/tmp', proyecto), false,
    'la carpeta personal nunca se indexa');

  // Indice completo sin ficheros (carpeta sin codigo): no se reintenta.
  const vacio = path.join(dir, 'vacio');
  conIndice(vacio);
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const conn = new DatabaseSync(path.join(vacio, '.codegraph', 'codegraph.db'));
  conn.exec('DELETE FROM files');
  conn.close();
  eq(estadoIndice(vacio, OTRO_HOME).estado, 'vacio', 'indice completo con 0 ficheros');
  eq(debeIndexarCodegraph(vacio, 'vacio', '/otra/tmp', OTRO_HOME), false,
    'un indice vacio pero completo no se reindexa en cada sesion');

  // Un fichero que no es SQLite se informa como ilegible y no se toca.
  const roto = path.join(dir, 'roto');
  fs.mkdirSync(path.join(roto, '.codegraph'), { recursive: true });
  fs.writeFileSync(path.join(roto, '.codegraph', 'codegraph.db'), 'no soy sqlite');
  const ilegible = estadoIndice(roto, OTRO_HOME);
  eq(ilegible.estado, 'ilegible', JSON.stringify(ilegible));
  ok(ilegible.motivo, 'el motivo se conserva');
  eq(debeIndexarCodegraph(roto, 'roto', '/otra/tmp', OTRO_HOME), false,
    'ilegible => no se lanza nada a ciegas');

  console.log(`test-ensure-project-codegraph: OK (${asserts} asserts)`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
