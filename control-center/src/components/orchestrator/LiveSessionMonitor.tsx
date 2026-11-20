// ULTRON Control Center — LiveSessionMonitor (panel global de subagentes y workflows).
//
// Visor de la actividad de subagentes y workflows de la sesión. No teclea nada.
// Muestra:
//   - las ejecuciones de workflows
//   - los subagentes activos y recientes (hooks SubagentStart/Stop)
//
// El último turno orquestado, el indicador de modo del hook memory-orchestrate
// y el previsualizador manual se retiraron el 2026-11-15 junto con el modo
// full del hook: ya nadie registra turnos de orquestación.
//
// «Routing reciente» se retiró el 2026-10-23: leía el log del dispatcher, que
// está desconectado desde el 2026-09-29 y solo escriben los arneses.
//
// CONTROLADO: el `feed` llega por prop desde SessionsPane, que hace el poll de
// live_session_feed junto con el de list_active_sessions.
//
// El panel de agentes delegados (delegations.jsonl + eventos
// workflow:delegating/delegated) se retiró el 2026-10-17: no tenía productor.
//
// Las secciones viven en ./live-session/* (cat7.4: este archivo pasaba de 800
// líneas); este componente solo compone el layout y el estado de colapso.

import type { LiveSessionFeed } from "../sessions/sessionTypes";
import { fmtTime } from "../sessions/orchShared";
import { Chevron } from "./live-session/Chevron";
import { WorkflowRunsPanel } from "./live-session/WorkflowRunsPanel";
import { RecentSubagentsPanel } from "./live-session/RecentSubagentsPanel";
import { RunningSubagentsPanel } from "./live-session/RunningSubagentsPanel";

// ---------------------------------------------------------------------------
// LiveSessionMonitor — panel global controlado por props
// ---------------------------------------------------------------------------

interface LiveSessionMonitorProps {
  /** Feed compartido (lo provee el contenedor con un único poll). */
  feed: LiveSessionFeed | null;
  /** Error del fetch del feed (opcional). */
  error?: string | null;
  /** Si está colapsado, solo se muestra la cabecera. */
  collapsed?: boolean;
  /** Toggle de colapso; si no se pasa, no se muestra el chevron. */
  onToggleCollapse?: () => void;
}

export default function LiveSessionMonitor({
  feed,
  error = null,
  collapsed = false,
  onToggleCollapse,
}: LiveSessionMonitorProps) {
  return (
    <div
      className="flex flex-col gap-3 rounded-md p-3"
      style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onToggleCollapse}
          disabled={!onToggleCollapse}
          className="flex items-center gap-2 disabled:cursor-default"
          style={{ background: "transparent", border: "none", padding: 0 }}
          title={onToggleCollapse ? (collapsed ? "Expandir" : "Colapsar") : undefined}
          aria-expanded={!collapsed}
        >
          {onToggleCollapse && (
            <span style={{ color: "var(--color-text-tertiary)" }}>
              <Chevron open={!collapsed} />
            </span>
          )}
          <span
            className="text-[11px] font-semibold uppercase tracking-[0.07em]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Subagentes y workflows
          </span>
          {feed && (
            <span className="text-[9.5px]" style={{ color: "var(--color-text-faint)" }}>
              act. {fmtTime(feed.generated_at)}
            </span>
          )}
        </button>
      </div>

      {!collapsed && (
        <>
          {error && (
            <div
              className="rounded px-3 py-1.5 text-[11px]"
              style={{
                background: "rgba(248,81,73,0.06)",
                border: "1px solid rgba(248,81,73,0.22)",
                color: "var(--color-danger, #ef4444)",
              }}
            >
              {error}
            </div>
          )}

          <WorkflowRunsPanel />

          <RunningSubagentsPanel runningSubagents={feed?.running_subagents ?? []} />

          <RecentSubagentsPanel subagents={feed?.subagents ?? []} />
        </>
      )}
    </div>
  );
}
