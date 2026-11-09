'use strict';
/**
 * usage-schedule.js — calendario de uso esperado para el ritmo semanal.
 *
 * El ritmo lineal (% usado / % de tiempo transcurrido) supone que se usa Claude
 * por igual a cualquier hora. Con un horario real (franjas en las que no se
 * usa o se usa poco) la semana se reparte en horas de distinto peso y el % de
 * ventana transcurrida pasa a ser el % de USO ESPERADO hasta ahora:
 *
 *   esperado = suma de pesos de las horas ya vividas / suma de pesos de la ventana
 *   ritmo    = % usado / esperado        (100 % = agotar la cuota justo en el reset)
 *
 * Fichero (personal, ignorado por git): cockpit/usage-schedule.json. Plantilla
 * versionada: cockpit/usage-schedule.example.json. Sin fichero, o inválido, el
 * ritmo vuelve a ser lineal; `node hooks/scripts/lib/usage-schedule.js --check`
 * dice cuál de los dos casos es (nunca falla en silencio).
 *
 * Formato: { lowWeight, baseWeight?: {sat, sun...}, low: { mon: [["00:00","08:00"], ...], ... } }
 *   lowWeight  peso (0-1] de las horas dentro de una franja baja; 1 = sin efecto.
 *   baseWeight peso (0-2] por día para las horas fuera de franja (por defecto 1).
 *   low        franjas [inicio, fin) por día (mon..sun), hora local de la máquina.
 * Las claves que empiezan por «_» se ignoran (comentarios).
 *
 * Consumidores: lib/usage-pace.js (windowPace, solo ventana semanal) y
 * usage-pace-guard.js, que con loadScheduleResult anota en hook-errors.jsonl un
 * horario inválido (una vez por motivo y versión del fichero).
 * Apagado: ULTRON_USAGE_SCHEDULE=0. Fichero alternativo (tests): ULTRON_USAGE_SCHEDULE_FILE.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']; // orden de Date.getDay()
const STEP_SEC = 900; // resolución de la integración: 15 min

const scheduleFile = () =>
  process.env.ULTRON_USAGE_SCHEDULE_FILE || path.join(os.homedir(), '.ultron', 'cockpit', 'usage-schedule.json');

/** "HH:MM" → horas decimales (0-24), o null si no es válido. */
function parseHour(text) {
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(String(text));
  if (!m) return null;
  const hours = Number(m[1]) + Number(m[2]) / 60;
  return hours <= 24 ? hours : null;
}

/**
 * Valida y normaliza el JSON crudo.
 * @returns {{schedule: object|null, error: string|null}}
 */
function normalize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { schedule: null, error: 'no es un objeto' };
  const lowWeight = Number(raw.lowWeight);
  if (!(lowWeight > 0 && lowWeight <= 1)) return { schedule: null, error: 'lowWeight debe estar en (0, 1]' };

  const baseWeight = {};
  for (const [day, w] of Object.entries(raw.baseWeight || {})) {
    if (day.startsWith('_')) continue;
    if (!DAYS.includes(day)) return { schedule: null, error: `baseWeight: día desconocido «${day}»` };
    if (!(Number(w) > 0 && Number(w) <= 2)) return { schedule: null, error: `baseWeight.${day} debe estar en (0, 2]` };
    baseWeight[day] = Number(w);
  }

  const low = {};
  for (const [day, ranges] of Object.entries(raw.low || {})) {
    if (day.startsWith('_')) continue;
    if (!DAYS.includes(day)) return { schedule: null, error: `low: día desconocido «${day}»` };
    if (!Array.isArray(ranges)) return { schedule: null, error: `low.${day} debe ser una lista de franjas` };
    low[day] = [];
    for (const r of ranges) {
      const a = Array.isArray(r) ? parseHour(r[0]) : null;
      const b = Array.isArray(r) ? parseHour(r[1]) : null;
      if (a === null || b === null || !(a < b)) {
        return { schedule: null, error: `low.${day}: franja inválida ${JSON.stringify(r)} (formato ["HH:MM","HH:MM"], inicio < fin)` };
      }
      low[day].push([a, b]);
    }
  }
  return { schedule: { lowWeight, baseWeight, low }, error: null };
}

/**
 * Carga el calendario con el motivo si es inválido.
 * `error` es null sin fichero o con el calendario apagado (ritmo lineal esperado);
 * con texto, el fichero existe pero no se puede usar (JSON roto o reglas incumplidas).
 * @param {string} [file]
 * @returns {{schedule: object|null, error: string|null}}
 */
function loadScheduleResult(file = scheduleFile()) {
  if (process.env.ULTRON_USAGE_SCHEDULE === '0') return { schedule: null, error: null };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { schedule: null, error: null };
    return { schedule: null, error: `no se puede leer: ${e.message}` };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { schedule: null, error: `no es JSON válido: ${e.message}` };
  }
  return normalize(raw);
}

/**
 * Carga el calendario. `null` = sin calendario (lineal).
 * @param {string} [file]
 * @returns {object|null}
 */
function loadSchedule(file = scheduleFile()) {
  return loadScheduleResult(file).schedule;
}

/** Peso de un instante (Date en hora local). */
function weightAt(date, schedule) {
  const day = DAYS[date.getDay()];
  const hour = date.getHours() + date.getMinutes() / 60;
  const inLow = (schedule.low[day] || []).some(([a, b]) => hour >= a && hour < b);
  return inLow ? schedule.lowWeight : schedule.baseWeight[day] || 1;
}

/**
 * % de uso esperado transcurrido entre `startSec` y `endSec` en el instante `nowSec`.
 * @returns {number|null} 0-100, o null si la ventana no tiene peso.
 */
function weightedElapsedPct(startSec, nowSec, endSec, schedule) {
  const upto = Math.min(Math.max(nowSec, startSec), endSec);
  let done = 0;
  let total = 0;
  for (let t = startSec; t < endSec; t += STEP_SEC) {
    const seg = Math.min(STEP_SEC, endSec - t);
    const w = weightAt(new Date((t + seg / 2) * 1000), schedule) * seg;
    total += w;
    if (t + seg <= upto) done += w;
    else if (t < upto) done += w * ((upto - t) / seg);
  }
  return total > 0 ? (done / total) * 100 : null;
}

module.exports = {
  DAYS,
  parseHour,
  normalize,
  loadSchedule,
  loadScheduleResult,
  weightAt,
  weightedElapsedPct,
  scheduleFile,
};

if (require.main === module && process.argv.includes('--check')) {
  const file = scheduleFile();
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.log(`Sin calendario (${file}): ${e.code === 'ENOENT' ? 'no existe' : e.message}. Ritmo lineal.`);
    process.exit(1);
  }
  const { schedule, error } = normalize(raw);
  if (!schedule) {
    console.log(`Calendario INVÁLIDO (${file}): ${error}. Ritmo lineal.`);
    process.exit(1);
  }
  const lowHours = DAYS.reduce((n, d) => n + (schedule.low[d] || []).reduce((s, [a, b]) => s + (b - a), 0), 0);
  console.log(`Calendario válido (${file}): ${lowHours} h/semana en franja baja, peso ${schedule.lowWeight}.`);
}
