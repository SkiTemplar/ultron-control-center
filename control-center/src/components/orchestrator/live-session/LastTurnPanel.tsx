// ULTRON Control Center — sección "Ultimo turno" del panel LiveSessionMonitor.
// Muestra el prompt, intent/workflow, agentes sugeridos, skills aceptadas y
// memoria inyectada del último turno orquestado en modo full, con su fecha.
// En modo ligero (el de producción) el hook no registra turnos: el panel lo
// dice y, si queda un turno full antiguo, lo presenta como histórico.

import type { OrchestrateMode, SessionOrchestration } from "../../sessions/sessionTypes";
import { KIND_TINT, SectionLabel, daysSince, fmtWhen } from "../../sessions/orchShared";

interface LastTurnPanelProps {
  last: SessionOrchestration | null;
  /** Si hubo error de fetch, no mostramos el aviso de "sin actividad" (ya se ve el error). */
  hasError: boolean;
  /** Modo del hook memory-orchestrate. */
  mode: OrchestrateMode;
}

export const LIGHT_MODE_NOTICE =
  "Modo ligero (el de producción): el hook UserPromptSubmit solo inyecta el tono; no hay recall, " +
  "delegación ni skills por prompt, y no registra turnos aquí. Con ULTRON_ORCHESTRATE=full se registrarían.";

/** Cabecera del último turno: deja claro si es histórico. */
export function lastTurnHeading(mode: OrchestrateMode, ts: string | null, now: Date = new Date()): string {
  if (mode === "full") return "Último turno";
  const days = daysSince(ts, now);
  const age = days > 0 ? `, hace ${days} día${days === 1 ? "" : "s"}` : "";
  return `Último turno registrado en modo full (${fmtWhen(ts, now)}${age})`;
}

function ModeNotice() {
  return (
    <p className="text-[10.5px]" style={{ color: "var(--color-text-tertiary)" }}>
      {LIGHT_MODE_NOTICE}
    </p>
  );
}

export function LastTurnPanel({ last, hasError, mode }: LastTurnPanelProps) {
  const isLight = mode === "light";
  if (!last) {
    if (hasError) return null;
    if (isLight) return <ModeNotice />;
    return (
      <p className="text-[10.5px]" style={{ color: "var(--color-text-tertiary)" }}>
        Sin actividad de orquestación todavía. Escribe en cualquier sesión de Claude Code y
        aparecerá aquí (en modo full el hook UserPromptSubmit la registra).
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {isLight && <ModeNotice />}
      <SectionLabel>{lastTurnHeading(mode, last.ts)}</SectionLabel>
      {last.prompt && (
        <div
          className="rounded px-2 py-1 text-[11px]"
          style={{
            background: "var(--color-surface-1)",
            color: isLight ? "var(--color-text-tertiary)" : "var(--color-text-secondary)",
          }}
          title={last.prompt}
        >
          <span style={{ color: "var(--color-text-faint)" }}>{fmtWhen(last.ts)} </span>
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
            title="Intención detectada"
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
            entre proyectos
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
                <div key={a.name} className="flex min-w-0 items-center gap-2">
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
                <div key={s.name} className="flex min-w-0 items-center gap-2">
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
                <span style={{ color: "var(--color-text-faint)" }}>[{m.scope}]</span> {m.summary}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
