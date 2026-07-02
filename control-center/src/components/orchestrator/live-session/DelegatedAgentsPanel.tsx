// ULTRON Control Center — sección "Agentes delegados" del panel LiveSessionMonitor.
// Combina eventos en vivo (workflow:delegating/delegated, esta sesión) con las
// delegaciones persistidas en delegations.jsonl (feed compartido).

import type { DelegationLogEntry } from "../../sessions/sessionTypes";
import { SectionLabel, fmtTime, statusColor } from "../../sessions/orchShared";
import type { LiveEvent } from "./types";

interface DelegatedAgentsPanelProps {
  liveEvents: LiveEvent[];
  delegations: DelegationLogEntry[];
}

export function DelegatedAgentsPanel({ liveEvents, delegations }: DelegatedAgentsPanelProps) {
  if (liveEvents.length === 0 && delegations.length === 0) return null;

  return (
    <div>
      <SectionLabel>Agentes delegados</SectionLabel>
      <div className="flex flex-col gap-0.5">
        {liveEvents.map((ev) => (
          <div key={ev.seq} className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="shrink-0" style={{ color: statusColor(ev.status) }}>
                ●
              </span>
              <span
                className="truncate text-[11px]"
                style={{ color: "var(--color-text)", fontFamily: "var(--font-mono)" }}
              >
                {ev.agent}
              </span>
              {ev.provider && (
                <span className="shrink-0 text-[9px]" style={{ color: "var(--color-text-faint)" }}>
                  {ev.provider}
                </span>
              )}
            </span>
            <span className="shrink-0 text-[9.5px]" style={{ color: statusColor(ev.status) }}>
              {ev.status} · {fmtTime(ev.at)}
            </span>
          </div>
        ))}
        {delegations.map((d) => (
          <div key={d.id} className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="shrink-0" style={{ color: statusColor(d.status) }}>
                ○
              </span>
              <span
                className="truncate text-[11px]"
                style={{
                  color: "var(--color-text-secondary)",
                  fontFamily: "var(--font-mono)",
                }}
                title={d.task_preview}
              >
                {d.agent}
              </span>
            </span>
            <span className="shrink-0 text-[9.5px]" style={{ color: statusColor(d.status) }}>
              {d.status} · {fmtTime(d.started_at)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
