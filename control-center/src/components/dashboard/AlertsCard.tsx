// Recent alerts mini-feed (last 5).

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

  return (
    <Card
      title={`Alerts (${alerts.length})`}
      accent={accent}
      action={
        <SmallButton onClick={onOpenNotifications} title="Open notifications">
          open
        </SmallButton>
      }
      empty={recent.length === 0 ? "No alerts." : null}
    >
      <ul className="space-y-1.5">
        {recent.map((a, i) => {
          const ts = a.ts ?? a.timestamp;
          return (
            <li
              key={a.id ?? `${a.source}-${i}-${ts ?? ""}`}
              className="flex items-baseline gap-2 text-[11.5px]"
            >
              <span
                className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: severityColor(a.severity) }}
              />
              <span
                className="shrink-0 tabular-nums"
                style={{
                  color: "var(--color-text-faint)",
                  fontFamily: "var(--font-mono, ui-monospace)",
                  fontSize: 10,
                  minWidth: 56,
                }}
              >
                {relativeTime(ts)}
              </span>
              <span
                className="shrink-0 truncate"
                style={{ color: "var(--color-text-tertiary)", maxWidth: 90 }}
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
