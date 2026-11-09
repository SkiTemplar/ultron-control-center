// Custom hook that owns all state and async operations for BatchDropdown.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  BatchEntry,
  BatchQueueEntry,
  BatchQueueListing,
  BatchRunResult,
  BatchRunReview,
  BatchScriptPreview,
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
  queueError: string | null;
  rootRef: React.RefObject<HTMLDivElement | null>;
  refresh: () => Promise<void>;
  requeue: (entry: BatchQueueEntry) => Promise<void>;
  dismissQueue: (entry: BatchQueueEntry) => Promise<void>;
  review: BatchRunReview | null;
  requestRun: (name: string, queueEntry?: BatchQueueEntry | null) => Promise<void>;
  confirmRun: () => Promise<void>;
  cancelRun: () => void;
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
  const [queueError, setQueueError] = useState<string | null>(null);

  // Revisión del script antes de ejecutar: un clic en «Ejecutar» solo la abre.
  const [review, setReview] = useState<BatchRunReview | null>(null);
  const reviewRequest = useRef(0);

  const rootRef = useRef<HTMLDivElement | null>(null);

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  const refreshQueue = useCallback(async () => {
    try {
      const listing = await invoke<BatchQueueListing>("batches_list_queue");
      const q = listing.entries;
      setQueue(q);
      setQueueError(
        listing.drain_error ? `No se pudo drenar la cola de capturas: ${listing.drain_error}` : null,
      );
      // If the busy entry disappeared from the backend, release the lock so
      // buttons are no longer disabled forever.
      setQueueBusyId((prev) => (prev !== null && !q.some((e) => e.id === prev) ? null : prev));
    } catch (e: unknown) {
      setQueue((prev) => prev ?? []);
      setQueueError(`No se pudo leer la cola: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  // Drena y cuenta al montar (hooks-6, 2026-10-23): la cola solo se leía al
  // abrir el desplegable, así que el contador del botón salía siempre a 0 y
  // nadie llegaba a abrirlo; queue-pending.jsonl acumuló capturas desde julio.
  useEffect(() => {
    void refreshQueue();
  }, [refreshQueue]);

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
      if (confirmingClearAll || pendingDeleteName !== null || review !== null) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (confirmingClearAll) { setConfirmingClearAll(false); return; }
        if (pendingDeleteName !== null) { setPendingDeleteName(null); return; }
        if (review !== null) { reviewRequest.current += 1; setReview(null); return; }
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, confirmingClearAll, pendingDeleteName, review]);

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
          body: "Marcado como pendiente de reintento. Pulsa Ejecutar para lanzarlo.",
        });
        void refreshQueue();
      } catch (e: unknown) {
        onResult?.({
          kind: "err",
          title: `No se pudo reencolar: ${entry.name}`,
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
          title: `No se pudo descartar: ${entry.name}`,
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

  // Abre la revisión: lee el script y lo deja a la vista. Ejecutar exige otro
  // clic. Un comando de la cola puede venir de contenido no confiable de una
  // sesión de IA, a veces rechazado antes; nombre y motivo no bastan para decidir.
  const requestRun = useCallback(
    async (name: string, queueEntry: BatchQueueEntry | null = null) => {
      const request = ++reviewRequest.current;
      setReview({ name, queueEntry, status: "loading" });
      try {
        const script = await invoke<BatchScriptPreview>("batch_read_script", { name });
        if (request !== reviewRequest.current) return;
        setReview({ name, queueEntry, status: "ready", script });
      } catch (e: unknown) {
        if (request !== reviewRequest.current) return;
        setReview({
          name,
          queueEntry,
          status: "error",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [],
  );

  const cancelRun = useCallback(() => {
    reviewRequest.current += 1;
    setReview(null);
  }, []);

  const dismissAfterSuccess = useCallback(
    async (entry: BatchQueueEntry) => {
      try {
        await invoke<void>("batches_dismiss_queue", { id: entry.id });
      } catch (e: unknown) {
        onResult?.({
          kind: "err",
          title: `El batch terminó, pero sigue en la cola: ${entry.name}`,
          body: e instanceof Error ? e.message : String(e),
        });
      }
      void refreshQueue();
    },
    [onResult, refreshQueue],
  );

  // Ejecuta lo revisado y solo lo revisado: sin script en `ready`, o si no cabe
  // en la vista previa, no hay nada que confirmar. El backend rechaza además un
  // contenido que no coincida con el fichero.
  const confirmRun = useCallback(async () => {
    if (review?.status !== "ready" || review.script.too_large) return;
    const { name, queueEntry, script } = review;
    reviewRequest.current += 1;
    setReview(null);
    setRunningName(name);
    if (queueEntry) setQueueBusyId(queueEntry.id);
    try {
      const r = await invoke<BatchRunResult>("execute_batch", {
        name,
        reviewed: script.content,
      });
      const body = clip(r.stdout) || clip(r.stderr) || `exit ${r.exit_code ?? "?"}`;
      onResult?.({
        kind: r.success ? "ok" : "err",
        title: r.success
          ? `Batch terminado: ${name}`
          : `Batch fallido: ${name} (exit ${r.exit_code ?? "?"})`,
        body,
      });
      if (r.success && queueEntry) await dismissAfterSuccess(queueEntry);
    } catch (e: unknown) {
      onResult?.({
        kind: "err",
        title: `Error en el batch: ${name}`,
        body: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setRunningName(null);
      setQueueBusyId(null);
      void refresh();
    }
  }, [dismissAfterSuccess, onResult, refresh, review]);

  const deleteSingle = useCallback(
    async (name: string) => {
      setPendingDeleteName(null);
      try {
        await invoke<void>("delete_batch_single", { name });
        onResult?.({
          kind: "ok",
          title: `Borrado: ${name}`,
          body: "Script quitado de ~/.ultron/batches/",
        });
        await refresh();
      } catch (e: unknown) {
        onResult?.({
          kind: "err",
          title: `No se pudo borrar: ${name}`,
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
            ? "No había batches que borrar."
            : `Eliminados ${r.deleted.length} script${r.deleted.length === 1 ? "" : "s"} y vaciada la cola.`,
      });
    } catch (err: unknown) {
      onResult?.({
        kind: "err",
        title: "No se pudo borrar todo",
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
    queueError,
    rootRef,
    refresh,
    requeue,
    dismissQueue,
    review,
    requestRun,
    confirmRun,
    cancelRun,
    deleteSingle,
    clearAll,
  };
}
