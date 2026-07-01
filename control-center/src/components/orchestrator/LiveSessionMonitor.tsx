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

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { LiveSessionFeed } from "../sessions/sessionTypes";
import {
  KIND_TINT,
  SectionLabel,
  fmtTime,
  isRelevantRoutingMsg,
  routingMeta,
  statusColor,
} from "../sessions/orchShared";

// ---------------------------------------------------------------------------
// Tipos locales — eventos en vivo + preview manual
// ---------------------------------------------------------------------------

// Eventos en vivo emitidos por el backend al delegar/terminar un agente.
type DelegatingPayload = {
  agent: string;
  task_preview?: string;
  provider?: string;
  started_at?: string;
};
type DelegatedPayload = {
  agent: string;
  status?: string;
  task_preview?: string;
  duration_ms?: number;
};

type LiveEvent = {
  seq: number; // id estable para la key de React (la lista usa prepend)
  agent: string;
  status: string; // delegating | done | timeout | launched | failed
  preview: string;
  provider?: string;
  at: string; // ISO
};

// Espejo de orchestrator::OrchestrationContext (modulo orchestrator/, snake_case sin rename) —
// respuesta de invoke('orchestrate_prompt') para el preview manual (F2.1).
type OrchestrationPreview = {
  prompt: string;
  route: string;
  project_id: string | null;
  workflow: { id: string; label: string; description: string; steps: string[] } | null;
  delegate_agents: { name: string; description: string; score: number }[];
  delegate_skills: { name: string; description: string; kind: string; score: number }[];
  memories: { scope: string; title: string | null; summary: string | null }[];
  constraints: string[];
  warnings: string[];
  token_budget: number;
  cross_project: boolean;
  /** cat13: paso de mejora de prompt (encuadre + modo + clarificaciones). */
  prompt_plan?: {
    improved_prompt: string;
    suggested_mode: string;
    clarifying_questions: string[];
    success_criteria: string[];
  } | null;
};

const MAX_LIVE_EVENTS = 8;

// ---------------------------------------------------------------------------
// Chevron de colapso (inline SVG)
// ---------------------------------------------------------------------------

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 0.15s ease",
      }}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

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
  const [liveEvents, setLiveEvents] = useState<LiveEvent[]>([]);
  // Preview manual de orquestacion (F2.1): teclea un prompt y ve que haria el
  // orquestador (intent/workflow/agentes/skills/memorias) SIN ejecutar nada.
  const [previewInput, setPreviewInput] = useState("");
  const [preview, setPreview] = useState<OrchestrationPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const seqRef = useRef(0);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  // Eventos en vivo de delegacion de agentes.
  useEffect(() => {
    const unlisten: Array<() => void> = [];
    let active = true;

    const pushEvent = (ev: Omit<LiveEvent, "seq">) => {
      const withSeq: LiveEvent = { ...ev, seq: seqRef.current++ };
      setLiveEvents((prev) => [withSeq, ...prev].slice(0, MAX_LIVE_EVENTS));
    };

    void (async () => {
      const u1 = await listen<DelegatingPayload>("workflow:delegating", (e) => {
        pushEvent({
          agent: e.payload.agent,
          status: "delegating",
          preview: e.payload.task_preview ?? "",
          provider: e.payload.provider,
          at: e.payload.started_at ?? new Date().toISOString(),
        });
      });
      const u2 = await listen<DelegatedPayload>("workflow:delegated", (e) => {
        pushEvent({
          agent: e.payload.agent,
          status: e.payload.status ?? "done",
          preview: e.payload.task_preview ?? "",
          at: new Date().toISOString(),
        });
      });
      if (active) {
        unlisten.push(u1, u2);
      } else {
        u1();
        u2();
      }
    })();

    return () => {
      active = false;
      for (const u of unlisten) u();
    };
  }, []);

  const runPreview = useCallback(async () => {
    const prompt = previewInput.trim();
    if (!prompt || previewBusy) return;
    setPreviewBusy(true);
    setPreviewError(null);
    try {
      const ctx = await invoke<OrchestrationPreview>("orchestrate_prompt", {
        prompt,
        projectId: null,
      });
      if (!mountedRef.current) return;
      setPreview(ctx);
    } catch (e) {
      if (!mountedRef.current) return;
      setPreviewError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setPreviewBusy(false);
    }
  }, [previewInput, previewBusy]);

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

          {/* Ultimo turno orquestado */}
          {last ? (
            <div className="flex flex-col gap-2">
              <SectionLabel>Ultimo turno</SectionLabel>
              {last.prompt && (
                <div
                  className="rounded px-2 py-1 text-[11px]"
                  style={{
                    background: "var(--color-surface-1)",
                    color: "var(--color-text-secondary)",
                  }}
                  title={last.prompt}
                >
                  <span style={{ color: "var(--color-text-faint)" }}>{fmtTime(last.ts)} </span>
                  {last.prompt}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-1.5">
                {last.route && (
                  <span
                    className="rounded px-2 py-0.5 text-[10px] font-semibold"
                    style={{
                      background: "rgba(88,166,255,0.10)",
                      color: "var(--color-accent)",
                      border: "1px solid rgba(88,166,255,0.28)",
                    }}
                    title="Intent detectado"
                  >
                    {last.route}
                  </span>
                )}
                {last.workflow?.id && (
                  <span
                    className="rounded px-2 py-0.5 text-[10px]"
                    style={{
                      background: "var(--color-surface-3)",
                      color: "var(--color-text-secondary)",
                      border: "1px solid var(--color-border-strong)",
                    }}
                    title={last.workflow.label ?? undefined}
                  >
                    wf: {last.workflow.label ?? last.workflow.id}
                  </span>
                )}
                {last.project && (
                  <span className="text-[10px]" style={{ color: "var(--color-text-faint)" }}>
                    {last.project}
                  </span>
                )}
                {last.cross_project && (
                  <span
                    className="rounded px-2 py-0.5 text-[10px] font-medium"
                    style={{
                      background: "rgba(234,179,8,0.12)",
                      color: "#ca8a04",
                      border: "1px solid rgba(234,179,8,0.30)",
                    }}
                  >
                    cross-project
                  </span>
                )}
              </div>

              {/* Agentes + skills del ultimo turno */}
              <div className="grid gap-2" style={{ gridTemplateColumns: "1fr 1fr" }}>
                <div>
                  <SectionLabel>Agentes sugeridos</SectionLabel>
                  {last.agents.length > 0 ? (
                    <div className="flex flex-col gap-0.5">
                      {last.agents.map((a) => (
                        <div key={a.name} className="flex items-center justify-between gap-2">
                          <span
                            className="truncate text-[11px]"
                            style={{ color: "var(--color-text)", fontFamily: "var(--font-mono)" }}
                          >
                            {a.name}
                          </span>
                          <span
                            className="shrink-0 text-[9.5px] tabular-nums"
                            style={{
                              color: "var(--color-text-faint)",
                              fontFamily: "var(--font-mono)",
                            }}
                          >
                            {a.score.toFixed(2)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[10px]" style={{ color: "var(--color-text-faint)" }}>
                      —
                    </p>
                  )}
                </div>
                <div>
                  <SectionLabel>Skills aceptadas</SectionLabel>
                  {last.skills.length > 0 ? (
                    <div className="flex flex-col gap-0.5">
                      {last.skills.map((s) => (
                        <div key={s.name} className="flex items-center justify-between gap-2">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span
                              className="truncate text-[11px]"
                              style={{ color: "var(--color-text)", fontFamily: "var(--font-mono)" }}
                            >
                              {s.name}
                            </span>
                            {s.kind && (
                              <span
                                className="shrink-0 text-[8.5px] uppercase"
                                style={{ color: KIND_TINT[s.kind] ?? "var(--color-text-faint)" }}
                              >
                                {s.kind}
                              </span>
                            )}
                          </span>
                          <span
                            className="shrink-0 text-[9.5px] tabular-nums"
                            style={{
                              color: "var(--color-text-faint)",
                              fontFamily: "var(--font-mono)",
                            }}
                          >
                            {s.score.toFixed(2)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[10px]" style={{ color: "var(--color-text-faint)" }}>
                      —
                    </p>
                  )}
                </div>
              </div>

              {/* Memorias inyectadas del ultimo turno */}
              {last.memories.length > 0 && (
                <div>
                  <SectionLabel>Memoria inyectada ({last.memories.length})</SectionLabel>
                  <div className="flex flex-col gap-0.5">
                    {last.memories.slice(0, 6).map((m, i) => (
                      <div
                        key={`${m.scope}-${i}`}
                        className="truncate text-[10px]"
                        style={{ color: "var(--color-text-tertiary)" }}
                        title={m.summary}
                      >
                        <span style={{ color: "var(--color-text-faint)" }}>[{m.scope}]</span>{" "}
                        {m.summary}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            !error && (
              <p className="text-[10.5px]" style={{ color: "var(--color-text-tertiary)" }}>
                Sin actividad de orquestacion todavia. Escribe en cualquier sesion de Claude Code y
                aparecera aqui (el hook UserPromptSubmit la registra).
              </p>
            )
          )}

          {/* Agentes en vivo (eventos) + delegaciones recientes */}
          {(liveEvents.length > 0 || (feed?.delegations.length ?? 0) > 0) && (
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
                        <span
                          className="shrink-0 text-[9px]"
                          style={{ color: "var(--color-text-faint)" }}
                        >
                          {ev.provider}
                        </span>
                      )}
                    </span>
                    <span
                      className="shrink-0 text-[9.5px]"
                      style={{ color: statusColor(ev.status) }}
                    >
                      {ev.status} · {fmtTime(ev.at)}
                    </span>
                  </div>
                ))}
                {feed?.delegations.map((d) => (
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
                    <span
                      className="shrink-0 text-[9.5px]"
                      style={{ color: statusColor(d.status) }}
                    >
                      {d.status} · {fmtTime(d.started_at)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Subagentes EN VUELO (SubagentStart sin SubagentStop): el "en vivo"
              real. El backend reduce el log de ciclo de vida por agent_id. */}
          {(feed?.running_subagents.length ?? 0) > 0 && (
            <div>
              <SectionLabel>Subagentes activos ({feed?.running_subagents.length})</SectionLabel>
              <div className="flex flex-col gap-0.5">
                {feed?.running_subagents.map((s) => (
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
                    <span
                      className="shrink-0 text-[9.5px]"
                      style={{ color: "var(--color-success, #3fb950)" }}
                    >
                      corriendo · {fmtTime(s.started_at)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Subagentes recientes (SubagentStop harvest): tareas de subagente ya
              TERMINADAS de esta maquina. Complementa "Agentes delegados" (que son
              delegaciones de la app + eventos workflow:* en vivo). */}
          {(feed?.subagents.length ?? 0) > 0 && (
            <div>
              <SectionLabel>Subagentes recientes</SectionLabel>
              <p className="mb-1 text-[9px]" style={{ color: "var(--color-text-faint)" }}>
                Subagentes (Task tool) ya terminados — el hook los registra al finalizar.
              </p>
              <div className="flex flex-col gap-1">
                {feed?.subagents.slice(0, 6).map((s, i) => (
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
          )}

          {/* Preview de orquestacion (F2.1 — la insignia): que haria el orquestador
              con un prompt dado, sin ejecutar nada. invoke('orchestrate_prompt'). */}
          <div>
            <SectionLabel>Previsualizar orquestacion</SectionLabel>
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={previewInput}
                onChange={(e) => setPreviewInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void runPreview();
                }}
                placeholder="Escribe un prompt y ve que haria el orquestador…"
                className="min-w-0 flex-1 rounded px-2 py-1 text-[11px]"
                style={{
                  background: "var(--color-surface-1)",
                  border: "1px solid var(--color-border-strong)",
                  color: "var(--color-text)",
                }}
              />
              <button
                type="button"
                onClick={() => void runPreview()}
                disabled={previewBusy || !previewInput.trim()}
                className="shrink-0 rounded px-2 py-1 text-[10px] font-medium disabled:opacity-50"
                style={{
                  background: "rgba(88,166,255,0.10)",
                  color: "var(--color-accent)",
                  border: "1px solid rgba(88,166,255,0.28)",
                }}
              >
                {previewBusy ? "…" : "Previsualizar"}
              </button>
            </div>
            {previewError && (
              <p className="mt-1 text-[10px]" style={{ color: "var(--color-danger, #ef4444)" }}>
                {previewError}
              </p>
            )}
            {preview && (
              <div
                className="mt-2 flex flex-col gap-1.5 rounded px-2 py-2"
                style={{
                  background: "var(--color-surface-1)",
                  border: "1px solid var(--color-border)",
                }}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span
                    className="rounded px-2 py-0.5 text-[10px] font-semibold"
                    style={{
                      background: "rgba(88,166,255,0.10)",
                      color: "var(--color-accent)",
                      border: "1px solid rgba(88,166,255,0.28)",
                    }}
                    title="Intent detectado"
                  >
                    {preview.route}
                  </span>
                  {preview.workflow && (
                    <span
                      className="rounded px-2 py-0.5 text-[10px]"
                      style={{
                        background: "var(--color-surface-3)",
                        color: "var(--color-text-secondary)",
                        border: "1px solid var(--color-border-strong)",
                      }}
                      title={preview.workflow.description}
                    >
                      wf: {preview.workflow.label}
                    </span>
                  )}
                  <span
                    className="text-[10px] tabular-nums"
                    style={{ color: "var(--color-text-faint)" }}
                  >
                    budget {preview.token_budget}t
                  </span>
                </div>
                {preview.workflow && preview.workflow.steps.length > 0 && (
                  <p className="text-[10px]" style={{ color: "var(--color-text-tertiary)" }}>
                    pasos: {preview.workflow.steps.join(" → ")}
                  </p>
                )}
                {preview.delegate_agents.length > 0 && (
                  <p
                    className="text-[10.5px]"
                    style={{ color: "var(--color-text-secondary)", fontFamily: "var(--font-mono)" }}
                  >
                    agentes:{" "}
                    {preview.delegate_agents
                      .map((a) => `${a.name} (${a.score.toFixed(2)})`)
                      .join(" · ")}
                  </p>
                )}
                {preview.delegate_skills.length > 0 && (
                  <p
                    className="text-[10.5px]"
                    style={{ color: "var(--color-text-secondary)", fontFamily: "var(--font-mono)" }}
                  >
                    skills:{" "}
                    {preview.delegate_skills
                      .map((s) => `${s.name} (${s.kind}, ${s.score.toFixed(2)})`)
                      .join(" · ")}
                  </p>
                )}
                {preview.memories.length > 0 && (
                  <div className="flex flex-col gap-0.5">
                    {preview.memories.slice(0, 5).map((m, i) => (
                      <div
                        key={`pm-${i}`}
                        className="truncate text-[10px]"
                        style={{ color: "var(--color-text-tertiary)" }}
                        title={m.summary ?? m.title ?? undefined}
                      >
                        <span style={{ color: "var(--color-text-faint)" }}>[{m.scope}]</span>{" "}
                        {m.title ?? m.summary ?? ""}
                      </div>
                    ))}
                  </div>
                )}
                {preview.warnings.length > 0 && (
                  <p className="text-[10px]" style={{ color: "#ca8a04" }}>
                    {preview.warnings.join(" · ")}
                  </p>
                )}
                {preview.prompt_plan && (
                  <div
                    className="mt-1 flex flex-col gap-1 rounded px-2 py-1.5"
                    style={{
                      background: "var(--color-surface-2)",
                      border: "1px dashed var(--color-border-strong)",
                    }}
                  >
                    <div className="flex items-center gap-1.5">
                      <SectionLabel>Prompt mejorado</SectionLabel>
                      <span
                        className="mb-1.5 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase"
                        style={{
                          background: "rgba(168,85,247,0.12)",
                          color: "#a855f7",
                          border: "1px solid rgba(168,85,247,0.3)",
                        }}
                        title="Modo ULTRON sugerido por el paso de mejora"
                      >
                        {preview.prompt_plan.suggested_mode}
                      </span>
                    </div>
                    <p
                      className="whitespace-pre-wrap text-[10.5px]"
                      style={{ color: "var(--color-text-secondary)" }}
                    >
                      {preview.prompt_plan.improved_prompt}
                    </p>
                    {preview.prompt_plan.clarifying_questions.length > 0 && (
                      <p className="text-[10px]" style={{ color: "#ca8a04" }}>
                        Aclarar antes: {preview.prompt_plan.clarifying_questions.join(" · ")}
                      </p>
                    )}
                    {preview.prompt_plan.success_criteria.length > 0 && (
                      <p className="text-[10px]" style={{ color: "var(--color-text-tertiary)" }}>
                        Éxito: {preview.prompt_plan.success_criteria.join(" · ")}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Routing reciente (timeline de decisiones del dispatcher) */}
          {relevantRouting.length > 0 && (
            <div>
              <SectionLabel>Routing reciente</SectionLabel>
              <div className="flex flex-col gap-0.5">
                {relevantRouting.slice(0, 6).map((r, i) => {
                  const meta = routingMeta(r.msg);
                  return (
                    <div
                      key={`r-${i}`}
                      className="flex items-center justify-between gap-2 text-[10px]"
                    >
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
          )}
        </>
      )}
    </div>
  );
}
