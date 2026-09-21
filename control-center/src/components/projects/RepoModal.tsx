// ULTRON Control Center — Micro GitHub Desktop (modal).
//
// Surface completo de Git para un proyecto, abierto sobre el panel "Repositorio"
// de ProjectWorkspace. A diferencia del resumen compacto (branch + Pull/Push),
// aquí se ven los cambios archivo por archivo, su diff, se hace stage/unstage,
// se escribe el mensaje y se commitea, y se consulta el historial.
//
// Backend: git_repo_snapshot / git_diff_file / git_stage / git_unstage /
// git_commit / git_log_full / git_pull / git_push / git_fetch (git_ops.rs).
// Read-write, pero solo sobre el repo del proyecto (path acotado).
//
// Rendimiento (2026-09-21): el panel hacía 4 llamadas a git por cada casilla
// marcada (state + changes + log + resumen del padre) y bloqueaba la lista
// entera mientras tanto. Ahora: un único `git_repo_snapshot` por refresco,
// historial perezoso, marcado optimista sin bloquear la lista y refrescos
// coalescidos.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

type RepoSnapshot = { state: RepoState; changes: GitFileChange[] };

type Tab = "changes" | "history";

interface RepoModalProps {
  path: string;
  onClose: () => void;
  /** Llamado tras commit/pull/push para que el padre refresque su resumen. */
  onChanged?: () => void;
}

/** Ventana de coalescencia: varias casillas seguidas = un solo refresco. */
const REFRESH_DEBOUNCE_MS = 120;

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
  const [log, setLog] = useState<GitCommit[] | null>(null);
  const [selected, setSelected] = useState<GitFileChange | null>(null);
  const [diff, setDiff] = useState<string>("");
  const [commitMsg, setCommitMsg] = useState("");
  const [busy, setBusy] = useState(false);
  /** Archivos con un stage/unstage en vuelo: solo se bloquea su casilla. */
  const [pending, setPending] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, []);

  /** Estado + archivos en UNA llamada (un solo `git status` en el backend). */
  const refresh = useCallback(async () => {
    try {
      const snap = await invoke<RepoSnapshot>("git_repo_snapshot", { path });
      if (!alive.current) return;
      setState(snap.state);
      setChanges(snap.changes);
      setError(null);
    } catch (e) {
      if (alive.current) setError(String(e));
    }
  }, [path]);

  /**
   * Refresco coalescido: N acciones seguidas = 1 solo `git status` aquí y un
   * solo aviso al padre (que dispara su propio `git_repo_state`).
   */
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      void refresh();
      onChanged?.();
    }, REFRESH_DEBOUNCE_MS);
  }, [refresh, onChanged]);

  const loadLog = useCallback(async () => {
    try {
      const l = await invoke<GitCommit[]>("git_log_full", { path, limit: 50 });
      if (alive.current) setLog(l);
    } catch (e) {
      if (alive.current) setError(String(e));
    }
  }, [path]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Historial perezoso: el `git log` solo se paga al abrir la pestaña. Antes se
  // lanzaba al abrir el modal y tras CADA stage/unstage.
  useEffect(() => {
    if (tab === "history" && log === null) void loadLog();
  }, [tab, log, loadLog]);

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
        if (!alive.current) return;
        setDiff(d.trim() ? d : "(sin diferencias que mostrar)");
      } catch (e) {
        if (alive.current) setDiff(`Error al leer el diff: ${String(e)}`);
      }
    },
    [path],
  );

  // Operación "pesada" (commit/pull/push/fetch/stage masivo): bloquea la barra,
  // refresca estado y avisa al padre. `okMsg` se muestra al terminar bien.
  const runOp = useCallback(
    async (fn: () => Promise<unknown>, okMsg?: string, alsoLog = false) => {
      setBusy(true);
      setError(null);
      setInfo(null);
      try {
        await fn();
        await refresh();
        // El historial solo se recarga si cambió (commit/pull) y está visible.
        if (alsoLog) {
          if (tab === "history") await loadLog();
          else setLog(null);
        }
        onChanged?.();
        if (okMsg && alive.current) setInfo(okMsg);
      } catch (e) {
        if (alive.current) setError(String(e));
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [refresh, loadLog, onChanged, tab],
  );

  // Marcado de UN archivo: pinta la casilla al instante (optimista), lanza el
  // git y deja que el refresco coalescido confirme. No bloquea la lista.
  const toggleFile = useCallback(
    async (c: GitFileChange) => {
      const next = !c.staged;
      setPending((p) => [...p, c.path]);
      setChanges((prev) =>
        prev.map((f) => (f.path === c.path ? { ...f, staged: next } : f)),
      );
      setError(null);
      try {
        await invoke(next ? "git_stage" : "git_unstage", { path, files: [c.path] });
        scheduleRefresh();
      } catch (e) {
        if (!alive.current) return;
        setError(String(e));
        // Revierte el optimismo: el estado real manda.
        setChanges((prev) =>
          prev.map((f) => (f.path === c.path ? { ...f, staged: c.staged } : f)),
        );
      } finally {
        if (alive.current) setPending((p) => p.filter((x) => x !== c.path));
      }
    },
    [path, scheduleRefresh],
  );

  const stagedCount = changes.filter((c) => c.staged).length;
  const hasRemote = !!state?.remote;

  // Un <div> por línea: memoizado para no rehacer el diff entero en cada
  // render del modal (marcar una casilla re-renderiza el componente).
  const diffLines = useMemo(
    () =>
      diff.split("\n").map((line, i) => (
        <div key={i} style={{ color: diffLineColor(line) ?? "var(--color-text-secondary)" }}>
          {line || " "}
        </div>
      )),
    [diff],
  );

  const doCommit = () =>
    runOp(
      async () => {
        await invoke("git_commit", { path, message: commitMsg });
        setCommitMsg("");
        setSelected(null);
        setDiff("");
      },
      "Commit creado",
      true,
    );

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
                onClick={() => void runOp(() => invoke("git_pull", { path }), "Pull OK", true)}
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
                    onClick={() => void runOp(() => invoke("git_stage", { path, files: [] }))}
                    disabled={busy || changes.length === 0}
                    className="rounded px-1.5 py-0.5 text-[10px] disabled:opacity-40"
                    style={{ border: "1px solid var(--color-border)", color: "var(--color-text-secondary)" }}
                    title="Stage de todos los cambios"
                  >
                    + Todos
                  </button>
                  <button
                    type="button"
                    onClick={() => void runOp(() => invoke("git_unstage", { path, files: [] }))}
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
                        key={c.path}
                        className="flex items-center gap-1.5 rounded px-1.5 py-1"
                        style={{ background: isSel ? "var(--color-surface-3)" : "transparent" }}
                      >
                        <input
                          type="checkbox"
                          checked={c.staged}
                          disabled={busy || pending.includes(c.path)}
                          onChange={() => void toggleFile(c)}
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
                  {diffLines}
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
            {log === null ? (
              <p className="text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
                Cargando historial…
              </p>
            ) : log.length === 0 ? (
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
