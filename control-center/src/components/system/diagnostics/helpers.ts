// Diagnostics — severity/level display helpers

import type { CommonErrorSeverity, EventLogLevel } from "./types";

export function severityIcon(s: CommonErrorSeverity): { symbol: string; color: string } {
  switch (s) {
    case "critical": return { symbol: "●", color: "var(--color-danger, #f85149)" };
    case "warning":  return { symbol: "▲", color: "var(--color-warn, #d29922)" };
    case "info":     return { symbol: "◆", color: "var(--color-accent, #58a6ff)" };
  }
}

export function levelBadge(level: EventLogLevel): { bg: string; fg: string; label: string } {
  switch (level) {
    case "critical": return { bg: "rgba(248,81,73,0.18)", fg: "var(--color-danger)", label: "Critical" };
    case "error":    return { bg: "rgba(248,81,73,0.10)", fg: "var(--color-danger)", label: "Error" };
    case "warning":  return { bg: "rgba(210,153,34,0.14)", fg: "var(--color-warn)", label: "Warning" };
    case "information": return { bg: "rgba(88,166,255,0.10)", fg: "var(--color-accent,#58a6ff)", label: "Info" };
    default: return { bg: "rgba(187,187,187,0.10)", fg: "var(--color-text-tertiary)", label: level };
  }
}
