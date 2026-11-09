// usage-hours.mjs — análisis puro del gasto por día y hora (sin E/S): ritmo de la última
// semana frente a tu semana habitual, horas trabajadas y horas punta.
//
// Entrada: { days: ['YYYY-MM-DD', ...] en orden, cost: Map<día, number[24]> } en USD
// nocionales (scripts/lib/usage-transcripts.mjs → dailyHourlyCost).

/** Una hora cuenta como trabajada si su gasto nocional llega a este umbral (USD). */
export const ACTIVE_HOUR_USD = 0.5;

const DOW_LABEL = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
/** Orden de la semana para las tablas: lunes primero. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

export const dowOf = (day) => new Date(`${day}T12:00:00`).getDay();
export const dowLabel = (dow) => DOW_LABEL[dow];

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : null);

/** Resumen de un día: gasto, horas trabajadas, primera y última hora con actividad. */
export function daySummary(hours) {
  const active = hours.map((c, h) => (c >= ACTIVE_HOUR_USD ? h : -1)).filter((h) => h >= 0);
  return {
    cost: sum(hours),
    activeHours: active.length,
    first: active.length ? active[0] : null,
    last: active.length ? active[active.length - 1] : null,
  };
}

/**
 * Días desde el primero con gasto: antes no hay transcripts (Claude Code los borra con
 * el tiempo) y contarlos como días sin trabajar hundiría tu media.
 */
export function fromFirstActivity(days, cost) {
  const first = days.findIndex((d) => (cost.get(d) ?? []).some((c) => c > 0));
  return first < 0 ? [] : days.slice(first);
}

/** Parte la lista de días en semanas de 7 días contadas desde el final (la última, la más reciente). */
export function weeksOf(days) {
  const weeks = [];
  for (let end = days.length; end - 7 >= 0; end -= 7) weeks.unshift(days.slice(end - 7, end));
  return weeks;
}

/** Totales de cada semana: gasto y horas trabajadas. */
export function weekTotals(days, cost) {
  return weeksOf(days).map((week) => {
    const summaries = week.map((d) => daySummary(cost.get(d) ?? new Array(24).fill(0)));
    return {
      from: week[0],
      to: week[week.length - 1],
      cost: sum(summaries.map((s) => s.cost)),
      activeHours: sum(summaries.map((s) => s.activeHours)),
      activeDays: summaries.filter((s) => s.activeHours > 0).length,
    };
  });
}

/**
 * Ritmo relativo: la última semana frente a la media de las anteriores (tu «normal»).
 * `ratio` 1 = como siempre; 1,3 = un 30 % más. `null` sin semanas de referencia.
 */
export function relativePace(totals) {
  if (totals.length < 2) return null;
  const last = totals[totals.length - 1];
  const base = totals.slice(0, -1);
  const baseCost = mean(base.map((w) => w.cost));
  const baseHours = mean(base.map((w) => w.activeHours));
  return {
    last,
    baseline: { weeks: base.length, cost: baseCost, activeHours: baseHours },
    costRatio: baseCost ? last.cost / baseCost : null,
    hoursRatio: baseHours ? last.activeHours / baseHours : null,
  };
}

/**
 * Matriz media por día de la semana y hora (USD/h) y, por celda, la fracción de días
 * de ese tipo en que esa hora se trabajó.
 */
export function weekdayHourMatrix(days, cost) {
  const total = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const worked = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const occ = new Array(7).fill(0);
  for (const d of days) {
    const dow = dowOf(d);
    occ[dow] += 1;
    (cost.get(d) ?? []).forEach((c, h) => {
      total[dow][h] += c;
      if (c >= ACTIVE_HOUR_USD) worked[dow][h] += 1;
    });
  }
  const avg = total.map((row, dow) => row.map((c) => (occ[dow] ? c / occ[dow] : 0)));
  const share = worked.map((row, dow) => row.map((n) => (occ[dow] ? n / occ[dow] : 0)));
  return { avg, share, occ };
}

/** Las `n` franjas (día, hora) con más gasto medio, de mayor a menor. */
export function peakHours(avg, n = 10) {
  const cells = [];
  avg.forEach((row, dow) => row.forEach((c, h) => cells.push({ dow, hour: h, avg: c })));
  return cells.filter((c) => c.avg > 0).sort((a, b) => b.avg - a.avg).slice(0, n);
}

/** Perfil por día de la semana: horas trabajadas y gasto medios, y horario típico. */
export function weekdayProfile(days, cost) {
  const by = new Map();
  for (const d of days) {
    const s = daySummary(cost.get(d) ?? new Array(24).fill(0));
    const dow = dowOf(d);
    by.set(dow, [...(by.get(dow) ?? []), s]);
  }
  return WEEK_ORDER.map((dow) => {
    const list = by.get(dow) ?? [];
    const worked = list.filter((s) => s.activeHours > 0);
    return {
      dow,
      days: list.length,
      activeHours: mean(list.map((s) => s.activeHours)) ?? 0,
      cost: mean(list.map((s) => s.cost)) ?? 0,
      first: mean(worked.map((s) => s.first)),
      last: mean(worked.map((s) => s.last)),
    };
  });
}

/** Intensidad de 0 a 4 de una celda respecto al máximo (para pintar la tabla con bloques). */
export function level(value, max) {
  if (!max || value <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((value / max) * 4)));
}
