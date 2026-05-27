// ULTRON Control Center - BatchDropdown
//
// Botón "Run batch" para el header del tab Projects. Lista los .bat / .cmd /
// .ps1 que la AI (o el usuario) deja en `~/.ultron/batches/` cuando hay un
// comando que el sandbox no puede ejecutar (instalaciones interactivas,
// elevación, etc.). Un click en un item invoca `execute_batch` en el backend
// y muestra el stdout/stderr resultante como toast inline.
//
// Backend: src-tauri/src/commands/batches.rs
//   list_batches() -> Vec<BatchEntry>
//   execute_batch(name: String) -> BatchRunResult

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";

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

export type BatchToast = {
  kind: "ok" | "err";
  title: string;
  body: string;
};

type BatchDropdownProps = {
  /** Callback fired with a toast payload after a batch finishes (success or
   *  failure). The host renders this in its own surface so the dropdown stays
   *  visually consistent with the rest of the toolbar. */
  onResult?: (toast: BatchToast) => void;
  /** When true, the trigger button adopts the project-header visual style:
   *  transparent bg, rgba border, same size as the other header buttons.
   *  When false (default), uses the original toolbar style. */
  headerStyle?: boolean;
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatAge(epoch: number): string {
  if (!epoch) return "—";
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, now - epoch);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/** Trim a long stdout/stderr blob so the toast stays readable. */
function clip(s: string, max = 320): string {
  const trimmed = s.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}… (+${trimmed.length - max} chars)`;
}

export default function BatchDropdown({
  onResult,
  headerStyle = false,
}: BatchDropdownProps) {
  const [open, setOpen] = useState(false);
  const [batches, setBatches] = useState<BatchEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runningName, setRunningName] = useState<string | null>(null);
  /** Name of the batch currently pending delete confirmation (inline). */
  const [pendingDeleteName, setPendingDeleteName] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

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
  }, []);

  // Load on first open so we don't hit disk until the user actually wants it.
  useEffect(() => {
    if (open && batches === null) void refresh();
  }, [open, batches, refresh]);

  // Close on click-outside / ESC.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const run = useCallback(
    async (name: string) => {
      setRunningName(name);
      try {
        const r = await invoke<BatchRunResult>("execute_batch", { name });
        const body =
          clip(r.stdout) || clip(r.stderr) || `exit ${r.exit_code ?? "?"}`;
        onResult?.({
          kind: r.success ? "ok" : "err",
          title: r.success
            ? `Batch finished: ${name}`
            : `Batch failed: ${name} (exit ${r.exit_code ?? "?"})`,
          body,
        });
        // Refresh the modified-epoch column so "just ran" feels obvious.
        void refresh();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        onResult?.({
          kind: "err",
          title: `Batch error: ${name}`,
          body: msg,
        });
      } finally {
        setRunningName(null);
        setOpen(false);
      }
    },
    [onResult, refresh],
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
        void refresh();
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

  const count = batches?.length ?? 0;

  // Trigger button styles: header mode matches the other workspace header
  // buttons (transparent bg, rgba border, 11px font); default mode keeps the
  // original toolbar appearance.
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

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={triggerClassName}
        style={triggerStyle}
        onMouseEnter={handleTriggerEnter}
        onMouseLeave={handleTriggerLeave}
        title="Execute a pre-approved script from ~/.ultron/batches/ (handy when an AI session left a .bat for you to run)"
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span aria-hidden style={{ fontSize: 11, lineHeight: 1 }}>
          {/* Terminal-ish glyph, inline so we don't pull lucide. */}
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
        <span aria-hidden style={{ fontSize: 9, opacity: 0.7 }}>
          ▾
        </span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Available batch scripts"
          className="absolute right-0 z-40 mt-1.5 w-[360px] rounded-lg p-1 shadow-xl"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border-strong)",
          }}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between gap-2 px-2 py-1.5"
            style={{
              borderBottom: "1px solid var(--color-border)",
            }}
          >
            <div
              className="text-[10px] font-medium uppercase tracking-[0.06em]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              ~/.ultron/batches
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={async (e) => {
                  e.stopPropagation();
                  try {
                    const r = await invoke<{ deleted: string[]; kept: number }>(
                      "cleanup_old_batches",
                      { olderThanDays: 30 },
                    );
                    onResult?.({
                      kind: "ok",
                      title: `Cleanup: ${r.deleted.length} removed`,
                      body:
                        r.deleted.length === 0
                          ? `Nothing older than 30 days. Kept ${r.kept}.`
                          : `Deleted: ${r.deleted.slice(0, 8).join(", ")}${r.deleted.length > 8 ? `, +${r.deleted.length - 8} more` : ""}. Kept ${r.kept}.`,
                    });
                    void refresh();
                  } catch (err) {
                    onResult?.({
                      kind: "err",
                      title: "Cleanup failed",
                      body: err instanceof Error ? err.message : String(err),
                    });
                  }
                }}
                disabled={loading}
                className="rounded px-1.5 py-0.5 text-[10.5px] transition-colors disabled:opacity-40"
                style={{
                  background: "transparent",
                  color: "var(--color-text-secondary)",
                  border: "1px solid var(--color-border)",
                }}
                title="Delete batch scripts older than 30 days"
              >
                Clean old
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void refresh();
                }}
                disabled={loading}
                className="rounded px-1.5 py-0.5 text-[10.5px] transition-colors disabled:opacity-40"
                style={{
                  background: "transparent",
                  color: "var(--color-text-secondary)",
                  border: "1px solid var(--color-border)",
                }}
                title="Re-scan the batches folder"
              >
                {loading ? "…" : "Refresh"}
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="max-h-[320px] overflow-y-auto py-1">
            {loading && batches === null && (
              <div
                className="px-3 py-3 text-center text-[12px]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                Loading batches…
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

            {!loading && !error && batches && batches.length === 0 && (
              <div
                className="px-3 py-4 text-center text-[12px]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                No batches in{" "}
                <span style={{ fontFamily: "var(--font-mono)" }}>
                  ~/.ultron/batches/
                </span>
                <div
                  className="mt-1.5 text-[10.5px]"
                  style={{ color: "var(--color-text-faint)" }}
                >
                  Drop a .bat / .cmd / .ps1 here and reopen this menu.
                </div>
              </div>
            )}

            {batches && batches.length > 0 && (
              <ul className="flex flex-col gap-0.5">
                {batches.map((b) => {
                  const busy = runningName === b.name;
                  const pendingDelete = pendingDeleteName === b.name;
                  return (
                    <li key={b.path} className="group/item">
                      {/* Confirm-delete inline bar — shown instead of the run
                          row when the user clicks X on this item. */}
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
                            Delete {b.name}?
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
                            Confirm
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
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1">
                          {/* Run button — takes all available width */}
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
                              e.currentTarget.style.background =
                                "var(--color-surface-3)";
                              e.currentTarget.style.borderColor =
                                "var(--color-border)";
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.background = "transparent";
                              e.currentTarget.style.borderColor = "transparent";
                            }}
                            title={`${b.path}\n${formatBytes(b.size_bytes)} · modified ${formatAge(b.modified_epoch)}`}
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
                                <span className="tabular-nums">
                                  {formatBytes(b.size_bytes)}
                                </span>
                                <span
                                  style={{ color: "var(--color-text-faint)" }}
                                >
                                  ·
                                </span>
                                <span className="tabular-nums">
                                  {formatAge(b.modified_epoch)}
                                </span>
                              </div>
                            </div>
                            <span
                              className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide"
                              style={{
                                background: busy
                                  ? "var(--color-accent)"
                                  : "var(--color-surface-1)",
                                color: busy
                                  ? "var(--color-accent-text)"
                                  : "var(--color-text-secondary)",
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
                                  style={{
                                    animation: "spin 0.9s linear infinite",
                                  }}
                                  aria-hidden
                                >
                                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                                </svg>
                              )}
                              {busy ? "running" : "run"}
                            </span>
                          </button>

                          {/* Delete (X) button — only visible on hover */}
                          <button
                            type="button"
                            disabled={busy || runningName !== null}
                            onClick={(e) => {
                              e.stopPropagation();
                              setPendingDeleteName(b.name);
                            }}
                            title={`Delete ${b.name}`}
                            className="flex shrink-0 items-center justify-center rounded p-1 opacity-0 transition-opacity group-hover/item:opacity-100 disabled:pointer-events-none"
                            style={{
                              background: "transparent",
                              color: "var(--color-text-tertiary)",
                              border: "1px solid transparent",
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.color =
                                "var(--color-danger)";
                              e.currentTarget.style.background =
                                "rgba(248,81,73,0.08)";
                              e.currentTarget.style.borderColor =
                                "rgba(248,81,73,0.25)";
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.color =
                                "var(--color-text-tertiary)";
                              e.currentTarget.style.background = "transparent";
                              e.currentTarget.style.borderColor = "transparent";
                            }}
                            aria-label={`Eliminar ${b.name}`}
                          >
                            {/* X icon inline */}
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
