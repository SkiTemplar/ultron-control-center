// Recent alerts mini-feed (last 5).
//
// v2.7 redesign: top-of-dashboard banner role. Larger header, severity-dot
// per row, source pill, and a clearer empty state.

import type { AlertEntry } from "../../types";
import { Card, SmallButton, relativeTime } from "./Card";

interface AlertsCardProps {
  alerts: AlertEntry[];
  onOpenNotifications?: () => void;
}

const SEVERITY_COLOR: Record<string, string> = {
  critical: "var(--color-danger)",
  blocking: "var(--color-danger)",
  warn: "var(--color-warn)",
  info: "var(--color-text-tertiary)",
};

function severityColor(s: string): string {
  return SEVERITY_COLOR[s] ?? "var(--color-text-tertiary)";
}

export function AlertsCard({ alerts, onOpenNotifications }: AlertsCardProps) {
  const critical = alerts.filter(
    (a) => a.severity === "critical" || a.severity === "blocking",
  ).length;
  const warn = alerts.filter((a) => a.severity === "warn").length;
  const accent = critical > 0 ? "danger" : warn > 0 ? "warn" : "neutral";
  const recent = alerts.slice(0, 5);

  const subtitle =
    alerts.length === 0
      ? "No pending alerts"
      : `${critical} critical · ${warn} warning · ${alerts.length} total`;

  return (
    <Card
      title="Notifications"
      subtitle={subtitle}
      accent={accent}
      action={
        <SmallButton
          onClick={onOpenNotifications}
          size="md"
          title="Open notifications"
        >
          Open
        </SmallButton>
      }
      empty={recent.length === 0 ? "Inbox clear." : null}
    >
      <ul className="space-y-1.5">
        {recent.map((a, i) => {
          const ts = a.ts ?? a.timestamp;
          return (
            <li
              key={a.id ?? `${a.source}-${i}-${ts ?? ""}`}
              className="flex items-baseline gap-3 text-[13px]"
            >
              <span
                className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ background: severityColor(a.severity) }}
              />
              <span
                className="shrink-0 tabular-nums text-[11px]"
                style={{
                  color: "var(--color-text-faint)",
                  fontFamily: "var(--font-mono, ui-monospace)",
                  minWidth: 60,
                }}
              >
                {relativeTime(ts)}
              </span>
              <span
                className="shrink-0 truncate rounded px-1.5 py-0.5 text-[10.5px] uppercase tracking-wide"
                style={{
                  color: "var(--color-text-tertiary)",
                  background: "var(--color-surface-3)",
                  maxWidth: 120,
                }}
                title={a.source}
              >
                {a.source}
              </span>
              <span
                className="flex-1 truncate"
                style={{ color: "var(--color-text)" }}
                title={a.message}
              >
                {a.message}
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
