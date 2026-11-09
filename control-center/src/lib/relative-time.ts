// Antigüedad relativa en español («hace 3 h», «hace 3 meses») a partir de un
// ISO 8601. Misma escala que el Panel (relativeTime de dashboard/Card) hasta
// los días, y además meses y años para fechas viejas, donde «hace 90 d» se lee
// peor que «hace 3 meses».

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTH_DAYS = 30;
const YEAR_DAYS = 365;

/** Formatea una diferencia en ms (`now - fecha`). Futuro o < 1 min = «ahora mismo». */
export function formatAgeMs(diffMs: number): string {
  if (!Number.isFinite(diffMs) || diffMs < MINUTE_MS) return "ahora mismo";
  if (diffMs < HOUR_MS) return `hace ${Math.floor(diffMs / MINUTE_MS)} min`;
  if (diffMs < DAY_MS) return `hace ${Math.floor(diffMs / HOUR_MS)} h`;
  const days = Math.floor(diffMs / DAY_MS);
  if (days < MONTH_DAYS) return `hace ${days} d`;
  if (days < YEAR_DAYS) {
    // Redondeo: 89 d se lee «hace 3 meses», no «hace 2 meses».
    const months = Math.max(1, Math.round(days / MONTH_DAYS));
    return months === 1 ? "hace 1 mes" : `hace ${months} meses`;
  }
  const years = Math.floor(days / YEAR_DAYS);
  return years === 1 ? "hace 1 año" : `hace ${years} años`;
}

/**
 * Antigüedad relativa de un ISO. `null` si no hay fecha o no se puede
 * interpretar: el llamante decide qué pintar (sin fecha, «sin comprobar»…).
 */
export function formatRelativeTime(
  iso: string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (!iso) return null;
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return null;
  return formatAgeMs(now - ts);
}
