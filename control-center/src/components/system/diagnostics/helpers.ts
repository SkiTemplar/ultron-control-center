// Diagnostics — severity/level display helpers

import type { CommonErrorCheckResult, CommonErrorSeverity, EventLogLevel } from "./types";

export const SEVERITY_LABELS: Record<CommonErrorSeverity, string> = {
  critical: "crítico",
  warning: "aviso",
  info: "información",
};

/**
 * Resultado de `diagnostics_run` tal como se enseña junto al error. El backend
 * también devuelve "unknown" (sin comprobación registrada o no concluyente).
 */
export const CHECK_STATUS_LABELS: Record<CommonErrorCheckResult["status"] | "unknown", string> = {
  ok: "Correcto",
  fail: "Falla",
  warn: "Aviso",
  unknown: "Sin determinar",
};

export function severityIcon(s: CommonErrorSeverity): { symbol: string; color: string } {
  switch (s) {
    case "critical": return { symbol: "●", color: "var(--color-danger, #f85149)" };
    case "warning":  return { symbol: "▲", color: "var(--color-warn, #d29922)" };
    case "info":     return { symbol: "◆", color: "var(--color-accent, #58a6ff)" };
  }
}

export function levelBadge(level: EventLogLevel): { bg: string; fg: string; label: string } {
  switch (level) {
    case "critical": return { bg: "rgba(248,81,73,0.18)", fg: "var(--color-danger)", label: "Crítico" };
    case "error":    return { bg: "rgba(248,81,73,0.10)", fg: "var(--color-danger)", label: "Error" };
    case "warning":  return { bg: "rgba(210,153,34,0.14)", fg: "var(--color-warn)", label: "Aviso" };
    case "information": return { bg: "rgba(88,166,255,0.10)", fg: "var(--color-accent,#58a6ff)", label: "Información" };
    default: return { bg: "rgba(187,187,187,0.10)", fg: "var(--color-text-tertiary)", label: level };
  }
}
