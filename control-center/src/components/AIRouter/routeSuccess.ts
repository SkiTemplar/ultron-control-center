// ULTRON Control Center — AI Router: tasa de éxito POR RUTA. Pura.
//
// Una ruta cuya cadena entera se salta (sin key, sin cuota) no hace ningún
// intento, así que `by_model` no la ve: con el 96 % de las rutas fallando, la
// tasa por intento marcaba 100 % en verde. Lo que cuenta es si la ruta respondió.

import type { RouterMetrics } from "./types";

export interface RouteSuccess {
  /** % de rutas con respuesta en la ventana reciente (o en el acumulado si no hay ventana); null sin rutas. */
  pct: number | null;
  /** Rutas de la ventana reciente. */
  window: number;
  /** Rutas sin respuesta en la ventana reciente. */
  failedRecent: number;
  /** % de rutas con respuesta en todo el histórico; null sin rutas. */
  cumulativePct: number | null;
  routesTotal: number;
  routesFailed: number;
}

const answeredPct = (failed: number, total: number): number | null =>
  total > 0 ? ((total - failed) / total) * 100 : null;

export function routeSuccess(metrics: RouterMetrics): RouteSuccess {
  const recent = metrics.recent_outcomes ?? [];
  const failedRecent = recent.filter((o) => o === "failed").length;
  const routesTotal = metrics.routes_total ?? 0;
  const routesFailed = metrics.routes_failed ?? 0;
  const cumulativePct = answeredPct(routesFailed, routesTotal);
  return {
    pct: recent.length > 0 ? answeredPct(failedRecent, recent.length) : cumulativePct,
    window: recent.length,
    failedRecent,
    cumulativePct,
    routesTotal,
    routesFailed,
  };
}
