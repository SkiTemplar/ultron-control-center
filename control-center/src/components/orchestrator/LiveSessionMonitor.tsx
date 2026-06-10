// ULTRON Control Center — LiveSessionMonitor (la insignia).
//
// Visor EN VIVO de la sesion activa de Claude Code. No teclea nada: muestra,
// en tiempo real, lo que el orquestador ya hace automatico via hooks:
//   - el ultimo turno orquestado (prompt -> intent -> workflow -> agentes -> skills -> memorias)
//   - el routing reciente (skills aceptadas/omitidas + confianza)
//   - los agentes delegados (delegations.jsonl + eventos workflow:* en streaming)
//
// Fuentes (todas read-only, ya escritas por los hooks):
//   ~/.claude/logs/orchestrate.jsonl, ~/.claude/logs/routing-dispatcher.jsonl,
//   ~/.ultron/cockpit/delegations.jsonl  ->  comando Tauri `live_session_feed`
//   eventos Tauri workflow:delegating / workflow:delegated (live)
//
// Contrato: espejo de LiveSessionFeed (Rust, snake_case sin serde rename).

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ---------------------------------------------------------------------------
// Tipos — espejo de commands/sessions_sub/live_session.rs (snake_case)
// ---------------------------------------------------------------------------

type WorkflowLite = { id: string | null; label: string | null };
type AgentLite = { name: string; score: number };
type SkillLite = { name: string; kind: string; score: number };
type MemoryLite = { scope: string; summary: string };

type OrchestrateLogEntry = {
  ts: string | null;
  session_id: string | null;
  project: string | null;
  prompt: string | null;
  route: string | null;
  workflow: WorkflowLite | null;
  agents: AgentLite[];
  skills: SkillLite[];
  memories: MemoryLite[];
  cross_project: boolean;
  warnings: string[];
};

type RoutingLogEntry = {
  ts: string | null;
  level: string | null;
  msg: string | null;
  top: string | null;
  score: number | null;
  confidence: number | null;
};

type DelegationLogEntry = {
  id: string;
  agent: string;
  task_preview: string;
  cwd: string | null;
  used_cheap_model: boolean;
  started_at: string;
  status: string;
  session_id: string | null;
};

type LiveSessionFeed = {
  orchestrations: OrchestrateLogEntry[];
  routing: RoutingLogEntry[];
  delegations: DelegationLogEntry[];
  generated_at: string;
};

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

const POLL_MS = 3000;
const MAX_LIVE_EVENTS = 8;

// ---------------------------------------------------------------------------
// Helpers de presentacion
// ---------------------------------------------------------------------------

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

const ROUTING_MSG: Record<string, { label: string; color: string }> = {
  high_confidence_routing: { label: "alta confianza", color: "var(--color-success, #3fb950)" },
  medium_confidence_routing: { label: "media confianza", color: "var(--color-accent)" },
  low_confidence_skip: { label: "baja (omitido)", color: "var(--color-text-faint)" },
  lazy_skill_injected: { label: "skill inyectada", color: "var(--color-success, #3fb950)" },
  semantic_fallback_empty: { label: "sin match semantico", color: "var(--color-text-faint)" },
  no_match: { label: "sin match", color: "var(--color-text-faint)" },
};

function routingMeta(msg: string | null): { label: string; color: string } {
  if (!msg) return { label: "—", color: "var(--color-text-tertiary)" };
  return ROUTING_MSG[msg] ?? { label: msg, color: "var(--color-text-tertiary)" };
}

function statusColor(status: string): string {
  const s = status.toLowerCase();
  if (s === "done" || s === "launched") return "var(--color-success, #3fb950)";
  if (s === "running" || s === "delegating") return "var(--color-accent)";
  if (s === "timeout" || s === "failed") return "var(--color-danger, #ef4444)";
  return "var(--color-text-tertiary)";
}

const KIND_TINT: Record<string, string> = {
  persona: "#a855f7",
  technical: "#3b82f6",
  meta: "#22c55e",
};

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p
      className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.07em]"
      style={{ color: "var(--color-text-tertiary)" }}
    >
      {children}
    </p>
  );
}

// ---------------------------------------------------------------------------
// LiveSessionMonitor
// ---------------------------------------------------------------------------

export default function LiveSessionMonitor() {
  const [feed, setFeed] = useState<LiveSessionFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [liveEvents, setLiveEvents] = useState<LiveEvent[]>([]);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const mountedRef = useRef(true);
  const seqRef = useRef(0);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const refresh = useCallback(async () => {
    try {
      const data = await invoke<LiveSessionFeed>("live_session_feed", { limit: 20 });
      if (!mountedRef.current) return;
      setFeed(data);
      setError(null);
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Polling del feed (pausable).
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (!pausedRef.current && !cancelled) await refresh();
    };
    void tick();
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [refresh]);

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

  const last = feed?.orchestrations[0] ?? null;
  // Solo mostramos decisiones de routing "interesantes" (mapeadas en ROUTING_MSG),
  // ocultando ruido de debug como v3_hook_complete / lazy_injection_attempted.
  const relevantRouting = (feed?.routing ?? []).filter(
    (r) => r.msg != null && Object.prototype.hasOwnProperty.call(ROUTING_MSG, r.msg),
  );

  return (
    <div
      className="flex flex-col gap-3 rounded-md p-3"
      style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{
              background: paused ? "var(--color-text-faint)" : "var(--color-success, #3fb950)",
              boxShadow: paused ? "none" : "0 0 6px var(--color-success, #3fb950)",
            }}
            aria-hidden
          />
          <span
            className="text-[11px] font-semibold uppercase tracking-[0.07em]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Sesion en vivo
          </span>
          {feed && (
            <span className="text-[9.5px]" style={{ color: "var(--color-text-faint)" }}>
              act. {fmtTime(feed.generated_at)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            className="rounded px-2 py-0.5 text-[10px] font-medium"
            style={{
              background: "transparent",
              color: "var(--color-text-tertiary)",
              border: "1px solid var(--color-border-strong)",
            }}
            title={paused ? "Reanudar actualizacion automatica" : "Pausar actualizacion automatica"}
          >
            {paused ? "Reanudar" : "Pausar"}
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            className="rounded px-2 py-0.5 text-[10px] font-medium"
            style={{
              background: "transparent",
              color: "var(--color-text-tertiary)",
              border: "1px solid var(--color-border-strong)",
            }}
            title="Refrescar ahora"
          >
            Refrescar
          </button>
        </div>
      </div>

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
              style={{ background: "var(--color-surface-1)", color: "var(--color-text-secondary)" }}
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
                        style={{ color: "var(--color-text-faint)", fontFamily: "var(--font-mono)" }}
                      >
                        {a.score.toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[10px]" style={{ color: "var(--color-text-faint)" }}>—</p>
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
                        style={{ color: "var(--color-text-faint)", fontFamily: "var(--font-mono)" }}
                      >
                        {s.score.toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[10px]" style={{ color: "var(--color-text-faint)" }}>—</p>
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
                    <span style={{ color: "var(--color-text-faint)" }}>[{m.scope}]</span> {m.summary}
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
                  <span className="shrink-0" style={{ color: statusColor(ev.status) }}>●</span>
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
            {feed?.delegations.map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="shrink-0" style={{ color: statusColor(d.status) }}>○</span>
                  <span
                    className="truncate text-[11px]"
                    style={{ color: "var(--color-text-secondary)", fontFamily: "var(--font-mono)" }}
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
      )}

      {/* Routing reciente (timeline de decisiones del dispatcher) */}
      {relevantRouting.length > 0 && (
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
                        style={{ color: "var(--color-text-tertiary)", fontFamily: "var(--font-mono)" }}
                      >
                        {r.top}
                      </span>
                    )}
                  </span>
                  {typeof r.confidence === "number" && (
                    <span
                      className="shrink-0 tabular-nums"
                      style={{ color: "var(--color-text-faint)", fontFamily: "var(--font-mono)" }}
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
    </div>
  );
}
