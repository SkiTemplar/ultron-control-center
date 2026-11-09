// usage-fit.mjs — calibra el horario de uso (cockpit/usage-schedule.json) con el
// gasto REAL por hora de la semana.
//
// El horario dice CUANDO se usa poco (franjas que escribe el usuario); los pesos
// (lowWeight, baseWeight del fin de semana) son cuanto pesa cada franja frente a
// una hora normal. Ese numero se medio a mano una vez (0,12 y 0,81 el 2026-09-28);
// aqui se recalcula solo con los transcripts, y se avisa de las franjas que ya no
// describen el uso real. Nunca cambia las franjas del usuario, solo los pesos.

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']; // orden de Date.getDay()
const DAY_LABELS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

/** Peso mínimo de franjas con datos para fiarse de un ajuste. */
const MIN_ACTIVE_SLOTS = 20;
/** Una franja declarada baja con media >= esta fracción de la hora normal, "no es baja". */
const BUSY_RATIO = 0.5;
/** Una hora normal entre semana con media <= esta fracción de la normal, "es tranquila". */
const QUIET_RATIO = 0.1;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round2 = (n) => Math.round(n * 100) / 100;

const isLowSlot = (schedule, dow, hour) =>
  (schedule.low[DAY_KEYS[dow]] || []).some(([a, b]) => hour + 0.5 >= a && hour + 0.5 < b);

/** [9,10,11,15] -> ["09:00-12:00", "15:00-16:00"]. */
export function hoursToRanges(hours) {
  const out = [];
  const pad = (h) => `${String(h).padStart(2, '0')}:00`;
  let start = null;
  let prev = null;
  for (const h of [...hours].sort((a, b) => a - b)) {
    if (start === null) {
      start = h;
    } else if (h !== prev + 1) {
      out.push(`${pad(start)}-${pad(prev + 1)}`);
      start = h;
    }
    prev = h;
  }
  if (start !== null) out.push(`${pad(start)}-${pad(prev + 1)}`);
  return out;
}

/**
 * Compara el gasto real con el horario.
 * @param {{cost:number[][], occurrences:number[]}} matrix  ver hourlyCostMatrix
 * @param {{lowWeight:number, baseWeight:object, low:object}} schedule  horario normalizado
 */
export function fitSchedule(matrix, schedule) {
  const mean = (dow, h) => (matrix.occurrences[dow] > 0 ? matrix.cost[dow][h] / matrix.occurrences[dow] : 0);

  const groups = { low: { cost: 0, n: 0 }, normal: { cost: 0, n: 0 }, weekend: { cost: 0, n: 0 } };
  let activeSlots = 0;
  const slots = [];
  for (let dow = 0; dow < 7; dow += 1) {
    for (let h = 0; h < 24; h += 1) {
      const m = mean(dow, h);
      if (m > 0) activeSlots += 1;
      const weekend = dow === 0 || dow === 6;
      const low = isLowSlot(schedule, dow, h);
      const group = low ? 'low' : weekend ? 'weekend' : 'normal';
      groups[group].cost += matrix.cost[dow][h];
      groups[group].n += matrix.occurrences[dow];
      slots.push({ dow, h, m, group });
    }
  }

  if (activeSlots < MIN_ACTIVE_SLOTS || groups.normal.n === 0 || groups.normal.cost <= 0) {
    return {
      sufficient: false,
      reason: `datos insuficientes: ${activeSlots} franjas horarias con uso (mínimo ${MIN_ACTIVE_SLOTS}) en la ventana analizada`,
    };
  }

  const avg = (g) => (g.n > 0 ? g.cost / g.n : null);
  const normalMean = avg(groups.normal);
  const lowMean = avg(groups.low);
  const weekendMean = avg(groups.weekend);

  const byDay = (pred) => {
    const perDay = new Map();
    for (const s of slots) if (pred(s)) perDay.set(s.dow, [...(perDay.get(s.dow) || []), s.h]);
    return [...perDay.entries()].map(([dow, hours]) => ({ day: DAY_LABELS[dow], ranges: hoursToRanges(hours) }));
  };

  return {
    sufficient: true,
    means: { normal: normalMean, low: lowMean, weekend: weekendMean },
    lowWeight: lowMean === null ? null : lowMean / normalMean,
    weekendWeight: weekendMean === null ? null : weekendMean / normalMean,
    lowButBusy: byDay((s) => s.group === 'low' && s.m >= BUSY_RATIO * normalMean),
    normalButQuiet: byDay((s) => s.group === 'normal' && s.m <= QUIET_RATIO * normalMean),
  };
}

/**
 * Devuelve el JSON crudo del horario con los pesos recalibrados. Conserva las
 * franjas, los comentarios y cualquier otra clave; solo toca lowWeight y el
 * baseWeight de sábado y domingo (si se midieron).
 */
export function applyFit(rawSchedule, fit) {
  if (!fit.sufficient) throw new Error(fit.reason);
  const next = JSON.parse(JSON.stringify(rawSchedule));
  if (fit.lowWeight !== null) next.lowWeight = round2(clamp(fit.lowWeight, 0.02, 1));
  if (fit.weekendWeight !== null) {
    next.baseWeight = { ...(next.baseWeight || {}) };
    const w = round2(clamp(fit.weekendWeight, 0.1, 2));
    next.baseWeight.sat = w;
    next.baseWeight.sun = w;
  }
  return next;
}
