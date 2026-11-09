// Horario de uso para el ritmo semanal — port de hooks/scripts/lib/usage-schedule.js
// (statusline y hook usage-pace-guard). Mismas reglas de validacion, mismo pesado por
// horas y misma integracion en 15 min; un test de paridad compara ambas
// implementaciones sobre los mismos instantes para que no se desvien en silencio.
//
// El % de ventana transcurrida deja de ser lineal: pasa a ser el % de USO ESPERADO
// hasta ahora, sumando el peso de cada hora vivida frente al peso de toda la ventana.

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const; // orden de Date.getDay()
export type DayKey = (typeof DAYS)[number];

const STEP_MS = 900_000; // 15 min

export interface UsageSchedule {
  /** Peso (0, 1] de las horas dentro de una franja baja; 1 = sin efecto. */
  lowWeight: number;
  /** Peso (0, 2] por dia para las horas fuera de franja (1 por defecto). */
  baseWeight: Partial<Record<DayKey, number>>;
  /** Franjas [inicio, fin) por dia, en horas decimales locales. */
  low: Partial<Record<DayKey, Array<[number, number]>>>;
}

function parseHour(text: unknown): number | null {
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(String(text));
  if (!m) return null;
  const hours = Number(m[1]) + Number(m[2]) / 60;
  return hours <= 24 ? hours : null;
}

const isDay = (d: string): d is DayKey => (DAYS as readonly string[]).includes(d);

/** Resultado de validar el horario: `error` explica por que es invalido (mismos textos que usage-schedule.js). */
export interface ScheduleValidation {
  schedule: UsageSchedule | null;
  error: string | null;
}

const invalid = (error: string): ScheduleValidation => ({ schedule: null, error });

/** Valida y normaliza el JSON crudo; con `error` si es invalido (el ritmo vuelve a ser lineal). */
export function validateSchedule(raw: unknown): ScheduleValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid("no es un objeto");
  const r = raw as Record<string, unknown>;
  const lowWeight = Number(r.lowWeight);
  if (!(lowWeight > 0 && lowWeight <= 1)) return invalid("lowWeight debe estar en (0, 1]");

  const baseWeight: UsageSchedule["baseWeight"] = {};
  for (const [day, w] of Object.entries((r.baseWeight as Record<string, unknown>) ?? {})) {
    if (day.startsWith("_")) continue;
    if (!isDay(day)) return invalid(`baseWeight: día desconocido «${day}»`);
    if (!(Number(w) > 0 && Number(w) <= 2)) return invalid(`baseWeight.${day} debe estar en (0, 2]`);
    baseWeight[day] = Number(w);
  }

  const low: UsageSchedule["low"] = {};
  for (const [day, ranges] of Object.entries((r.low as Record<string, unknown>) ?? {})) {
    if (day.startsWith("_")) continue;
    if (!isDay(day)) return invalid(`low: día desconocido «${day}»`);
    if (!Array.isArray(ranges)) return invalid(`low.${day} debe ser una lista de franjas`);
    const parsed: Array<[number, number]> = [];
    for (const range of ranges) {
      const a = Array.isArray(range) ? parseHour(range[0]) : null;
      const b = Array.isArray(range) ? parseHour(range[1]) : null;
      if (a === null || b === null || !(a < b)) {
        return invalid(`low.${day}: franja inválida ${JSON.stringify(range)} (formato ["HH:MM","HH:MM"], inicio < fin)`);
      }
      parsed.push([a, b]);
    }
    low[day] = parsed;
  }
  return { schedule: { lowWeight, baseWeight, low }, error: null };
}

/** Valida y normaliza el JSON crudo; null si es invalido (el ritmo vuelve a ser lineal). */
export function normalizeSchedule(raw: unknown): UsageSchedule | null {
  return validateSchedule(raw).schedule;
}

/** Peso de un instante (hora local). */
export function weightAt(date: Date, schedule: UsageSchedule): number {
  const day = DAYS[date.getDay()];
  const hour = date.getHours() + date.getMinutes() / 60;
  const inLow = (schedule.low[day] ?? []).some(([a, b]) => hour >= a && hour < b);
  return inLow ? schedule.lowWeight : schedule.baseWeight[day] ?? 1;
}

/** % de uso esperado transcurrido entre `startMs` y `endMs` en `nowMs`; null si la ventana no pesa. */
export function weightedElapsedPct(startMs: number, nowMs: number, endMs: number, schedule: UsageSchedule): number | null {
  const upto = Math.min(Math.max(nowMs, startMs), endMs);
  let done = 0;
  let total = 0;
  for (let t = startMs; t < endMs; t += STEP_MS) {
    const seg = Math.min(STEP_MS, endMs - t);
    const w = weightAt(new Date(t + seg / 2), schedule) * seg;
    total += w;
    if (t + seg <= upto) done += w;
    else if (t < upto) done += w * ((upto - t) / seg);
  }
  return total > 0 ? (done / total) * 100 : null;
}
