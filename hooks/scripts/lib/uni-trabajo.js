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

module.exports = { MARKER_NAME, DEFAULT_PROTEGIDAS, MAX_LEVELS, findTrabajoMarker, matchProtected };
