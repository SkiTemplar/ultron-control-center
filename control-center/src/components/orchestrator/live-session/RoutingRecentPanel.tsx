// ULTRON Control Center — sección "Routing reciente" del panel LiveSessionMonitor.
// Timeline de decisiones del dispatcher (skills aceptadas/omitidas + confianza),
// ya filtradas a mensajes "interesantes" (isRelevantRoutingMsg) por el llamador.

import type { RoutingLogEntry } from "../../sessions/sessionTypes";
import { SectionLabel, fmtTime, routingMeta } from "../../sessions/orchShared";

interface RoutingRecentPanelProps {
  relevantRouting: RoutingLogEntry[];
}

export function RoutingRecentPanel({ relevantRouting }: RoutingRecentPanelProps) {
  if (relevantRouting.length === 0) return null;

  return (
    <div>
      <SectionLabel>Routing reciente</SectionLabel>
      <div className="flex flex-col gap-0.5">
        {relevantRouting.slice(0, 6).map((r, i) => {
          const meta = routingMeta(r.msg);
          return (
            <div key={`r-${i}`} className="flex items-center justify-between gap-2 text-[10px]">
              <span className="flex min-w-0 items-center gap-1.5">
                <span style={{ color: "var(--color-text-faint)" }}>{fmtTime(r.ts)}</span>
                <span style={{ color: meta.color }}>{meta.label}</span>
                {r.top && (
                  <span
                    className="truncate"
                    style={{
                      color: "var(--color-text-tertiary)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {r.top}
                  </span>
                )}
              </span>
              {typeof r.confidence === "number" && (
                <span
                  className="shrink-0 tabular-nums"
                  style={{
                    color: "var(--color-text-faint)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {r.confidence.toFixed(2)}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
