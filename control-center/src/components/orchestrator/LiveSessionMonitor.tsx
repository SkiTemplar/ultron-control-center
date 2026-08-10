// ULTRON Control Center — LiveSessionMonitor (panel global de orquestación).
//
// Visor EN VIVO de la orquestación. No teclea nada: muestra, en tiempo real, lo
// que el orquestador ya hace automático vía hooks:
//   - el último turno orquestado (prompt -> intent -> workflow -> agentes -> skills -> memorias)
//   - el routing reciente (skills aceptadas/omitidas + confianza)
//   - los agentes delegados (delegations.jsonl + eventos workflow:* en streaming)
//   - un previsualizador manual (orchestrate_prompt) sin ejecutar nada
//
// CONTROLADO: el `feed` llega por prop desde SessionsPane, que hace UN solo poll
// de live_session_feed para alimentar a la vez este panel y las tarjetas por
// sesión (antes cada uno polleaba el mismo comando por separado). Mantiene en
// propio: los listeners workflow:delegating/delegated (eventos ligeros) y el
// estado del previsualizador (orchestrate_prompt bajo demanda).
//
// Las secciones viven en ./live-session/* (cat7.4: este archivo pasaba de 800
// líneas); este componente solo compone el layout y el estado de colapso.

import type { LiveSessionFeed } from "../sessions/sessionTypes";
import { fmtTime, isRelevantRoutingMsg } from "../sessions/orchShared";
import { Chevron } from "./live-session/Chevron";
import { DelegatedAgentsPanel } from "./live-session/DelegatedAgentsPanel";
import { LastTurnPanel } from "./live-session/LastTurnPanel";
import { OrchestrationPreviewPanel } from "./live-session/OrchestrationPreviewPanel";
import { WorkflowRunsPanel } from "./live-session/WorkflowRunsPanel";
import { RecentSubagentsPanel } from "./live-session/RecentSubagentsPanel";
import { RoutingRecentPanel } from "./live-session/RoutingRecentPanel";
import { RunningSubagentsPanel } from "./live-session/RunningSubagentsPanel";
import { useLiveDelegationEvents } from "./live-session/useLiveDelegationEvents";

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
  // Eventos en vivo de delegacion de agentes (workflow:delegating/delegated).
  const liveEvents = useLiveDelegationEvents();

  const last = feed?.orchestrations[0] ?? null;
  // Solo mostramos decisiones de routing "interesantes", ocultando ruido de debug.
  const relevantRouting = (feed?.routing ?? []).filter((r) => isRelevantRoutingMsg(r.msg));

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
              background: "var(--color-success, #3fb950)",
              boxShadow: "0 0 6px var(--color-success, #3fb950)",
            }}
            aria-hidden
          />
          <span
            className="text-[11px] font-semibold uppercase tracking-[0.07em]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Orquestación en vivo
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

          <LastTurnPanel last={last} hasError={!!error} />

          <DelegatedAgentsPanel liveEvents={liveEvents} delegations={feed?.delegations ?? []} />

          <WorkflowRunsPanel />

          <RunningSubagentsPanel runningSubagents={feed?.running_subagents ?? []} />

          <RecentSubagentsPanel subagents={feed?.subagents ?? []} />

          <OrchestrationPreviewPanel />

          <RoutingRecentPanel relevantRouting={relevantRouting} />
        </>
      )}
    </div>
  );
}
