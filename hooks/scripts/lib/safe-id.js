'use strict';

/**
 * lib/safe-id.js — normaliza un identificador (project_id/session_id) para
 * usarlo como fragmento de ruta o nombre de fichero. Solo alfanumerico, guion
 * y guion bajo sobreviven; evita path traversal (`../`) y separadores si el
 * id llegara corrupto o manipulado. Compartido por lib/last-session.js,
 * lib/session-summary-delivery.js y session-summarize-previous.js (antes
 * cada uno tenia su propia copia — revision de codigo 2026-09-11).
 */
function safeId(id) {
  return String(id || 'unknown').replace(/[^A-Za-z0-9_-]/g, '-');
}

module.exports = { safeId };
