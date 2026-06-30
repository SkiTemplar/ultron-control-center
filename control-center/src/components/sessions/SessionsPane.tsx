// ULTRON Control Center — Monitor de sesiones activas ("Sesiones").
//
// Dashboard READ-ONLY que muestra todas las sesiones de Claude Code en curso.
// El usuario lanza muchas terminales en paralelo y necesita distinguirlas de un
// vistazo sin cambiar de ventana.
//
// Contrato backend: comando Tauri `list_active_sessions` → SessionInfo[].
// Polling cada 4 s + botón "Recargar" manual.
//
// Layout:
//   - Header: contador de sesiones + control de polling + botón recargar
//   - Un bloque por proyecto (project_name / project_path)
//   - Dentro: sesiones principales + sección "Subagentes" colapsable
//   - Estado vacío + estado de error + skeleton de carga

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  SessionInfo,
  ProjectGroup,
  SessionOrchestration,
  LiveSessionFeed,
} from "./sessionTypes";
import { SessionCard } from "./SessionCard";
import LiveSessionMonitor from "../orchestrator/LiveSessionMonitor";

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 4_000;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SessionsPaneProps {
  onOpenProject?: (projectId: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers de agrupación
// ---------------------------------------------------------------------------

/**
 * Agrupa un array plano de SessionInfo por proyecto.
 * Las sesiones con is_subagent=true van a un grupo separado dentro
 * del mismo bloque de proyecto.
 */
function groupByProject(sessions: SessionInfo[]): ProjectGroup[] {
  const map = new Map<string, ProjectGroup>();

  for (const s of sessions) {
    // Clave de agrupación: path normalizado (sin barra final)
    const key = s.project_path.replace(/[\\/]+$/, "");

    if (!map.has(key)) {
      map.set(key, {
        project_name: s.project_name,
        project_path: s.project_path,
        sessions: [],
        subagents: [],
      });
    }

    const group = map.get(key)!;
    if (s.is_subagent) {
      group.subagents.push(s);
    } else {
      group.sessions.push(s);
    }
  }

  // Orden: proyectos con sesiones "working" primero, luego alphabético
  const statusPriority = (g: ProjectGroup): number => {
    const allStatuses = [...g.sessions, ...g.subagents].map((s) => s.status);
    if (allStatuses.includes("working")) return 0;
    if (allStatuses.includes("waiting")) return 1;
    if (allStatuses.includes("idle")) return 2;
    return 3;
  };

  return Array.from(map.values()).sort((a, b) => {
    const pa = statusPriority(a);
    const pb = statusPriority(b);
    if (pa !== pb) return pa - pb;
    return a.project_name.localeCompare(b.project_name);
  });
}

// ---------------------------------------------------------------------------
// Icono de recarga (inline SVG, sin dep extra)
// ---------------------------------------------------------------------------

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={
        spinning
          ? { animation: "ultron-spin 0.8s linear infinite" }
          : undefined
      }
    >
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Bloque de un proyecto
// ---------------------------------------------------------------------------

interface ProjectBlockProps {
  group: ProjectGroup;
  orchBySession: Record<string, SessionOrchestration>;
  onOpenProject?: (projectId: string) => void;
}

function ProjectBlock({ group, orchBySession, onOpenProject }: ProjectBlockProps) {
  const [subagentsOpen, setSubagentsOpen] = useState(false);
  const totalCount = group.sessions.length + group.subagents.length;

  return (
    <section aria-label={`Proyecto ${group.project_name}`}>
      {/* Encabezado del bloque */}
      <div className="mb-2 flex items-baseline gap-2">
        <h2
          className="text-[12px] font-semibold"
          style={{ color: "var(--color-text)" }}
        >
          {group.project_name}
        </h2>
        <span
          className="text-[10px] tabular-nums"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {totalCount} sesion{totalCount !== 1 ? "es" : ""}
        </span>
        <span
          className="min-w-0 truncate text-[10px]"
          style={{
            color: "var(--color-text-faint)",
            fontFamily: "var(--font-mono)",
          }}
          title={group.project_path}
        >
          {group.project_path}
        </span>
      </div>

      {/* Sesiones principales */}
      {group.sessions.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {group.sessions.map((s) => (
            <SessionCard
              key={s.session_id}
              session={s}
              orchestration={orchBySession[s.session_id] ?? null}
              onOpenProject={onOpenProject}
            />
          ))}
        </div>
      )}

      {/* Sub-sección de subagentes — colapsable */}
      {group.subagents.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setSubagentsOpen((v) => !v)}
            className="flex items-center gap-1.5 rounded px-2 py-1 text-[10.5px] transition-colors"
            style={{
              background: "transparent",
              color: "var(--color-text-tertiary)",
              border: "1px solid var(--color-border)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--color-surface-2)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
            }}
            aria-expanded={subagentsOpen}
          >
            {/* Chevron */}
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
              style={{
                transform: subagentsOpen ? "rotate(90deg)" : "rotate(0deg)",
                transition: "transform 0.15s ease",
              }}
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
            Subagentes ({group.subagents.length})
          </button>

          {subagentsOpen && (
            <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {group.subagents.map((s) => (
                <SessionCard
                  key={s.session_id}
                  session={s}
                  orchestration={orchBySession[s.session_id] ?? null}
                  onOpenProject={onOpenProject}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// SessionsPane — componente principal exportado
// ---------------------------------------------------------------------------

export function SessionsPane({ onOpenProject }: SessionsPaneProps) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  // Feed completo de orquestación (live_session_feed). UN solo fetch alimenta a la
  // vez el panel global en vivo (último turno + routing + delegaciones) y la
  // correlación por session_id que enriquece cada tarjeta.
  const [feed, setFeed] = useState<LiveSessionFeed | null>(null);
  const [orchBySession, setOrchBySession] = useState<Record<string, SessionOrchestration>>({});
  // Panel global de orquestación: colapsable para no robar espacio a la lista.
  const [orchOpen, setOrchOpen] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [polling, setPolling] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Las sesiones "dead" (>5 h sin actividad) se ocultan por defecto: el monitor
  // es para sesiones en curso. Toggle para mostrarlas cuando se quieran inspeccionar.
  const [showDead, setShowDead] = useState(false);

  // Ref para poder cancelar el polling sin desmontar el componente
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Fetch principal ──────────────────────────────────────────────────────

  const fetchSessions = useCallback(async (showSpinner = false) => {
    if (showSpinner) setRefreshing(true);
    try {
      // Sesiones + feed de orquestación en paralelo. El feed es complementario:
      // si falla, las sesiones se muestran igual (sin el bloque de orquestación).
      const [data, liveFeed] = await Promise.all([
        invoke<SessionInfo[]>("list_active_sessions"),
        invoke<LiveSessionFeed>("live_session_feed", { limit: 50 }).catch(() => null),
      ]);
      setSessions(data);
      if (liveFeed) {
        setFeed(liveFeed);
        // feed.orchestrations viene newest-first: la PRIMERA entrada de cada
        // session_id es su último turno orquestado.
        const map: Record<string, SessionOrchestration> = {};
        for (const o of liveFeed.orchestrations) {
          if (o.session_id && !(o.session_id in map)) map[o.session_id] = o;
        }
        setOrchBySession(map);
      }
      setError(null);
      setLastUpdated(new Date());
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : typeof err === "string"
          ? err
          : "Error desconocido al llamar a list_active_sessions",
      );
    } finally {
      setLoading(false);
      if (showSpinner) setRefreshing(false);
    }
  }, []);

  // Carga inicial
  useEffect(() => {
    void fetchSessions(false);
  }, [fetchSessions]);

  // Polling cada 4 s (solo cuando polling=true)
  useEffect(() => {
    if (!polling) {
      if (pollRef.current !== null) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }

    pollRef.current = setInterval(() => {
      void fetchSessions(false);
    }, POLL_INTERVAL_MS);

    return () => {
      if (pollRef.current !== null) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [polling, fetchSessions]);

  // ── Derivaciones ─────────────────────────────────────────────────────────

  const deadCount = sessions.filter((s) => s.status === "dead").length;
  const visibleSessions = showDead
    ? sessions
    : sessions.filter((s) => s.status !== "dead");
  const groups = groupByProject(visibleSessions);
  const activeCount = visibleSessions.filter(
    (s) => s.status === "working" || s.status === "waiting",
  ).length;

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div
      className="flex h-full flex-col overflow-hidden"
      style={{ background: "var(--color-surface-1)" }}
    >
      {/* Estilos de animación de spin para el icono de refresh */}
      <style>{`
        @keyframes ultron-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div
        className="flex shrink-0 items-center gap-3 border-b px-5 py-3 flex-wrap"
        style={{
          borderColor: "var(--color-border)",
          background: "var(--color-surface-2)",
        }}
      >
        {/* Título + contador */}
        <div className="flex items-baseline gap-2 min-w-0">
          <h1
            className="text-[13px] font-semibold"
            style={{ color: "var(--color-text)" }}
          >
            Sesiones activas
          </h1>
          {!loading && (
            <span
              className="text-[11px] tabular-nums"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {visibleSessions.length}
              {!showDead && deadCount > 0 && ` (+${deadCount} muertas)`}
              {activeCount > 0 && (
                <span style={{ color: "var(--color-success, #3fb950)" }}>
                  {" "}
                  · {activeCount} activas
                </span>
              )}
            </span>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* Timestamp de última actualización */}
          {lastUpdated && (
            <span
              className="text-[10px] tabular-nums"
              style={{ color: "var(--color-text-faint)" }}
            >
              {lastUpdated.toLocaleTimeString()}
            </span>
          )}

          {/* Toggle mostrar/ocultar sesiones muertas (solo si las hay) */}
          {deadCount > 0 && (
            <button
              type="button"
              onClick={() => setShowDead((v) => !v)}
              className="rounded px-2.5 py-1 text-[11px] transition-colors"
              style={{
                background: showDead
                  ? "var(--color-surface-3)"
                  : "transparent",
                color: showDead
                  ? "var(--color-text-secondary)"
                  : "var(--color-text-tertiary)",
                border: "1px solid var(--color-border)",
              }}
              title={
                showDead
                  ? "Ocultar sesiones muertas (>5 h inactivas)"
                  : `Mostrar ${deadCount} sesion${deadCount !== 1 ? "es" : ""} muerta${deadCount !== 1 ? "s" : ""} (>5 h inactivas)`
              }
            >
              {showDead ? "Ocultar muertas" : `Muertas (${deadCount})`}
            </button>
          )}

          {/* Toggle de polling */}
          <button
            type="button"
            onClick={() => setPolling((v) => !v)}
            className="rounded px-2.5 py-1 text-[11px] transition-colors"
            style={{
              background: polling
                ? "rgba(63,185,80,0.10)"
                : "var(--color-surface-3)",
              color: polling
                ? "var(--color-success, #3fb950)"
                : "var(--color-text-tertiary)",
              border: polling
                ? "1px solid rgba(63,185,80,0.25)"
                : "1px solid var(--color-border)",
            }}
            title={
              polling
                ? "Polling activo cada 4 s — clic para pausar"
                : "Polling pausado — clic para reanudar"
            }
          >
            {polling ? "Auto" : "Pausado"}
          </button>

          {/* Botón recargar manual */}
          <button
            type="button"
            onClick={() => void fetchSessions(true)}
            disabled={refreshing}
            className="flex items-center gap-1.5 rounded px-3 py-1.5 text-[12px] transition-colors disabled:opacity-60"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--color-surface-3)";
              e.currentTarget.style.borderColor = "var(--color-border-strong)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "var(--color-surface-2)";
              e.currentTarget.style.borderColor = "var(--color-border)";
            }}
            title="Recargar sesiones ahora"
          >
            <RefreshIcon spinning={refreshing} />
            Recargar
          </button>
        </div>
      </div>

      {/* ── Cuerpo scrollable ───────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">

        {/* Panel GLOBAL de orquestación en vivo (último turno + routing +
            delegaciones + previsualizador). Comparte el feed con las tarjetas. */}
        <LiveSessionMonitor
          feed={feed}
          error={error}
          collapsed={!orchOpen}
          onToggleCollapse={() => setOrchOpen((v) => !v)}
        />

        {/* Estado de carga inicial */}
        {loading && (
          <div
            className="flex items-center justify-center py-16"
            aria-live="polite"
            aria-label="Cargando sesiones"
          >
            <span
              className="text-[12px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Cargando sesiones…
            </span>
          </div>
        )}

        {/* Error */}
        {!loading && error !== null && (
          <div
            className="rounded p-3 text-[12px]"
            role="alert"
            style={{
              background: "rgba(239,68,68,0.08)",
              color: "var(--color-danger, #ef4444)",
              border: "1px solid rgba(239,68,68,0.28)",
            }}
          >
            <span className="font-semibold">
              list_active_sessions devolvio error:{" "}
            </span>
            {error}
          </div>
        )}

        {/* Estado vacío (ninguna sesión visible; puede haber muertas ocultas) */}
        {!loading && error === null && visibleSessions.length === 0 && (
          <div
            className="flex flex-col items-center justify-center gap-2 py-20"
            aria-live="polite"
          >
            {/* Icono monitor */}
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
              style={{ color: "var(--color-text-faint)" }}
            >
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
            <p
              className="text-[13px] font-medium"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              No hay sesiones activas
            </p>
            <p
              className="text-[11px]"
              style={{ color: "var(--color-text-faint)" }}
            >
              {deadCount > 0
                ? `${deadCount} sesion${deadCount !== 1 ? "es" : ""} muerta${deadCount !== 1 ? "s" : ""} oculta${deadCount !== 1 ? "s" : ""} — usa "Muertas (${deadCount})" para verlas.`
                : "Lanza Claude Code en cualquier terminal para verla aqui."}
            </p>
          </div>
        )}

        {/* Grupos de proyectos */}
        {!loading &&
          error === null &&
          groups.map((group) => (
            <ProjectBlock
              key={group.project_path}
              group={group}
              orchBySession={orchBySession}
              onOpenProject={onOpenProject}
            />
          ))}

        {/* Nota de pie */}
        {!loading && visibleSessions.length > 0 && (
          <p
            className="text-[10px] pt-2"
            style={{ color: "var(--color-text-faint)" }}
          >
            Datos via list_active_sessions · polling cada {POLL_INTERVAL_MS / 1000}s ·
            solo lectura
          </p>
        )}
      </div>
    </div>
  );
}
