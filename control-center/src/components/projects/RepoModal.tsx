// ULTRON Control Center — Micro GitHub Desktop (modal).
//
// Surface completo de Git para un proyecto, abierto sobre el panel "Repositorio"
// de ProjectWorkspace. A diferencia del resumen compacto (branch + Pull/Push),
// aquí se ven los cambios archivo por archivo, su diff, se hace stage/unstage,
// se escribe el mensaje y se commitea, y se consulta el historial.
//
// Backend: git_changes / git_diff_file / git_stage / git_unstage / git_commit /
// git_log_full / git_pull / git_push / git_fetch / git_repo_state (git_ops.rs).
// Read-write, pero solo sobre el repo del proyecto (path acotado).

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type GitFileChange = {
  path: string;
  index_status: string;
  worktree_status: string;
  staged: boolean;
  untracked: boolean;
};

type GitCommit = {
  hash: string;
  short: string;
  author: string;
  date: string;
  subject: string;
};

type RepoState = {
  is_repo: boolean;
  branch: string | null;
  remote: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
  dirty_count: number;
};

type Tab = "changes" | "history";

interface RepoModalProps {
  path: string;
  onClose: () => void;
  /** Llamado tras commit/pull/push para que el padre refresque su resumen. */
  onChanged?: () => void;
}

/** Etiqueta corta y color para el estado de un archivo. */
function statusBadge(c: GitFileChange): { label: string; color: string } {
  if (c.untracked) return { label: "NUEVO", color: "#16a34a" };
  const code = c.staged ? c.index_status : c.worktree_status;
  switch (code) {
    case "M":
      return { label: "MOD", color: "#ca8a04" };
    case "A":
      return { label: "ADD", color: "#16a34a" };
    case "D":
      return { label: "DEL", color: "#ef4444" };
    case "R":
      return { label: "REN", color: "#3b82f6" };
    default:
      return { label: code.trim() || "·", color: "var(--color-text-tertiary)" };
  }
}

/** Colorea una línea de diff unificado. */
function diffLineColor(line: string): string | undefined {
  if (line.startsWith("+++") || line.startsWith("---")) return "var(--color-text-tertiary)";
  if (line.startsWith("@@")) return "#3b82f6";
  if (line.startsWith("+")) return "#22c55e";
  if (line.startsWith("-")) return "#ef4444";
  return undefined;
}

export function RepoModal({ path, onClose, onChanged }: RepoModalProps) {
  const [tab, setTab] = useState<Tab>("changes");
  const [state, setState] = useState<RepoState | null>(null);
  const [changes, setChanges] = useState<GitFileChange[]>([]);
  const [log, setLog] = useState<GitCommit[]>([]);
  const [selected, setSelected] = useState<GitFileChange | null>(null);
  const [diff, setDiff] = useState<string>("");
  const [commitMsg, setCommitMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [st, ch] = await Promise.all([
        invoke<RepoState>("git_repo_state", { path }),
        invoke<GitFileChange[]>("git_changes", { path }),
      ]);
      setState(st);
      setChanges(ch);
    } catch (e) {
      setError(String(e));
    }
  }, [path]);

  const loadLog = useCallback(async () => {
    try {
      setLog(await invoke<GitCommit[]>("git_log_full", { path, limit: 50 }));
    } catch (e) {
      setError(String(e));
    }
  }, [path]);

  useEffect(() => {
    void refresh();
    void loadLog();
  }, [refresh, loadLog]);

  const openDiff = useCallback(
    async (c: GitFileChange) => {
      setSelected(c);
      setDiff("Cargando diff…");
      try {
        const d = await invoke<string>("git_diff_file", {
          path,
          file: c.path,
          staged: c.staged,
        });
        setDiff(d.trim() ? d : "(sin diferencias que mostrar)");
      } catch (e) {
        setDiff(`Error al leer el diff: ${String(e)}`);
      }
    },
    [path],
  );

  // Run a git op, then refresh local + parent. `okMsg` shown briefly on success.
  const runOp = useCallback(
    async (fn: () => Promise<unknown>, okMsg?: string) => {
      setBusy(true);
      setError(null);
      setInfo(null);
      try {
        await fn();
        await refresh();
        await loadLog();
        onChanged?.();
        if (okMsg) setInfo(okMsg);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [refresh, loadLog, onChanged],
  );

  const stage = (files: string[]) => invoke("git_stage", { path, files });
  const unstage = (files: string[]) => invoke("git_unstage", { path, files });

  const stagedCount = changes.filter((c) => c.staged).length;
  const hasRemote = !!state?.remote;

  const doCommit = () =>
    runOp(async () => {
      await invoke("git_commit", { path, message: commitMsg });
      setCommitMsg("");
      setSelected(null);
      setDiff("");
    }, "Commit creado");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.55)" }}
      onClick={onClose}
    >
      <div
        className="flex h-[82vh] w-[min(1100px,94vw)] flex-col rounded-lg"
        style={{ background: "var(--color-surface-1)", border: "1px solid var(--color-border-strong)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header: branch + ahead/behind + remote ops */}
        <div
          className="flex items-center justify-between gap-3 px-4 py-2.5"
          style={{ borderBottom: "1px solid var(--color-border)" }}
        >
          <div className="flex items-center gap-2 text-[12px]">
            <span className="font-semibold" style={{ color: "var(--color-text)" }}>
              Repositorio
            </span>
            <span style={{ color: "var(--color-text-secondary)", fontFamily: "var(--font-mono)" }}>
              {state?.branch ?? "—"}
            </span>
            {state && (state.ahead > 0 || state.behind > 0) && (
              <span className="text-[10.5px]" style={{ color: "var(--color-text-tertiary)" }}>
                {state.behind > 0 && `↓${state.behind} `}
                {state.ahead > 0 && `↑${state.ahead}`}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void runOp(() => invoke("git_fetch", { path }), "Fetch OK")}
              disabled={busy}
              className="rounded px-2 py-1 text-[11px] disabled:opacity-40"
              style={{ border: "1px solid var(--color-border)", color: "var(--color-text-secondary)" }}
            >
              Fetch
            </button>
            {hasRemote && (
              <button
                type="button"
                onClick={() => void runOp(() => invoke("git_pull", { path }), "Pull OK")}
                disabled={busy}
                className="rounded px-2 py-1 text-[11px] disabled:opacity-40"
                style={{ background: "rgba(59,130,246,0.12)", border: "1px solid rgba(59,130,246,0.35)", color: "#3b82f6" }}
              >
                Pull {state && state.behind > 0 ? `(${state.behind})` : ""}
              </button>
            )}
            {hasRemote && (
              <button
                type="button"
                onClick={() => void runOp(() => invoke("git_push", { path }), "Push OK")}
                disabled={busy}
                className="rounded px-2 py-1 text-[11px] disabled:opacity-40"
                style={{ background: "rgba(168,85,247,0.12)", border: "1px solid rgba(168,85,247,0.35)", color: "#a855f7" }}
              >
                Push {state && state.ahead > 0 ? `(${state.ahead})` : ""}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="ml-1 rounded px-2 py-1 text-[11px]"
              style={{ border: "1px solid var(--color-border)", color: "var(--color-text-secondary)" }}
            >
              Cerrar
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 px-4 pt-2" style={{ borderBottom: "1px solid var(--color-border)" }}>
          {(["changes", "history"] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className="rounded-t px-3 py-1.5 text-[12px]"
              style={{
                color: tab === t ? "var(--color-text)" : "var(--color-text-secondary)",
                borderBottom: tab === t ? "2px solid var(--color-accent, #5b6af0)" : "2px solid transparent",
                fontWeight: tab === t ? 600 : 400,
              }}
            >
              {t === "changes" ? `Cambios (${changes.length})` : "Historial"}
            </button>
          ))}
        </div>

        {(error || info) && (
          <div
            className="px-4 py-1.5 text-[11px]"
            style={{ color: error ? "var(--color-danger, #ef4444)" : "var(--color-success, #22c55e)" }}
          >
            {error ?? info}
          </div>
        )}

        {/* Body */}
        {tab === "changes" ? (
          <div className="flex min-h-0 flex-1">
            {/* Left: file list + commit box */}
            <div
              className="flex w-[42%] flex-col"
              style={{ borderRight: "1px solid var(--color-border)" }}
            >
              <div className="flex items-center justify-between px-3 py-1.5">
                <span className="text-[10.5px] uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
                  {changes.length} archivo{changes.length !== 1 ? "s" : ""} · {stagedCount} staged
                </span>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => void runOp(() => stage([]))}
                    disabled={busy || changes.length === 0}
                    className="rounded px-1.5 py-0.5 text-[10px] disabled:opacity-40"
                    style={{ border: "1px solid var(--color-border)", color: "var(--color-text-secondary)" }}
                    title="Stage de todos los cambios"
                  >
                    + Todos
                  </button>
                  <button
                    type="button"
                    onClick={() => void runOp(() => unstage([]))}
                    disabled={busy || stagedCount === 0}
                    className="rounded px-1.5 py-0.5 text-[10px] disabled:opacity-40"
                    style={{ border: "1px solid var(--color-border)", color: "var(--color-text-secondary)" }}
                    title="Quitar todos del stage"
                  >
                    − Todos
                  </button>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-auto px-1.5">
                {changes.length === 0 ? (
                  <p className="px-2 py-4 text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
                    Sin cambios. El árbol de trabajo está limpio.
                  </p>
                ) : (
                  changes.map((c) => {
                    const b = statusBadge(c);
                    const isSel = selected?.path === c.path;
                    return (
                      <div
                        key={`${c.path}-${c.staged}`}
                        className="flex items-center gap-1.5 rounded px-1.5 py-1"
                        style={{ background: isSel ? "var(--color-surface-3)" : "transparent" }}
                      >
                        <input
                          type="checkbox"
                          checked={c.staged}
                          disabled={busy}
                          onChange={() =>
                            void runOp(() => (c.staged ? unstage([c.path]) : stage([c.path])))
                          }
                          title={c.staged ? "Quitar del stage" : "Añadir al stage"}
                        />
                        <button
                          type="button"
                          onClick={() => void openDiff(c)}
                          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                        >
                          <span
                            className="shrink-0 rounded px-1 text-[8.5px] font-bold"
                            style={{ color: b.color, border: `1px solid ${b.color}40` }}
                          >
                            {b.label}
                          </span>
                          <span
                            className="truncate text-[11px]"
                            style={{ color: "var(--color-text)", fontFamily: "var(--font-mono)" }}
                            title={c.path}
                          >
                            {c.path}
                          </span>
                        </button>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Commit box */}
              <div className="flex flex-col gap-1.5 px-3 py-2" style={{ borderTop: "1px solid var(--color-border)" }}>
                <textarea
                  value={commitMsg}
                  onChange={(e) => setCommitMsg(e.target.value)}
                  placeholder="Mensaje del commit…"
                  rows={2}
                  className="w-full resize-none rounded px-2 py-1.5 text-[11.5px] outline-none"
                  style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border-strong)", color: "var(--color-text)" }}
                />
                <button
                  type="button"
                  onClick={() => void doCommit()}
                  disabled={busy || stagedCount === 0 || !commitMsg.trim()}
                  className="rounded px-3 py-1.5 text-[11.5px] font-medium disabled:opacity-40"
                  style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
                  title={stagedCount === 0 ? "Marca archivos para incluir en el commit" : "git commit"}
                >
                  Commit {stagedCount > 0 ? `(${stagedCount})` : ""}
                </button>
              </div>
            </div>

            {/* Right: diff viewer */}
            <div className="min-h-0 flex-1 overflow-auto">
              {selected ? (
                <pre className="m-0 p-3 text-[11px] leading-[1.45]" style={{ fontFamily: "var(--font-mono)", whiteSpace: "pre" }}>
                  {diff.split("\n").map((line, i) => (
                    <div key={i} style={{ color: diffLineColor(line) ?? "var(--color-text-secondary)" }}>
                      {line || " "}
                    </div>
                  ))}
                </pre>
              ) : (
                <p className="p-4 text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
                  Selecciona un archivo para ver su diff.
                </p>
              )}
            </div>
          </div>
        ) : (
          /* History tab */
          <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
            {log.length === 0 ? (
              <p className="text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
                Sin commits.
              </p>
            ) : (
              log.map((c) => (
                <div
                  key={c.hash}
                  className="flex items-baseline gap-2 rounded px-2 py-1.5"
                  style={{ borderBottom: "1px solid var(--color-border)" }}
                >
                  <span className="shrink-0 text-[10.5px]" style={{ color: "#a855f7", fontFamily: "var(--font-mono)" }}>
                    {c.short}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12px]" style={{ color: "var(--color-text)" }} title={c.subject}>
                    {c.subject}
                  </span>
                  <span className="shrink-0 text-[10px]" style={{ color: "var(--color-text-tertiary)" }}>
                    {c.author} · {c.date}
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default RepoModal;
