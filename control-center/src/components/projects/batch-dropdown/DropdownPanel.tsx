// The open dropdown panel for BatchDropdown: header row (Clear all / Refresh)
// + body (queue entries + batch file list).

import type { BatchEntry, BatchQueueEntry } from "./types";
import { REASON_COLOR, REASON_LABEL, clip, formatAge, formatBytes } from "./utils";

type DropdownPanelProps = {
  batches: BatchEntry[] | null;
  loading: boolean;
  error: string | null;
  runningName: string | null;
  pendingDeleteName: string | null;
  setPendingDeleteName: (name: string | null) => void;
  confirmingClearAll: boolean;
  setConfirmingClearAll: (v: boolean) => void;
  queue: BatchQueueEntry[] | null;
  queueBusyId: string | null;
  onRefresh: () => void;
  onClearAll: () => void;
  onRun: (name: string) => void;
  onDeleteSingle: (name: string) => void;
  onRunFromQueue: (entry: BatchQueueEntry) => void;
  onRequeue: (entry: BatchQueueEntry) => void;
  onDismissQueue: (entry: BatchQueueEntry) => void;
};

export function DropdownPanel({
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
  onRefresh,
  onClearAll,
  onRun,
  onDeleteSingle,
  onRunFromQueue,
  onRequeue,
  onDismissQueue,
}: DropdownPanelProps) {
  return (
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
                onClick={(e) => { e.stopPropagation(); onClearAll(); }}
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
            onClick={(e) => { e.stopPropagation(); onRefresh(); }}
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
                        onClick={() => onRunFromQueue(q)}
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
                        onClick={() => onRequeue(q)}
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
                      onClick={() => onDismissQueue(q)}
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
                        onClick={() => onDeleteSingle(b.name)}
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
                        onClick={() => onRun(b.name)}
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
  );
}
