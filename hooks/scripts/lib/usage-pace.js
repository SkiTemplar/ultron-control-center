'use strict';
/**
 * usage-pace.js — ritmo de consumo de los limites del plan (5 h y semanal).
 *
 * Compara el % de cuota usado con el % de ventana transcurrido. Si al ritmo
 * actual la cuota se agota antes del reset (usado > transcurrido), la ventana
 * va "por encima del ritmo". Con un suelo de uso (MIN_USED_PCT) para que el
 * arranque de ventana no dispare avisos por un 3 % gastado en 5 minutos.
 *
 * En la ventana semanal, el % transcurrido no es lineal si hay un horario de uso
 * (lib/usage-schedule.js): pasa a ser el % de uso esperado hasta ahora. La de 5 h
 * es siempre lineal.
 *
 * Consumidores: cockpit/statusline.js (badge en la barra) y
 * hooks/scripts/usage-pace-guard.js (aviso al agente). La tarjeta del Control
 * Center replica la misma regla en control-center/src/components/usage/planPace.ts.
 */

const { loadSchedule, weightedElapsedPct } = require('./usage-schedule');

const MIN_USED_PCT = 15;

// Ventanas cuyo % transcurrido se pondera con el horario de uso.
const SCHEDULED_WINDOW_PREFIXES = ['seven_day'];

// Todas las ventanas (5 h y semanal) avisan con la misma regla de ritmo. El techo
// absoluto del 25 % en la de 5 h se retiro el 2026-10-26 al bajar de plan: era
// la fraccion del plan anterior que equivalia al plan inferior.

const WINDOW_SECONDS = {
  five_hour: 5 * 3600,
  seven_day: 7 * 86400,
};

/** Duracion de la ventana por clave del payload; null si no se conoce. */
function windowSeconds(key) {
  const k = String(key || '');
  if (WINDOW_SECONDS[k]) return WINDOW_SECONDS[k];
  if (k.startsWith('seven_day')) return WINDOW_SECONDS.seven_day;
  if (k.startsWith('five_hour')) return WINDOW_SECONDS.five_hour;
  return null;
}

/** resets_at en epoch segundos: acepta epoch s, epoch ms o ISO 8601. */
function toEpochSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value / 1000 : value;
  }
  if (typeof value === 'string' && value) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms / 1000;
  }
  return null;
}

/**
 * Ritmo de una ventana.
 * @param {string} key          clave del payload (five_hour, seven_day, ...)
 * @param {number} usedPct      % de cuota usado (0-100)
 * @param {number|string} resetsAt  instante de reset (epoch s/ms o ISO)
 * @param {number} [nowSec]     ahora en epoch segundos (inyectable en tests)
 * @returns {{used:number, elapsedPct:number, linearElapsedPct:number, scheduled:boolean,
 *            projectedPct:number, over:boolean, alert:boolean}|null}
 */
function windowPace(key, usedPct, resetsAt, nowSec = Date.now() / 1000) {
  const duration = windowSeconds(key);
  const reset = toEpochSeconds(resetsAt);
  const used = Number(usedPct);
  if (!duration || reset === null || !Number.isFinite(used)) return null;

  const remaining = Math.min(duration, Math.max(0, reset - nowSec));
  const linearElapsedPct = ((duration - remaining) / duration) * 100;
  let elapsedPct = linearElapsedPct;
  let scheduled = false;
  if (SCHEDULED_WINDOW_PREFIXES.some((p) => String(key).startsWith(p))) {
    const schedule = loadSchedule();
    const weighted = schedule ? weightedElapsedPct(reset - duration, nowSec, reset, schedule) : null;
    if (weighted !== null) {
      elapsedPct = weighted;
      scheduled = true;
    }
  }
  const projectedPct = elapsedPct > 0 ? (used / elapsedPct) * 100 : used > 0 ? Infinity : 0;
  const over = used >= MIN_USED_PCT && used < 100 && used > elapsedPct;
  return { used, elapsedPct, linearElapsedPct, scheduled, projectedPct, over, alert: over };
}

/** Ritmo de todas las ventanas de `rate_limits` del payload del statusline. */
function paceAll(rateLimits, nowSec) {
  const out = {};
  for (const [key, w] of Object.entries(rateLimits || {})) {
    if (!w) continue;
    const p = windowPace(key, w.used_percentage, w.resets_at, nowSec);
    if (p) out[key] = { ...p, resetsAt: toEpochSeconds(w.resets_at) };
  }
  return out;
}

module.exports = { MIN_USED_PCT, windowSeconds, toEpochSeconds, windowPace, paceAll };
