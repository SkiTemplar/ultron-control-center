#!/usr/bin/env node
// hooks/scripts/lib/uni-trabajo.js — marcador de proyecto de trabajo
// universitario, compartido por socratic-gate.js (modo `uni`, recordatorio) y
// uni-deliverable-guard.js (bloqueo real de escritura).
//
// Decision del usuario 2026-09-14: en proyectos de asignatura, el texto
// evaluable (memoria, informe, TFG, cuestionario) lo redacta el alumno; el
// codigo de practicas SI puede escribirlo la IA. El marcador delimita QUE
// carpetas del proyecto son "el entregable" (protegidas de escritura por la
// IA), no el modo socratico en si.
//
// Formato del marcador `.ultron-trabajo.json` en la raiz del proyecto:
//   { "protegidas": ["borrador", "entrega"] }
// `protegidas` ausente o invalida -> DEFAULT_PROTEGIDAS. Rutas relativas a la
// carpeta donde vive el marcador (marker.dir).

'use strict';

const fs = require('fs');
const path = require('path');

const MARKER_NAME = '.ultron-trabajo.json';
const DEFAULT_PROTEGIDAS = ['borrador', 'entrega'];
const MAX_LEVELS = 4;

/**
 * Busca `.ultron-trabajo.json` subiendo desde `startDir` hasta MAX_LEVELS
 * niveles (inclusive de startDir). Se detiene si se sale de disco (raiz).
 *
 * @param {string} startDir
 * @returns {null | {dir:string, markerPath:string, protegidas:string[], corrupt:boolean, error?:Error}}
 *   null si no hay marcador en el rango. corrupt=true si el fichero existe
 *   pero no es JSON valido (o `protegidas` no es un array de strings): en ese
 *   caso protegidas cae a DEFAULT_PROTEGIDAS para que el llamante pueda
 *   avisar sin dejar de tener un valor utilizable.
 */
function findTrabajoMarker(startDir) {
  let dir;
  try {
    dir = path.resolve(String(startDir || '.'));
  } catch (_) {
    return null;
  }
  for (let i = 0; i <= MAX_LEVELS; i++) {
    const markerPath = path.join(dir, MARKER_NAME);
    if (fs.existsSync(markerPath)) {
      try {
        const raw = fs.readFileSync(markerPath, 'utf8');
        const data = JSON.parse(raw);
        const lista = data && Array.isArray(data.protegidas) ? data.protegidas : null;
        const validas = lista && lista.length && lista.every((x) => typeof x === 'string' && x.trim());
        return {
          dir,
          markerPath,
          protegidas: validas ? lista.map((x) => x.trim()) : DEFAULT_PROTEGIDAS.slice(),
          corrupt: !validas,
        };
      } catch (error) {
        return { dir, markerPath, protegidas: DEFAULT_PROTEGIDAS.slice(), corrupt: true, error };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // raiz de disco alcanzada
    dir = parent;
  }
  return null;
}

/**
 * Nombre de la carpeta protegida bajo la que cae `targetPath`, o null.
 * Resolucion por `path.resolve` (neutraliza `..`: el destino final ya
 * normalizado es lo que se compara) y comparacion case-insensitive (Windows).
 *
 * @param {string} targetPath
 * @param {{dir:string, protegidas:string[]}} marker
 * @returns {string|null}
 */
function matchProtected(targetPath, marker) {
  if (!marker || !targetPath) return null;
  let targetNorm;
  try {
    targetNorm = path.resolve(String(targetPath)).replace(/\\/g, '/').toLowerCase();
  } catch (_) {
    return null;
  }
  for (const carpeta of marker.protegidas) {
    const protectedDir = path.resolve(marker.dir, carpeta).replace(/\\/g, '/').toLowerCase();
    if (targetNorm === protectedDir || targetNorm.startsWith(`${protectedDir}/`)) return carpeta;
  }
  return null;
}

/**
 * Marcador que gobierna una escritura en `targetPath`: primero subiendo desde
 * la carpeta del destino y, si no hay, desde el cwd de la sesion.
 *
 * Motivo (H27 de la auditoria 2026-10-17): los marcadores viven en
 * `trabajos/<X>/` y la sesion se abre en la carpeta de la asignatura, POR
 * ENCIMA del marcador. Buscando solo desde el cwd no se encontraba nunca y el
 * bloqueo duro no protegia ninguna carpeta real.
 *
 * @param {string} targetPath ruta destino ya resuelta (absoluta)
 * @param {string} cwd
 */
function findMarkerForTarget(targetPath, cwd) {
  const desde = [];
  try {
    desde.push(path.dirname(path.resolve(String(targetPath))));
  } catch (_) {
    /* ruta irresoluble: queda el cwd */
  }
  // Un destino a mas de MAX_LEVELS por debajo del marcador
  // (`trabajos/T1/entrega/a/b/c/d/x.md`) no lo alcanza subiendo: se mira
  // tambien la raiz del trabajo deducida de la ruta.
  const trabajo = trabajoSinMarcador(targetPath);
  if (trabajo) desde.push(trabajo.trabajoDir);
  desde.push(cwd);
  for (const dir of desde) {
    const marker = findTrabajoMarker(dir);
    if (marker) return marker;
  }
  return null;
}

/**
 * Si `targetPath` cae en `trabajos/<X>/<carpeta por defecto>/…` (la estructura
 * de las asignaturas), devuelve la carpeta del trabajo y la protegida; si no,
 * null. Sirve para AVISAR de un trabajo sin marcador: sin el, nada lo protege.
 *
 * @param {string} targetPath
 * @returns {null | {trabajoDir:string, carpeta:string}}
 */
function trabajoSinMarcador(targetPath) {
  let resolved;
  try {
    resolved = path.resolve(String(targetPath || ''));
  } catch (_) {
    return null;
  }
  const parts = resolved.split(/[\\/]+/);
  const low = parts.map((p) => p.toLowerCase());
  for (let i = low.length - 3; i >= 0; i--) {
    if (low[i] !== 'trabajos') continue;
    const carpeta = DEFAULT_PROTEGIDAS.find((c) => c === low[i + 2]);
    if (!carpeta || i + 3 >= parts.length) continue;
    return { trabajoDir: parts.slice(0, i + 2).join(path.sep), carpeta };
  }
  return null;
}

module.exports = {
  MARKER_NAME,
  DEFAULT_PROTEGIDAS,
  MAX_LEVELS,
  findTrabajoMarker,
  findMarkerForTarget,
  matchProtected,
  trabajoSinMarcador,
};
