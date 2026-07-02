// ULTRON Control Center — sección "Ultimo turno" del panel LiveSessionMonitor.
// Muestra el prompt, intent/workflow, agentes sugeridos, skills aceptadas y
// memoria inyectada del último turno orquestado (o el aviso de "sin actividad").

import type { SessionOrchestration } from "../../sessions/sessionTypes";
import { KIND_TINT, SectionLabel, fmtTime } from "../../sessions/orchShared";

interface LastTurnPanelProps {
  last: SessionOrchestration | null;
  /** Si hubo error de fetch, no mostramos el aviso de "sin actividad" (ya se ve el error). */
  hasError: boolean;
}

export function LastTurnPanel({ last, hasError }: LastTurnPanelProps) {
  if (!last) {
    if (hasError) return null;
    return (
      <p className="text-[10.5px]" style={{ color: "var(--color-text-tertiary)" }}>
        Sin actividad de orquestacion todavia. Escribe en cualquier sesion de Claude Code y
        aparecera aqui (el hook UserPromptSubmit la registra).
      </p>
    );
  }

  return (
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
                <span style={{ color: "var(--color-text-faint)" }}>[{m.scope}]</span> {m.summary}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
