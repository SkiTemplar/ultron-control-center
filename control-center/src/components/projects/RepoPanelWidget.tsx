// projects/RepoPanelWidget.tsx
// Git repository mini-panel (micro GitHub Desktop) for ProjectWorkspace.
// Extracted from ProjectWorkspace.tsx (cat7.3 split).

type GitRepoState = {
  is_repo: boolean;
  branch: string | null;
  remote: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
  dirty_count: number;
};

export type GitStatus = {
  state: GitRepoState | null;
  busy: boolean;
  error: string | null;
};

interface Props {
  git: GitStatus;
  meta: { id: string; name: string; path: string } | null;
  onRunGitOp: (op: "git_pull" | "git_push" | "git_init" | "git_fetch") => void;
  onOpenRepoModal: () => void;
}

export function RepoPanelWidget({ git, meta, onRunGitOp, onOpenRepoModal }: Props) {
  return (
    <div
      className="flex flex-col gap-2 rounded-md p-3"
      style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
    >
      {/* Header row */}
      <div className="flex items-center justify-between">
        <span
          className="text-[10px] font-semibold uppercase tracking-[0.07em]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Repositorio
        </span>
        {git.state?.is_repo && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onOpenRepoModal}
              className="rounded px-1.5 py-0.5 text-[9.5px] font-medium"
              style={{ background: "var(--color-surface-3)", border: "1px solid var(--color-border-strong)", color: "var(--color-text-secondary)" }}
              title="Ver cambios, hacer commit y consultar el historial (micro GitHub Desktop)"
            >
              Cambios{git.state.dirty_count > 0 ? ` (${git.state.dirty_count})` : ""}
            </button>
            <button
              type="button"
              onClick={() => onRunGitOp("git_fetch")}
              disabled={!meta || git.busy}
              className="rounded px-1.5 py-0.5 text-[9.5px] disabled:opacity-40"
              style={{ background: "transparent", border: "1px solid var(--color-border)", color: "var(--color-text-tertiary)" }}
              title="git fetch (actualizar estado remoto)"
            >
              Fetch
            </button>
          </div>
        )}
      </div>

      {/* No repo */}
      {!git.state?.is_repo && !git.error && (
        <div className="flex items-center justify-between">
          <span className="text-[10.5px]" style={{ color: "var(--color-text-tertiary)" }}>
            {meta ? "Sin repositorio git" : "Cargando…"}
          </span>
          {meta && (
            <button
              type="button"
              onClick={() => onRunGitOp("git_init")}
              disabled={git.busy}
              className="rounded px-2 py-0.5 text-[10.5px] font-medium disabled:opacity-40"
              style={{ background: "var(--color-surface-3)", border: "1px solid var(--color-border-strong)", color: "var(--color-text-secondary)" }}
              title="git init en este directorio"
            >
              Crear repo
            </button>
          )}
        </div>
      )}

      {/* Repo state */}
      {git.state?.is_repo && (() => {
        const s = git.state!;
        const hasRemote = !!s.remote;
        const canPull = s.behind > 0;
        const canPush = s.ahead > 0;
        const canPublish = !hasRemote;
        return (
          <div className="flex flex-col gap-1.5">
            {/* Branch + dirty badge */}
            <div className="flex items-center gap-1.5">
              <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden
                style={{ color: "var(--color-text-tertiary)", flexShrink: 0 }}>
                <path d="M5.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm-1.5.75a2.25 2.25 0 1 1 2.894 2.165v.585a2.25 2.25 0 0 1-2.25 2.25h-2a.75.75 0 0 1 0-1.5h2a.75.75 0 0 0 .75-.75v-.585A2.25 2.25 0 0 1 4.25 3.25zm7.5 1.25a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zM10 5.414V7.75a.75.75 0 0 1-.75.75H7.5a.75.75 0 0 0 0 1.5h1.75v2.086a2.25 2.25 0 1 0 1.5 0V9.25a.75.75 0 0 0-.75-.75H8.5V7.75A2.25 2.25 0 0 0 6.25 5.5H4.5a.75.75 0 0 0 0 1.5h1.75a.75.75 0 0 1 .75.75v.414A2.25 2.25 0 0 0 10 5.414zm1.5 7.586a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0z"/>
              </svg>
              <span className="text-[10.5px] font-medium" style={{ color: "var(--color-text)", fontFamily: "var(--font-mono)" }}>
                {s.branch ?? "desconocida"}
              </span>
              {s.dirty && (
                <span
                  className="rounded px-1 text-[9px] font-semibold"
                  style={{ background: "rgba(234,179,8,0.15)", color: "#ca8a04", border: "1px solid rgba(234,179,8,0.3)" }}
                  title={`${s.dirty_count} archivo(s) modificado(s)`}
                >
                  {s.dirty_count} cambio{s.dirty_count !== 1 ? "s" : ""}
                </span>
              )}
              {!s.dirty && s.is_repo && (
                <span className="text-[9px]" style={{ color: "var(--color-text-tertiary)" }}>limpio</span>
              )}
            </div>

            {/* Ahead / Behind indicators */}
            {hasRemote && (
              <div className="flex items-center gap-2">
                {canPull && (
                  <span className="flex items-center gap-0.5 text-[9.5px]" style={{ color: "#3b82f6" }} title="Commits remotos sin descargar">
                    <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" aria-hidden><path d="M8 2a.75.75 0 0 1 .75.75v8.69l2.97-2.97a.749.749 0 1 1 1.06 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 9.53a.749.749 0 1 1 1.06-1.06l2.97 2.97V2.75A.75.75 0 0 1 8 2Z"/></svg>
                    {s.behind} por descargar
                  </span>
                )}
                {canPush && (
                  <span className="flex items-center gap-0.5 text-[9.5px]" style={{ color: "#a855f7" }} title="Commits locales sin subir">
                    <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" aria-hidden><path d="M8 14a.75.75 0 0 1-.75-.75V4.56L4.28 7.53a.749.749 0 1 1-1.06-1.06l4.25-4.25a.749.749 0 0 1 1.06 0l4.25 4.25a.749.749 0 1 1-1.06 1.06L8.75 4.56v8.69A.75.75 0 0 1 8 14Z"/></svg>
                    {s.ahead} por subir
                  </span>
                )}
                {!canPull && !canPush && (
                  <span className="text-[9.5px]" style={{ color: "var(--color-text-tertiary)" }}>sincronizado con {s.remote}</span>
                )}
              </div>
            )}

            {/* Action buttons — siempre visibles (estilo GitHub Desktop):
                Pull/Push aparecen siempre que haya remote, no solo cuando hay
                commits pendientes; el badge (n) muestra ahead/behind si los hay. */}
            <div className="flex items-center gap-1.5 pt-0.5">
              {canPublish && (
                <button type="button" disabled className="rounded px-2 py-0.5 text-[10px] font-medium opacity-50"
                  style={{ background: "var(--color-surface-3)", border: "1px solid var(--color-border-strong)", color: "var(--color-text-secondary)" }}
                  title="Configura un remote (git remote add origin …) para publicar">
                  Publicar…
                </button>
              )}
              {hasRemote && (
                <button type="button" onClick={() => onRunGitOp("git_pull")} disabled={git.busy}
                  className="rounded px-2 py-0.5 text-[10px] font-medium disabled:opacity-40"
                  style={{ background: "rgba(59,130,246,0.12)", border: "1px solid rgba(59,130,246,0.35)", color: "#3b82f6" }}
                  title="git pull --ff-only">
                  Pull {s.behind > 0 && <span className="ml-0.5 opacity-80">({s.behind})</span>}
                </button>
              )}
              {hasRemote && (
                <button type="button" onClick={() => onRunGitOp("git_push")} disabled={git.busy}
                  className="rounded px-2 py-0.5 text-[10px] font-medium disabled:opacity-40"
                  style={{ background: "rgba(168,85,247,0.12)", border: "1px solid rgba(168,85,247,0.35)", color: "#a855f7" }}
                  title="git push">
                  Push {s.ahead > 0 && <span className="ml-0.5 opacity-80">({s.ahead})</span>}
                </button>
              )}
            </div>
          </div>
        );
      })()}

      {/* Error + busy */}
      {git.error && (
        <p className="text-[10px]" style={{ color: "var(--color-danger, #ef4444)" }}>{git.error}</p>
      )}
      {git.busy && (
        <p className="text-[10px]" style={{ color: "var(--color-text-tertiary)" }}>Ejecutando…</p>
      )}
    </div>
  );
}
