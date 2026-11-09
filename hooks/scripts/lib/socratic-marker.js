'use strict';
/**
 * lib/socratic-marker.js — marcador "protocolo socratico ya inyectado" de una
 * sesion (%TEMP%/ultron-socratic-<session_id>).
 *
 * socratic-gate.js inyecta el protocolo COMPLETO solo en el primer prompt de
 * la sesion (si no existe el marcador) y despues, como mucho, la version
 * corta. El marcador sobrevivia a /compact, asi que tras compactar el modelo
 * perdia el protocolo completo y no volvia a recibirlo (hooks-11, auditoria
 * 2026-10-23). PreCompact lo borra con resetSocraticMarker: el primer prompt
 * despues de compactar vuelve a llevar el protocolo entero.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function socraticMarkerPath(sessionId, tmp = os.tmpdir()) {
  const sid = String(sessionId || 'nosession').replace(/[^A-Za-z0-9_-]/g, '');
  return path.join(tmp, `ultron-socratic-${sid}`);
}

/** Borra el marcador de la sesion. true si existia y se borro. */
function resetSocraticMarker(sessionId, tmp = os.tmpdir()) {
  if (!sessionId) return false;
  try {
    fs.unlinkSync(socraticMarkerPath(sessionId, tmp));
    return true;
  } catch (e) {
    if (e && e.code === 'ENOENT') return false;
    throw e;
  }
}

module.exports = { socraticMarkerPath, resetSocraticMarker };
