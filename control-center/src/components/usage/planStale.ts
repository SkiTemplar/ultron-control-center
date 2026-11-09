// Estado de frescura de «Plan limits».
//
// `claude_plan_limits` sirve la última respuesta buena con `stale = true` y el
// motivo en `last_error` cuando la llamada en vivo falla. La tarjeta decía
// siempre «offline · cached data»: un token OAuth caducado (401/403) se leía
// como «sin conexión» y no se sabía de cuándo eran los números. Este módulo
// clasifica el fallo y calcula la antigüedad.

export type PlanStaleKind = "auth" | "network" | "other";

export interface PlanStaleView {
  kind: PlanStaleKind;
  /** Etiqueta corta para la cabecera. */
  label: string;
  /** Motivo real devuelto por el backend, sin recortar. */
  detail: string | null;
  /** Qué hacer para salir del estado, si hay algo que hacer. */
  hint: string | null;
  /** «hace 12 min», a partir de `fetched_at`. */
  age: string | null;
}

const AUTH_RE = /\b(401|403)\b|oauth|token|credentials|accessToken/i;
const NETWORK_RE = /\bGET\b|sin red|network|timed? ?out|timeout|dns|connect|cliente HTTP/i;
/** El servidor respondió con un estado (429, 5xx…): hay red, falló otra cosa. */
const HTTP_STATUS_RE = /\bHTTP \d{3}\b/i;

export function classifyPlanError(error: string | null | undefined): PlanStaleKind {
  // La URL del endpoint lleva «oauth»: se quita para que un fallo de red no
  // pase por token rechazado.
  const e = (error ?? "").replace(/https?:\/\/\S+/g, "").trim();
  if (!e) return "other";
  if (AUTH_RE.test(e)) return "auth";
  if (HTTP_STATUS_RE.test(e)) return "other";
  if (NETWORK_RE.test(e)) return "network";
  return "other";
}

/** Antigüedad legible de un instante en segundos Unix; `null` si no es válido. */
export function ageFrom(fetchedAtSecs: number | null | undefined, nowMs: number): string | null {
  if (!fetchedAtSecs || !Number.isFinite(fetchedAtSecs) || fetchedAtSecs <= 0) return null;
  const mins = Math.max(0, Math.floor((nowMs - fetchedAtSecs * 1000) / 60_000));
  if (mins < 1) return "ahora mismo";
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `hace ${hours} h`;
  return `hace ${Math.floor(hours / 24)} d`;
}

const LABELS: Record<PlanStaleKind, string> = {
  auth: "token rechazado · datos en caché",
  network: "sin conexión · datos en caché",
  other: "falló la consulta en vivo · datos en caché",
};

const HINTS: Record<PlanStaleKind, string | null> = {
  auth: "Abre Claude Code (o ejecuta /login) para renovar la sesión; hasta entonces las cifras de abajo están congeladas.",
  network: "Las cifras de abajo son las últimas que se obtuvieron; se actualizan solas cuando vuelva la conexión.",
  other: null,
};

/**
 * Vista del estado «no fresco». Devuelve `null` con datos frescos y sin error
 * de refresco. `refreshError` es el fallo del último `invoke` (sin caché el
 * backend devuelve Err, y la tarjeta conservaba los datos anteriores sin aviso).
 */
export function planStaleView(
  data: { stale: boolean; fetched_at: number; last_error?: string | null } | null,
  refreshError: string | null,
  nowMs: number,
): PlanStaleView | null {
  if (!data) return null;
  const reason = data.stale ? (data.last_error ?? null) : refreshError;
  if (!data.stale && !refreshError) return null;
  const kind = classifyPlanError(reason);
  return {
    kind,
    label: LABELS[kind],
    detail: reason,
    hint: HINTS[kind],
    age: ageFrom(data.fetched_at, nowMs),
  };
}
