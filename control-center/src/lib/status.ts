import type { GlobalStatus, QdrantHealth, AlertEntry } from "../types";

export function computeGlobalStatus(
  qdrant: QdrantHealth | null,
  qdrantErr: string | null,
  alerts: AlertEntry[],
): GlobalStatus {
  if (!qdrant && !qdrantErr) return "loading";

  // Critical alerts present → down
  const criticalSeverities = new Set(["critical", "blocking"]);
  if (alerts.some((a) => criticalSeverities.has(a.severity))) return "down";

  // Qdrant explicitly down
  if (qdrant && qdrant.status !== "up") return "down";
  if (qdrantErr) return "down";

  // Warn-level alerts unacked → warn
  if (alerts.some((a) => a.severity === "warn" && !a.ack)) return "warn";

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
      return "Operational";
    case "warn":
      return "Degraded";
    case "down":
      return "Issues detected";
    default:
      return "Loading…";
  }
}
