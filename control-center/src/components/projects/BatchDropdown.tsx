// ULTRON Control Center - BatchDropdown
//
// Boton "Run batch" para el header del tab Projects. Lista los .bat / .cmd /
// .ps1 que la AI (o el usuario) deja en `~/.ultron/batches/` cuando hay un
// comando que el sandbox no puede ejecutar (instalaciones interactivas,
// elevacion, etc.). Un click en un item invoca `execute_batch` en el backend
// y muestra el stdout/stderr resultante como toast inline.
//
// Backend: src-tauri/src/commands/batches.rs
//   list_batches()              -> Vec<BatchEntry>
//   execute_batch(name)         -> BatchRunResult
//   clear_all_batches()         -> BatchCleanupReport
//   batches_enqueue_manual(...) -> BatchQueueEntry   (para la IA)

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Domain types (mirrors Rust structs)
// ---------------------------------------------------------------------------

type BatchEntry = {
  name: string;
  path: string;
  size_bytes: number;
  modified_epoch: number;
};

type BatchRunResult = {
  success: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
};

type BatchQueueReason = "rejected" | "ai_cannot_execute" | "failed";

/** "auto" = runnable with one click; "manual" = human out-of-band action. */
type BatchKind = "auto" | "manual";

type BatchQueueEntry = {
  id: string;
  name: string;
  path: string;
  reason: BatchQueueReason;
  kind: BatchKind;
  description: string | null;
  created_at: string;
  last_error: string | null;
  attempts: number;
};

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

const REASON_LABEL: Record<BatchQueueReason, string> = {
  rejected: "rechazado",
  ai_cannot_execute: "IA no pudo ejecutar",
  failed: "fallo",
};

const REASON_COLOR: Record<BatchQueueReason, string> = {
  rejected: "var(--color-danger)",
  ai_cannot_execute: "var(--color-warning, #d29922)",
  failed: "var(--color-warning, #d29922)",
};

export type BatchToast = {
  kind: "ok" | "err";
  title: string;
  body: string;
};

type BatchDropdownProps = {
  onResult?: (toast: BatchToast) => void;
  headerStyle?: boolean;
  cardStyle?: boolean;
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatAge(epoch: number): string {
  if (!epoch) return "-";
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, now - epoch);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function clip(s: string, max = 320): string {
  const trimmed = s.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}... (+${trimmed.length - max} chars)`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function BatchDropdown({
  onResult,
  headerStyle = false,
  cardStyle = false,
}: BatchDropdownProps) {
  const [open, setOpen] = useState(false);
  const [batches, setBatches] = useState<BatchEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runningName, setRunningName] = useState<string | null>(null);

  // Single-item delete confirmation (inline bar replaces the row).
  const [pendingDeleteName, setPendingDeleteName] = useState<string | null>(null);

  // Two-phase confirmation for "Clear all".
  const [confirmingClearAll, setConfirmingClearAll] = useState(false);

  // Persistent queue (rejected / unrunnable / failed / manual).
  const [queue, setQueue] = useState<BatchQueueEntry[] | null>(null);
  const [queueBusyId, setQueueBusyId] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement | null>(null);

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  const refreshQueue = useCallback(async () => {
    try {
      const q = await invoke<BatchQueueEntry[]>("batches_list_queue");
      setQueue(q);
      // If the busy entry disappeared from the backend, release the lock so
      // buttons are no longer disabled forever.
      setQueueBusyId((prev) => (prev !== null && !q.some((e) => e.id === prev) ? null : prev));
    } catch {
      setQueue((prev) => prev ?? []);
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await invoke<BatchEntry[]>("list_batches");
      setBatches(r);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBatches([]);
    } finally {
      setLoading(false);
    }
    void refreshQueue();
  }, [refreshQueue]);

  useEffect(() => {
    if (open && batches === null) void refresh();
  }, [open, batches, refresh]);

  // ---------------------------------------------------------------------------
  // Click-outside / ESC to close
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as Node)) return;
      if (confirmingClearAll || pendingDeleteName !== null) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (confirmingClearAll) { setConfirmingClearAll(false); return; }
        if (pendingDeleteName !== null) { setPendingDeleteName(null); return; }
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, confirmingClearAll, pendingDeleteName]);

  // ---------------------------------------------------------------------------
  // Queue operations
  // ---------------------------------------------------------------------------

  const requeue = useCallback(
    async (entry: BatchQueueEntry) => {
      setQueueBusyId(entry.id);
      try {
        const updated = await invoke<BatchQueueEntry>("batches_requeue", { id: entry.id });
        setQueue((prev) =>
          prev === null ? prev : prev.map((e) => (e.id === updated.id ? updated : e)),
        );
        onResult?.({
          kind: "ok",
          title: `Reencolado: ${entry.name}`,
          body: "Marcado como pendiente de reintento. Pulsa Run para ejecutarlo.",
        });
        void refreshQueue();
      } catch (e: unknown) {
        onResult?.({
          kind: "err",
          title: `Reencolar fallo: ${entry.name}`,
          body: e instanceof Error ? e.message : String(e),
        });
      } finally {
        setQueueBusyId(null);
      }
    },
    [onResult, refreshQueue],
  );

  const dismissQueue = useCallback(
    async (entry: BatchQueueEntry) => {
      setQueueBusyId(entry.id);
      try {
        await invoke<void>("batches_dismiss_queue", { id: entry.id });
        void refreshQueue();
      } catch (e: unknown) {
        onResult?.({
          kind: "err",
          title: `Descartar fallo: ${entry.name}`,
          body: e instanceof Error ? e.message : String(e),
        });
      } finally {
        setQueueBusyId(null);
      }
    },
    [onResult, refreshQueue],
  );

  // ---------------------------------------------------------------------------
  // Run / delete individual batch files
  // ---------------------------------------------------------------------------

  const run = useCallback(
    async (name: string) => {
      setRunningName(name);
      try {
        const r = await invoke<BatchRunResult>("execute_batch", { name });
        const body = clip(r.stdout) || clip(r.stderr) || `exit ${r.exit_code ?? "?"}`;
        onResult?.({
          kind: r.success ? "ok" : "err",
          title: r.success
            ? `Batch finished: ${name}`
            : `Batch failed: ${name} (exit ${r.exit_code ?? "?"})`,
          body,
        });
        void refresh();
      } catch (e: unknown) {
        onResult?.({
          kind: "err",
          title: `Batch error: ${name}`,
          body: e instanceof Error ? e.message : String(e),
        });
      } finally {
        setRunningName(null);
        setOpen(false);
      }
    },
    [onResult, refresh],
  );

  const runFromQueue = useCallback(
    async (entry: BatchQueueEntry) => {
      setRunningName(entry.name);
      setQueueBusyId(entry.id);
      try {
        const r = await invoke<BatchRunResult>("execute_batch", { name: entry.name });
        const body = clip(r.stdout) || clip(r.stderr) || `exit ${r.exit_code ?? "?"}`;
        onResult?.({
          kind: r.success ? "ok" : "err",
          title: r.success
            ? `Batch finished: ${entry.name}`
            : `Batch failed: ${entry.name} (exit ${r.exit_code ?? "?"})`,
          body,
        });
        if (r.success) {
          try {
            await invoke<void>("batches_dismiss_queue", { id: entry.id });
          } catch {
            /* dismiss is best-effort */
          }
          void refreshQueue();
        }
        void refresh();
      } catch (e: unknown) {
        onResult?.({
          kind: "err",
          title: `Batch error: ${entry.name}`,
          body: e instanceof Error ? e.message : String(e),
        });
        void refresh();
      } finally {
        setRunningName(null);
        setQueueBusyId(null);
      }
    },
    [onResult, refresh, refreshQueue],
  );

  const deleteSingle = useCallback(
    async (name: string) => {
      setPendingDeleteName(null);
      try {
        await invoke<void>("delete_batch_single", { name });
        onResult?.({
          kind: "ok",
          title: `Deleted: ${name}`,
          body: "Batch script removed from ~/.ultron/batches/",
        });
        await refresh();
      } catch (e: unknown) {
        onResult?.({
          kind: "err",
          title: `Delete failed: ${name}`,
          body: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [onResult, refresh],
  );

  // ---------------------------------------------------------------------------
  // Clear All
  // ---------------------------------------------------------------------------

  const clearAll = useCallback(async () => {
    setConfirmingClearAll(false);
    setPendingDeleteName(null);
    setLoading(true);
    // Optimistic reset of both lists so the UI empties immediately.
    setBatches([]);
    setQueue([]);
    try {
      const r = await invoke<{ deleted: string[]; kept: number }>("clear_all_batches");
      onResult?.({
        kind: "ok",
        title: `${r.deleted.length} batches eliminados`,
        body:
          r.deleted.length === 0
            ? "No habia batches que borrar."
            : `Eliminados ${r.deleted.length} script${r.deleted.length === 1 ? "" : "s"} y vaciada la cola.`,
      });
    } catch (err: unknown) {
      onResult?.({
        kind: "err",
        title: "Clear all failed",
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
      // Re-fetch both lists to confirm backend state regardless of outcome.
      await refresh();
      await refreshQueue();
    }
  }, [onResult, refresh, refreshQueue]);

  // ---------------------------------------------------------------------------
  // Derived counts
  // ---------------------------------------------------------------------------

  const count = batches?.length ?? 0;
  const queueCount = queue?.length ?? 0;

  // ---------------------------------------------------------------------------
  // Trigger button styles
  // ---------------------------------------------------------------------------

  const triggerClassName = headerStyle
    ? "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-40"
    : "flex items-center gap-1.5 rounded px-3 py-1.5 text-[12px] transition-colors disabled:opacity-50";

  const triggerStyle = headerStyle
    ? ({
        borderColor: "rgba(255,255,255,0.10)",
        background: "transparent",
        color: "var(--color-text-muted)",
      } as CSSProperties)
    : ({
        background: "var(--color-surface-3)",
        color: "var(--color-text)",
        border: "1px solid var(--color-border-strong)",
      } as CSSProperties);

  const handleTriggerEnter = headerStyle
    ? (e: ReactMouseEvent<HTMLButtonElement>) => {
        e.currentTarget.style.background = "rgba(255,255,255,0.05)";
        e.currentTarget.style.color = "var(--color-text)";
        e.currentTarget.style.borderColor = "rgba(255,255,255,0.20)";
      }
    : undefined;

  const handleTriggerLeave = headerStyle
    ? (e: ReactMouseEvent<HTMLButtonElement>) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = "var(--color-text-muted)";
        e.currentTarget.style.borderColor = "rgba(255,255,255,0.10)";
      }
    : undefined;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div
      ref={rootRef}
      className={cardStyle ? "relative flex-1" : "relative"}
      style={cardStyle ? { minWidth: 140 } : undefined}
    >
      {cardStyle ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full flex-col gap-3 rounded-lg p-4 text-left transition-colors"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            minHeight: 88,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--color-surface-3)";
            e.currentTarget.style.borderColor = "var(--color-border-strong)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "var(--color-surface-2)";
            e.currentTarget.style.borderColor = "var(--color-border)";
          }}
          aria-expanded={open}
          aria-haspopup="menu"
          title="Ejecutar un script de ~/.ultron/batches/"
        >
          <div
            className="flex h-8 w-8 items-center justify-center rounded-md"
            style={{
              background: "var(--color-surface-1)",
              border: "1px solid var(--color-border)",
              color: "var(--color-text-secondary)",
            }}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span
                className="text-[13px] font-semibold"
                style={{ color: "var(--color-text)" }}
              >
                {runningName ? `Ejecutando: ${runningName}` : "Run Batch"}
              </span>
              {queueCount > 0 && (
                <span
                  className="rounded px-1 text-[10px] font-semibold tabular-nums"
                  style={{
                    background: "rgba(248,81,73,0.14)",
                    color: "var(--color-danger)",
                    border: "1px solid rgba(248,81,73,0.35)",
                  }}
                >
                  {queueCount}
                </span>
              )}
            </div>
            <div
              className="mt-0.5 text-[11px] leading-snug"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {count > 0
                ? `${count} script${count === 1 ? "" : "s"} disponible${count === 1 ? "" : "s"}`
                : "Sin scripts en cola"}
            </div>
          </div>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={triggerClassName}
          style={triggerStyle}
          onMouseEnter={handleTriggerEnter}
          onMouseLeave={handleTriggerLeave}
          title="Execute a pre-approved script from ~/.ultron/batches/"
          aria-expanded={open}
          aria-haspopup="menu"
        >
          <span aria-hidden style={{ fontSize: 11, lineHeight: 1 }}>
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          </span>
          <span>{runningName ? `Running: ${runningName}` : "Run batch"}</span>
          {runningName && (
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              className="animate-spin"
              aria-hidden
            >
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          )}
          {count > 0 && (
            <span
              className="rounded px-1 text-[10px] tabular-nums"
              style={{
                background: "var(--color-surface-1)",
                color: "var(--color-text-secondary)",
                border: "1px solid var(--color-border)",
              }}
              title={`${count} batch script${count === 1 ? "" : "s"} available`}
            >
              {count}
            </span>
          )}
          {queueCount > 0 && (
            <span
              className="rounded px-1 text-[10px] font-semibold tabular-nums"
              style={{
                background: "rgba(248, 81, 73, 0.14)",
                color: "var(--color-danger)",
                border: "1px solid rgba(248, 81, 73, 0.35)",
              }}
              title={`${queueCount} en cola -- requieren tu click`}
            >
              {queueCount}
            </span>
          )}
          <span aria-hidden style={{ fontSize: 9, opacity: 0.7 }}>
            v
          </span>
        </button>
      )}

      {open && (
        <div
          role="menu"
          aria-label="Available batch scripts"
          className="absolute right-0 z-40 mt-1.5 w-[380px] rounded-lg shadow-xl"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border-strong)",
          }}
        >
          {/* ----------------------------------------------------------------
              Header row: title + action buttons
          ---------------------------------------------------------------- */}
          <div
            className="flex items-center justify-between gap-2 px-3 py-2"
            style={{ borderBottom: "1px solid var(--color-border)" }}
          >
            <div
              className="text-[10px] font-medium uppercase tracking-[0.06em]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Batches pendientes
            </div>
            <div className="flex items-center gap-1">
              {/* -- Clear All with two-phase confirmation -- */}
              {confirmingClearAll ? (
                <div className="flex items-center gap-1">
                  <span
                    className="text-[10.5px] font-medium"
                    style={{ color: "var(--color-danger)" }}
                  >
                    Seguro?
                  </span>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); void clearAll(); }}
                    disabled={loading}
                    className="rounded px-1.5 py-0.5 text-[10.5px] font-medium transition-colors disabled:opacity-40"
                    style={{
                      background: "rgba(248,81,73,0.15)",
                      color: "var(--color-danger)",
                      border: "1px solid rgba(248,81,73,0.40)",
                    }}
                  >
                    Si, borrar todo
                  </button>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setConfirmingClearAll(false); }}
                    className="rounded px-1.5 py-0.5 text-[10.5px] transition-colors"
                    style={{
                      background: "transparent",
                      color: "var(--color-text-secondary)",
                      border: "1px solid var(--color-border)",
                    }}
                  >
                    Cancelar
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setConfirmingClearAll(true); }}
                  disabled={loading}
                  className="rounded px-1.5 py-0.5 text-[10.5px] transition-colors disabled:opacity-40"
                  style={{
                    background: "transparent",
                    color: "var(--color-danger)",
                    border: "1px solid var(--color-border)",
                  }}
                  title="Eliminar TODOS los batches (con confirmacion)"
                >
                  Clear all
                </button>
              )}

              {/* -- Refresh -- */}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); void refresh(); }}
                disabled={loading}
                className="rounded px-1.5 py-0.5 text-[10.5px] transition-colors disabled:opacity-40"
                style={{
                  background: "transparent",
                  color: "var(--color-text-secondary)",
                  border: "1px solid var(--color-border)",
                }}
                title="Re-scan the batches folder"
              >
                {loading ? "..." : "Refresh"}
              </button>
            </div>
          </div>

          {/* ----------------------------------------------------------------
              Body — queue + batch file list unified as a single list
          ---------------------------------------------------------------- */}
          <div className="max-h-[420px] overflow-y-auto py-1">
            {loading && batches === null && (
              <div
                className="px-3 py-3 text-center text-[12px]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                Cargando batches...
              </div>
            )}

            {error && (
              <div
                className="m-1 rounded p-2 text-[11.5px]"
                style={{
                  background: "rgba(248, 81, 73, 0.06)",
                  border: "1px solid rgba(248, 81, 73, 0.22)",
                  color: "var(--color-danger)",
                }}
              >
                {error}
              </div>
            )}

            {/* Queue entries (Claude no pudo ejecutar) */}
            {queue && queue.length > 0 && (
              <ul className="flex flex-col gap-0.5 px-1 pt-1">
                {queue.map((q) => {
                  const isManual = q.kind === "manual";
                  const busy = queueBusyId === q.id || runningName === q.name;
                  return (
                    <li
                      key={q.id}
                      className="rounded px-2 py-2"
                      style={{
                        background: isManual
                          ? "rgba(210,153,34,0.06)"
                          : "rgba(248,81,73,0.04)",
                        border: `1px solid ${isManual ? "rgba(210,153,34,0.22)" : "rgba(248,81,73,0.18)"}`,
                      }}
                    >
                      {/* Name + reason badges */}
                      <div className="flex items-center gap-2">
                        <span
                          className="min-w-0 flex-1 truncate text-[12px] font-medium"
                          style={{
                            fontFamily: "var(--font-mono)",
                            color: "var(--color-text)",
                          }}
                          title={q.path || q.name}
                        >
                          {q.name}
                        </span>
                        {isManual && (
                          <span
                            className="shrink-0 rounded px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide"
                            style={{
                              background: "rgba(210,153,34,0.15)",
                              color: "var(--color-warning, #d29922)",
                              border: "1px solid rgba(210,153,34,0.40)",
                            }}
                          >
                            manual
                          </span>
                        )}
                        <span
                          className="shrink-0 rounded px-1.5 py-px text-[9.5px] font-medium uppercase tracking-wide"
                          style={{
                            background: "var(--color-surface-1)",
                            color: REASON_COLOR[q.reason],
                            border: `1px solid ${REASON_COLOR[q.reason]}`,
                          }}
                        >
                          {REASON_LABEL[q.reason]}
                        </span>
                        {q.attempts > 1 && (
                          <span
                            className="shrink-0 text-[9.5px] tabular-nums"
                            style={{ color: "var(--color-text-tertiary)" }}
                          >
                            x{q.attempts}
                          </span>
                        )}
                      </div>

                      {/* Description */}
                      {q.description && (
                        <div
                          className="mt-1 rounded px-1.5 py-1 text-[10.5px] leading-snug"
                          style={{
                            background: "var(--color-surface-1)",
                            color: "var(--color-text-secondary)",
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                          }}
                        >
                          {q.description}
                        </div>
                      )}

                      {q.last_error && (
                        <div
                          className="mt-1 max-h-[48px] overflow-y-auto rounded px-1.5 py-1 text-[10px] leading-snug"
                          style={{
                            background: "var(--color-surface-1)",
                            color: "var(--color-text-secondary)",
                            fontFamily: "var(--font-mono)",
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                          }}
                        >
                          {clip(q.last_error, 200)}
                        </div>
                      )}

                      {/* Actions */}
                      <div className="mt-1.5 flex items-center gap-1.5">
                        {!isManual && (
                          <button
                            type="button"
                            disabled={busy || runningName !== null}
                            onClick={() => void runFromQueue(q)}
                            className="rounded px-2 py-0.5 text-[10.5px] font-medium transition-colors disabled:opacity-40"
                            style={{
                              background: "rgba(88,166,255,0.12)",
                              color: "var(--color-accent, #58a6ff)",
                              border: "1px solid rgba(88,166,255,0.40)",
                            }}
                            title="Ejecutar ahora"
                          >
                            {busy ? "Ejecutando..." : "Ejecutar"}
                          </button>
                        )}
                        {!isManual && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void requeue(q)}
                            className="rounded px-2 py-0.5 text-[10.5px] transition-colors disabled:opacity-40"
                            style={{
                              background: "transparent",
                              color: "var(--color-text-secondary)",
                              border: "1px solid var(--color-border)",
                            }}
                            title="Reencolar (marcar pendiente de reintento)"
                          >
                            Requeue
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void dismissQueue(q)}
                          className="rounded px-2 py-0.5 text-[10.5px] transition-colors disabled:opacity-40"
                          style={{
                            background: "transparent",
                            color: "var(--color-text-tertiary)",
                            border: "1px solid var(--color-border)",
                          }}
                          title={isManual ? "Marcar como hecho y descartar" : "Eliminar de la lista"}
                        >
                          {isManual ? "Hecho" : "Eliminar"}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {/* Separator when both sections are visible */}
            {queue && queue.length > 0 && batches && batches.length > 0 && (
              <div
                className="mx-3 my-2"
                style={{ height: 1, background: "var(--color-border)" }}
              />
            )}

            {/* Batch file list */}
            {!loading && !error && batches && batches.length === 0 && (queue === null || queue.length === 0) && (
              <div
                className="px-3 py-6 text-center text-[12px]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                No hay batches pendientes.
                <div
                  className="mt-1.5 text-[10.5px]"
                  style={{ color: "var(--color-text-faint)" }}
                >
                  Los scripts que Claude no pueda ejecutar apareceran aqui.
                </div>
              </div>
            )}

            {batches && batches.length > 0 && (
              <ul className="flex flex-col gap-0.5 px-1 pt-1">
                {batches.map((b) => {
                  const busy = runningName === b.name;
                  const pendingDelete = pendingDeleteName === b.name;
                  return (
                    <li key={b.path} className="group/item">
                      {pendingDelete ? (
                        <div
                          className="flex items-center gap-2 rounded px-2 py-1.5"
                          style={{
                            background: "rgba(248, 81, 73, 0.06)",
                            border: "1px solid rgba(248, 81, 73, 0.22)",
                          }}
                        >
                          <span
                            className="min-w-0 flex-1 truncate text-[11.5px]"
                            style={{
                              fontFamily: "var(--font-mono)",
                              color: "var(--color-danger)",
                            }}
                          >
                            Eliminar {b.name}?
                          </span>
                          <button
                            type="button"
                            onClick={() => void deleteSingle(b.name)}
                            className="rounded px-2 py-0.5 text-[11px] font-medium transition-colors"
                            style={{
                              background: "rgba(248,81,73,0.15)",
                              color: "var(--color-danger)",
                              border: "1px solid rgba(248,81,73,0.40)",
                            }}
                          >
                            Confirmar
                          </button>
                          <button
                            type="button"
                            onClick={() => setPendingDeleteName(null)}
                            className="rounded px-2 py-0.5 text-[11px] transition-colors"
                            style={{
                              background: "transparent",
                              color: "var(--color-text-secondary)",
                              border: "1px solid var(--color-border)",
                            }}
                          >
                            Cancelar
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            role="menuitem"
                            disabled={busy || runningName !== null}
                            onClick={() => void run(b.name)}
                            className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left transition-colors disabled:opacity-50"
                            style={{
                              background: "transparent",
                              color: "var(--color-text)",
                              border: "1px solid transparent",
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.background = "var(--color-surface-3)";
                              e.currentTarget.style.borderColor = "var(--color-border)";
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.background = "transparent";
                              e.currentTarget.style.borderColor = "transparent";
                            }}
                            title={`${b.path}\n${formatBytes(b.size_bytes)} — modificado ${formatAge(b.modified_epoch)}`}
                          >
                            <div className="min-w-0 flex-1">
                              <div
                                className="truncate text-[12px] font-medium"
                                style={{
                                  fontFamily: "var(--font-mono)",
                                  color: "var(--color-text)",
                                }}
                              >
                                {b.name}
                              </div>
                              <div
                                className="mt-px flex items-center gap-2 text-[10px]"
                                style={{ color: "var(--color-text-tertiary)" }}
                              >
                                <span className="tabular-nums">{formatBytes(b.size_bytes)}</span>
                                <span style={{ color: "var(--color-text-faint)" }}>·</span>
                                <span className="tabular-nums">{formatAge(b.modified_epoch)}</span>
                              </div>
                            </div>
                            <span
                              className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide"
                              style={{
                                background: busy ? "var(--color-accent)" : "var(--color-surface-1)",
                                color: busy ? "var(--color-accent-text)" : "var(--color-text-secondary)",
                                border: `1px solid ${busy ? "var(--color-accent)" : "var(--color-border)"}`,
                              }}
                            >
                              {busy && (
                                <svg
                                  width="9"
                                  height="9"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="3"
                                  strokeLinecap="round"
                                  style={{ animation: "spin 0.9s linear infinite" }}
                                  aria-hidden
                                >
                                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                                </svg>
                              )}
                              {busy ? "running" : "run"}
                            </span>
                          </button>

                          {/* Delete button — visible on hover */}
                          <button
                            type="button"
                            disabled={busy || runningName !== null}
                            onClick={(e) => {
                              e.stopPropagation();
                              setPendingDeleteName(b.name);
                            }}
                            title={`Eliminar ${b.name}`}
                            className="flex shrink-0 items-center justify-center rounded p-1 opacity-0 transition-opacity group-hover/item:opacity-100 disabled:pointer-events-none"
                            style={{
                              background: "transparent",
                              color: "var(--color-text-tertiary)",
                              border: "1px solid transparent",
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.color = "var(--color-danger)";
                              e.currentTarget.style.background = "rgba(248,81,73,0.08)";
                              e.currentTarget.style.borderColor = "rgba(248,81,73,0.25)";
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.color = "var(--color-text-tertiary)";
                              e.currentTarget.style.background = "transparent";
                              e.currentTarget.style.borderColor = "transparent";
                            }}
                            aria-label={`Eliminar ${b.name}`}
                          >
                            <svg
                              width="11"
                              height="11"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                              strokeLinecap="round"
                              aria-hidden
                            >
                              <line x1="18" y1="6" x2="6" y2="18" />
                              <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
