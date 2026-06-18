import { Loader, Plus, Share2, Sliders } from "../projects/icons";
import { PROVIDERS } from "./constants";
import { deriveWorkspaceName, formatRel } from "./utils";
import type { WorkspaceCardProps } from "./types";

export function WorkspaceCard({
  ws,
  busy,
  onNew,
  onCustom,
  onSendContext,
  onCreateProject,
  creatingProject,
}: WorkspaceCardProps) {
  const headline = ws.project_name ?? deriveWorkspaceName(ws.cwd);
  const canSendContext = !!ws.latest_session_id;
  // Botón "+" de crear-proyecto en la esquina, SOLO cuando este workspace no
  // corresponde aún a un proyecto registrado (ws.project_id vacío).
  const canCreateProject = !ws.project_id;

  return (
    <div
      className="flex h-full flex-col rounded-lg p-4 transition-colors"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      {/* Header row */}
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h3
              className="truncate text-[15px] font-semibold leading-tight"
              style={{ color: "var(--color-text)" }}
              title={headline}
            >
              {headline}
            </h3>
          </div>
          {/* Badges */}
          <div className="flex shrink-0 items-center gap-1">
            <span
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-text-tertiary)",
                border: "1px solid var(--color-border)",
              }}
            >
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: PROVIDERS.claude.accent }}
              />
              claude
            </span>
            {ws.project_id ? (
              <span
                className="rounded px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-tertiary)",
                  border: "1px solid var(--color-border)",
                }}
                title={ws.project_name ?? ws.project_id}
              >
                {ws.project_name ?? "project"}
              </span>
            ) : (
              // Esquina: crear proyecto desde esta sesión (solo si no existe ya).
              <button
                type="button"
                onClick={() => onCreateProject(ws)}
                disabled={creatingProject || !canCreateProject}
                className="inline-flex h-6 w-6 items-center justify-center rounded transition-colors disabled:opacity-40"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-tertiary)",
                  border: "1px solid var(--color-border-strong)",
                }}
                title="Crear un proyecto a partir de esta sesión"
                aria-label="Crear proyecto desde esta sesión"
              >
                {creatingProject ? <Loader size={11} /> : <Plus size={12} />}
              </button>
            )}
          </div>
        </div>

        {/* cwd monospace line */}
        <div
          className="mt-1 truncate text-[11px]"
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--color-text-faint)",
          }}
          title={ws.cwd}
        >
          {ws.cwd}
        </div>

        {/* Meta row */}
        <div
          className="mt-2 flex items-center gap-3 text-[10.5px] tabular-nums"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          <span>{formatRel(ws.last_activity)}</span>
          <span>·</span>
          <span>
            {ws.session_count} session{ws.session_count === 1 ? "" : "s"}
          </span>
        </div>
      </div>

      {/* Action row — exactly 3 fixed buttons */}
      <div className="mt-3 flex items-center gap-1.5">
        {/* New */}
        <button
          type="button"
          onClick={() => onNew(ws)}
          disabled={busy}
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded px-2.5 py-1.5 text-[12px] font-semibold transition-colors disabled:opacity-40"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
          title={`New Claude session in ${ws.cwd}`}
        >
          <Plus size={12} />
          New
        </button>

        {/* Custom */}
        <button
          type="button"
          onClick={() => onCustom(ws)}
          disabled={busy}
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded px-2.5 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
          }}
          title="Custom launch — choose provider and model"
        >
          <Sliders size={11} />
          Custom
        </button>

        {/* Send Context */}
        <button
          type="button"
          onClick={() => onSendContext(ws)}
          disabled={busy || !canSendContext}
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded px-2.5 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40 whitespace-nowrap"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
          }}
          title={
            canSendContext
              ? "Start a new session seeded with context from the latest session"
              : "No prior session to send context from"
          }
        >
          <Share2 size={11} />
          Send ctx
        </button>
      </div>
    </div>
  );
}
