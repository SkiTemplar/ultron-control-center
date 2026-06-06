import type { GlobalStatus, AlertEntry } from "../types";

export function computeGlobalStatus(alerts: AlertEntry[]): GlobalStatus {
  if (!alerts || alerts.length === 0) return "ok";

  // Load dismissed fingerprints from localStorage so the sidebar dot does
  // not stay red/amber for alerts the user already acknowledged in the
  // Notifications tab. The dismissed set uses the same key and fingerprint
  // logic as the Notifications component.
  const dismissed = loadDismissedFingerprints();

  const visibleAlerts = alerts.filter((a) => {
    if (!a || typeof a !== "object") return false;
    const msg = (a.message ?? "").trim().replace(/\s+/g, " ");
    const fp = `${a.source ?? ""}::${msg.slice(0, 80)}`;
    return !dismissed.has(fp);
  });

  if (visibleAlerts.length === 0) return "ok";

  // Critical alerts present → down
  const criticalSeverities = new Set(["critical", "blocking"]);
  if (visibleAlerts.some((a) => criticalSeverities.has(a.severity))) return "down";

  // Warn-level alerts → warn (ack field is unreliable; rely on dismissed set instead)
  if (visibleAlerts.some((a) => a.severity === "warn")) return "warn";

  return "ok";
}

function loadDismissedFingerprints(): Set<string> {
  try {
    const raw = localStorage.getItem("ultron.cc.dismissed_fingerprints.v1");
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
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
      return "Operational";
    case "warn":
      return "Degraded";
    case "down":
      return "Issues detected";
    default:
      return "Loading…";
  }
}
