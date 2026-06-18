// Custom hook that owns all state and async operations for BatchDropdown.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  BatchEntry,
  BatchQueueEntry,
  BatchRunResult,
  BatchToast,
} from "./types";
import { clip } from "./utils";

export type UseBatchDropdownReturn = {
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  batches: BatchEntry[] | null;
  loading: boolean;
  error: string | null;
  runningName: string | null;
  pendingDeleteName: string | null;
  setPendingDeleteName: React.Dispatch<React.SetStateAction<string | null>>;
  confirmingClearAll: boolean;
  setConfirmingClearAll: React.Dispatch<React.SetStateAction<boolean>>;
  queue: BatchQueueEntry[] | null;
  queueBusyId: string | null;
  rootRef: React.RefObject<HTMLDivElement | null>;
  refresh: () => Promise<void>;
  requeue: (entry: BatchQueueEntry) => Promise<void>;
  dismissQueue: (entry: BatchQueueEntry) => Promise<void>;
  run: (name: string) => Promise<void>;
  runFromQueue: (entry: BatchQueueEntry) => Promise<void>;
  deleteSingle: (name: string) => Promise<void>;
  clearAll: () => Promise<void>;
};

export function useBatchDropdown(
  onResult?: (toast: BatchToast) => void,
): UseBatchDropdownReturn {
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

  return {
    open,
    setOpen,
    batches,
    loading,
    error,
    runningName,
    pendingDeleteName,
    setPendingDeleteName,
    confirmingClearAll,
    setConfirmingClearAll,
    queue,
    queueBusyId,
    rootRef,
    refresh,
    requeue,
    dismissQueue,
    run,
    runFromQueue,
    deleteSingle,
    clearAll,
  };
}
