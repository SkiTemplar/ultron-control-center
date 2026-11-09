// hooks/scripts/lib/codegraph-index.js — estado del indice CodeGraph de una
// carpeta de proyecto.
//
// PROBLEMA (auditoria 2026-10-23): ensure-project solo miraba si existia la
// carpeta `.codegraph`. Un `codegraph init` interrumpido (la carpeta se crea
// antes que el indice) o una carpeta con solo `daemon.log` contaban como
// "indexado" y no se reintentaban nunca. Ademas la carpeta personal tiene
// `~/.codegraph`, que es el directorio GLOBAL de CodeGraph (daemons,
// telemetria), no el indice de ningun proyecto.
//
// Estados:
//   carpeta-personal  la carpeta es el home: nunca se indexa
//   sin-indice        no hay `.codegraph/codegraph.db` -> `codegraph init`
//   incompleto        hay db pero `index_state` no es `complete` -> `codegraph index`
//   vacio             indice completo con 0 ficheros (carpeta sin codigo): no se reintenta
//   ok                indice completo con ficheros
//   ilegible          la db existe pero no se puede leer: se informa, no se toca
//
// Lectura en solo lectura con node:sqlite (sin dependencias). Los indices de
// versiones anteriores de CodeGraph no tienen `project_metadata`: se juzgan
// solo por el numero de ficheros.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Accion que corrige cada estado (null = nada que hacer). */
const ACCION = Object.freeze({
  'sin-indice': 'init',
  incompleto: 'index',
});

function norm(p) {
  return path.resolve(String(p || '')).replace(/[\\/]+$/, '').toLowerCase();
}

/** node:sqlite emite un ExperimentalWarning por stderr; se silencia solo ese. */
function cargarSqlite() {
  const original = process.emitWarning;
  process.emitWarning = (w, ...rest) => {
    if (String(w).includes('SQLite')) return;
    original.call(process, w, ...rest);
  };
  try {
    return process.getBuiltinModule ? process.getBuiltinModule('node:sqlite') : require('node:sqlite');
  } catch (_) {
    return null;
  } finally {
    process.emitWarning = original;
  }
}

function leerIndice(db) {
  const sqlite = cargarSqlite();
  if (!sqlite) return { estado: 'ilegible', ficheros: null, motivo: 'node:sqlite no disponible' };
  let conn;
  try {
    conn = new sqlite.DatabaseSync(db, { readOnly: true });
    const ficheros = conn.prepare('SELECT COUNT(*) AS n FROM files').get().n;
    const tieneMeta = conn
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'project_metadata'")
      .get().n > 0;
    const fila = tieneMeta
      ? conn.prepare("SELECT value FROM project_metadata WHERE key = 'index_state'").get()
      : undefined;
    if (fila && fila.value !== 'complete') return { estado: 'incompleto', ficheros, motivo: `index_state=${fila.value}` };
    return { estado: ficheros > 0 ? 'ok' : 'vacio', ficheros, motivo: null };
  } catch (e) {
    return { estado: 'ilegible', ficheros: null, motivo: String((e && e.message) || e) };
  } finally {
    if (conn) {
      try { conn.close(); } catch (_) { /* ya cerrada */ }
    }
  }
}

/**
 * Estado del indice de `dir`. `home` se inyecta en los tests; por defecto es
 * la carpeta personal del usuario.
 */
function estadoIndice(dir, home = os.homedir()) {
  if (home && norm(dir) === norm(home)) {
    return { estado: 'carpeta-personal', ficheros: null, motivo: '~/.codegraph es el directorio global de CodeGraph' };
  }
  const db = path.join(dir, '.codegraph', 'codegraph.db');
  if (!fs.existsSync(db)) return { estado: 'sin-indice', ficheros: null, motivo: null };
  return leerIndice(db);
}

/** Accion para el estado dado: 'init', 'index' o null. */
function accionPara(estado) {
  return ACCION[estado] || null;
}

module.exports = { estadoIndice, accionPara };
