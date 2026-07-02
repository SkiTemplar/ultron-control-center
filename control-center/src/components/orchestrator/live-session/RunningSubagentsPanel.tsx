// ULTRON Control Center — sección "Subagentes activos" del panel LiveSessionMonitor.
// Subagentes EN VUELO (SubagentStart sin SubagentStop): el "en vivo" real.
// El backend reduce el log de ciclo de vida por agent_id.

import type { RunningSubagent } from "../../sessions/sessionTypes";
import { SectionLabel, fmtTime } from "../../sessions/orchShared";

interface RunningSubagentsPanelProps {
  runningSubagents: RunningSubagent[];
}

export function RunningSubagentsPanel({ runningSubagents }: RunningSubagentsPanelProps) {
  if (runningSubagents.length === 0) return null;

  return (
    <div>
      <SectionLabel>Subagentes activos ({runningSubagents.length})</SectionLabel>
      <div className="flex flex-col gap-0.5">
        {runningSubagents.map((s) => (
          <div key={`run-${s.agent_id}`} className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full"
                style={{ background: "var(--color-success, #3fb950)" }}
                aria-hidden
              />
              <span
                className="truncate text-[11px]"
                style={{ color: "var(--color-text)", fontFamily: "var(--font-mono)" }}
              >
                {s.agent === "unknown" ? "subagente" : s.agent}
              </span>
              {s.label && (
                <span
                  className="truncate text-[9px]"
                  style={{ color: "var(--color-text-faint)" }}
                  title={s.label}
                >
                  {s.label}
                </span>
              )}
            </span>
            <span className="shrink-0 text-[9.5px]" style={{ color: "var(--color-success, #3fb950)" }}>
              corriendo · {fmtTime(s.started_at)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
