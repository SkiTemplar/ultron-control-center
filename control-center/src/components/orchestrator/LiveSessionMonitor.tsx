// ULTRON Control Center — LiveSessionMonitor (panel global de orquestación).
//
// Visor de la orquestación. No teclea nada. En el modo de producción (ligero,
// ULTRON_ORCHESTRATE sin definir) el hook memory-orchestrate solo inyecta el
// tono y no registra turnos, así que el panel lo dice en la cabecera en vez de
// presentar como actual el último turno full que quedó en orchestrate.jsonl.
// Muestra:
//   - el modo del hook (ligero / full) y, si lo hay, el último turno full con
//     su fecha (prompt -> intent -> workflow -> agentes -> skills -> memorias)
//   - los subagentes activos y recientes (hooks SubagentStart/Stop, vivos en
//     los dos modos)
//   - un previsualizador manual (orchestrate_prompt) de la orquestación full
//
// «Routing reciente» se retiró el 2026-10-23: leía el log del dispatcher, que
// está desconectado desde el 2026-09-29 y solo escriben los arneses.
//
// CONTROLADO: el `feed` llega por prop desde SessionsPane, que hace UN solo poll
// de live_session_feed para alimentar a la vez este panel y las tarjetas por
// sesión (antes cada uno polleaba el mismo comando por separado). Mantiene en
// propio el estado del previsualizador (orchestrate_prompt bajo demanda).
//
// El panel de agentes delegados (delegations.jsonl + eventos
// workflow:delegating/delegated) se retiró el 2026-10-17: no tenía productor.
//
// Las secciones viven en ./live-session/* (cat7.4: este archivo pasaba de 800
// líneas); este componente solo compone el layout y el estado de colapso.

import type { LiveSessionFeed } from "../sessions/sessionTypes";
import { fmtTime } from "../sessions/orchShared";
import { Chevron } from "./live-session/Chevron";
import { LastTurnPanel } from "./live-session/LastTurnPanel";
import { OrchestrationPreviewPanel } from "./live-session/OrchestrationPreviewPanel";
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
  const last = feed?.orchestrations[0] ?? null;
  const mode = feed?.orchestrate_mode ?? "light";
  const isFull = mode === "full";
  const dotColor = isFull ? "var(--color-success, #3fb950)" : "var(--color-text-faint)";

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
            className="inline-block h-2 w-2 rounded-full"
            style={{
              background: dotColor,
              boxShadow: isFull ? `0 0 6px ${dotColor}` : "none",
            }}
            aria-hidden
          />
          <span
            className="text-[11px] font-semibold uppercase tracking-[0.07em]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            {isFull ? "Orquestación en vivo (modo full)" : "Orquestación (modo ligero)"}
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

          <LastTurnPanel last={last} hasError={!!error} mode={mode} />

          <WorkflowRunsPanel />

          <RunningSubagentsPanel runningSubagents={feed?.running_subagents ?? []} />

          <RecentSubagentsPanel subagents={feed?.subagents ?? []} />

          <OrchestrationPreviewPanel mode={mode} denseEnabled={feed?.dense_enabled ?? false} />
        </>
      )}
    </div>
  );
}
