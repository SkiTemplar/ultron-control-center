// ULTRON Control Center — sección "Subagentes recientes" del panel LiveSessionMonitor.
// Subagentes (Task tool) ya TERMINADOS (SubagentStop harvest), cosechados por el
// hook al finalizar. Complementa "Agentes delegados" (delegaciones de la app +
// eventos workflow:* en vivo).

import type { SubagentActivity } from "../../sessions/sessionTypes";
import { SectionLabel, fmtTime } from "../../sessions/orchShared";

interface RecentSubagentsPanelProps {
  subagents: SubagentActivity[];
}

export function RecentSubagentsPanel({ subagents }: RecentSubagentsPanelProps) {
  if (subagents.length === 0) return null;

  return (
    <div>
      <SectionLabel>Subagentes recientes</SectionLabel>
      <p className="mb-1 text-[9px]" style={{ color: "var(--color-text-faint)" }}>
        Subagentes (Task tool) ya terminados — el hook los registra al finalizar.
      </p>
      <div className="flex flex-col gap-1">
        {subagents.slice(0, 6).map((s, i) => (
          <div key={`sa-${s.ts ?? "x"}-${i}`} className="flex flex-col gap-0.5">
            <div className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="shrink-0" style={{ color: "#a855f7" }} aria-hidden>
                  ◆
                </span>
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
              <span
                className="shrink-0 text-[9.5px] tabular-nums"
                style={{ color: "var(--color-text-faint)", fontFamily: "var(--font-mono)" }}
              >
                {s.chars}c · {fmtTime(s.ts)}
              </span>
            </div>
            {s.preview && (
              <p
                className="truncate text-[10px]"
                style={{ color: "var(--color-text-tertiary)" }}
                title={s.preview}
              >
                {s.preview}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
