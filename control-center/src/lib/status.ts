import type { GlobalStatus, AlertEntry } from "../types";
import { getTs } from "../components/notifications/dedupe";
import { isHidden } from "../components/notifications/dismissed";
import { loadDismissed } from "../components/notifications/persistence";

export function computeGlobalStatus(alerts: AlertEntry[]): GlobalStatus {
  if (!alerts || alerts.length === 0) return "ok";

  // Load dismissed fingerprints from localStorage so the sidebar dot does
  // not stay red/amber for alerts the user already acknowledged in the
  // Notifications tab. Same store, fingerprint and rule as the Notifications
  // component: an alert that fires again after being hidden counts again.
  const dismissed = loadDismissed();

  const visibleAlerts = alerts.filter((a) => {
    if (!a || typeof a !== "object") return false;
    // Same key as `groupKey` in Notifications.tsx (missing source -> "").
    const msg = (a.message ?? "").trim().replace(/\s+/g, " ");
    const fp = `${a.source ?? ""}::${msg.slice(0, 80)}`;
    return !isHidden(dismissed, fp, getTs(a));
  });

  if (visibleAlerts.length === 0) return "ok";

  // Critical alerts present → down
  const criticalSeverities = new Set(["critical", "blocking"]);
  if (visibleAlerts.some((a) => criticalSeverities.has(a.severity))) return "down";

  // Warn-level alerts → warn (ack field is unreliable; rely on dismissed set instead)
  if (visibleAlerts.some((a) => a.severity === "warn")) return "warn";

  return "ok";
}

export function statusColor(s: GlobalStatus): string {
  switch (s) {
    case "ok":
      return "var(--color-success)";
    case "warn":
      return "var(--color-warn)";
    case "down":
      return "var(--color-danger)";
    default:
      return "var(--color-text-tertiary)";
  }
}

export function statusLabel(s: GlobalStatus): string {
  switch (s) {
    case "ok":
      return "Operativo";
    case "warn":
      return "Degradado";
    case "down":
      return "Hay problemas";
    default:
      return "Cargando…";
  }
}
