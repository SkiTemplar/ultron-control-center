// Helpers puros de Turn Off: formateo de cuenta atrás y validación de horas
// en cliente. Separados del componente para poder testearlos sin invoke() ni
// timers — el backend (src-tauri/src/turn_off.rs) sigue siendo la única
// fuente de verdad del rango válido; esto es solo feedback instantáneo de UX.

export const MIN_HOURS = 0.1;
export const MAX_HOURS = 24;

/** Segundos por unidad, usados para descomponer la cuenta atrás en hh:mm:ss. */
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_MINUTE = 60;

/**
 * Formatea segundos restantes como "HH:MM:SS" (dos dígitos por segmento,
 * las horas pueden superar 24 sin desbordar el formato). Negativos o no
 * finitos se clavan a "00:00:00" — un plazo vencido no debe mostrar signos
 * ni NaN.
 */
export function formatCountdown(remainingSeconds: number): string {
  const clamped = Number.isFinite(remainingSeconds) ? Math.max(0, Math.floor(remainingSeconds)) : 0;
  const hours = Math.floor(clamped / SECONDS_PER_HOUR);
  const minutes = Math.floor((clamped % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const seconds = clamped % SECONDS_PER_MINUTE;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/** Segundos restantes hasta el deadline (epoch, UTC), nunca negativos. */
export function secondsUntil(deadlineEpochSecs: number, nowEpochSecs: number): number {
  return Math.max(0, deadlineEpochSecs - nowEpochSecs);
}

/**
 * Validación de UX en cliente: mismo rango que el backend
 * (turn_off::MIN_HOURS / MAX_HOURS), solo para feedback instantáneo. El
 * backend revalida siempre — esto nunca sustituye esa validación.
 */
export function validateHours(hours: number): string | null {
  if (!Number.isFinite(hours)) return "Introduce un número de horas válido.";
  if (hours < MIN_HOURS || hours > MAX_HOURS) {
    return `Las horas deben estar entre ${MIN_HOURS} y ${MAX_HOURS}.`;
  }
  return null;
}
