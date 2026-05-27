// ULTRON Control Center — Recall Last Session dialog (redesign 2026-05-27).
//
// Shows a structured summary of the most recent Claude Code session for the
// active project. Renders the summary as markdown, exposes a status badge
// based on the recall source, and offers three footer actions:
//   • "Inject as prompt"  — calls onInject(suggested_prompt) (parent handles it)
//   • "Open transcript"   — opens the JSONL file in the system editor
//   • "Refresh"           — re-fetches the recall payload
//
// Props kept backward-compatible with the v1 API:
//   projectId?, onClose, onSpawn? (unchanged)
// New optional prop:
//   onInject? (string) => void   — if absent, the button is hidden

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { X, History, RefreshCw } from "../icons";
import { Markdown } from "../../../lib/markdown";
import type { RecallResult } from "../../../types";

type Props = {
  /** Scopes recall to this project. Omit for global recall. */
  projectId?: string;
  /** Display name used in the header. Falls back to projectId. */
  projectName?: string;
  /** Close handler. Dialog never closes itself except via this. */
  onClose: () => void;
  /** Legacy: spawn a new Claude PTY with the suggested prompt. */
  onSpawn?: (prompt: string) => Promise<void> | void;
  /** New: inject the suggested prompt into the active input. */
  onInject?: (prompt: string) => void;
};

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

type BadgeVariant = "found" | "fallback" | "none";

function sourceToBadge(source: string, found: boolean): BadgeVariant {
  if (!found) return "none";
  if (source === "jsonl") return "found";
  if (source === "mem0") return "fallback";
  return "none";
}

const BADGE_CONFIG: Record<
  BadgeVariant,
  { label: string; bg: string; color: string; border: string } | null
> = {
  found: {
    label: "Found JSONL",
    bg: "rgba(34,197,94,0.12)",
    color: "#4ade80",
    border: "rgba(34,197,94,0.3)",
  },
  fallback: {
    label: "Fallback to mem0",
    bg: "rgba(234,179,8,0.12)",
    color: "#fbbf24",
    border: "rgba(234,179,8,0.3)",
  },
  none: {
    label: "Not found",
    bg: "rgba(107,114,128,0.12)",
    color: "var(--color-text-tertiary)",
    border: "rgba(107,114,128,0.25)",
  },
};

function StatusBadge({ source, found }: { source: string; found: boolean }) {
  const variant = sourceToBadge(source, found);
  const cfg = BADGE_CONFIG[variant];
  if (!cfg) return null;
  return (
    <span
      style={{
        background: cfg.bg,
        color: cfg.color,
        border: `1px solid ${cfg.border}`,
        borderRadius: 9999,
        fontSize: 10,
        padding: "1px 7px",
        fontWeight: 500,
        letterSpacing: "0.02em",
        whiteSpace: "nowrap",
      }}
    >
      {cfg.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export default function RecallSessionDialog({
  projectId,
  projectName,
  onClose,
  onSpawn,
  onInject,
}: Props) {
  const [result, setResult] = useState<RecallResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [spawning, setSpawning] = useState(false);

  const displayName = projectName ?? projectId ?? "project";

  const fetchRecall = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const cmd = projectId ? "recall_last_session" : "recall_last_session_global";
      const args = projectId ? { projectId } : {};
      const r = await invoke<RecallResult>(cmd, args);
      setResult(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void fetchRecall();
  }, [fetchRecall]);

  const handleInject = useCallback(() => {
    if (!result?.suggested_prompt.trim() || !onInject) return;
    onInject(result.suggested_prompt);
    onClose();
  }, [result, onInject, onClose]);

  const handleOpenTranscript = useCallback(async () => {
    if (!result?.session_id || !projectId) return;
    // The JSONL lives at ~/.claude/projects/<slug>/<session_id>.jsonl.
    // We pass the path hint encoded in the session_id field if the backend
    // emits a full path, otherwise fall back gracefully.
    const pathHint = result.session_id.includes("/") || result.session_id.includes("\\")
      ? result.session_id
      : null;
    if (!pathHint) return;
    try {
      await openPath(pathHint);
    } catch (e) {
      setError(`Cannot open transcript: ${e}`);
    }
  }, [result, projectId]);

  const handleSpawn = useCallback(async () => {
    if (!result?.suggested_prompt.trim() || !onSpawn) return;
    setSpawning(true);
    setError(null);
    try {
      await onSpawn(result.suggested_prompt);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSpawning(false);
    }
  }, [result, onSpawn, onClose]);

  // Determine whether "Open transcript" is available.
  const canOpenTranscript =
    !!result?.session_id &&
    (result.session_id.includes("/") || result.session_id.includes("\\"));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="recall-dialog-title"
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg border border-[var(--color-border)] shadow-xl"
        style={{ background: "var(--color-surface-2)" }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // ESC closes (Anthropic dialog convention).
          if (e.key === "Escape") onClose();
        }}
      >
        {/* ---------------------------------------------------------------- */}
        {/* Header                                                           */}
        {/* ---------------------------------------------------------------- */}
        <header className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <History size={14} className="shrink-0 text-[var(--color-text-muted)]" />
            <h2
              id="recall-dialog-title"
              className="truncate text-sm font-semibold text-[var(--color-text)]"
            >
              Last session in{" "}
              <span className="text-[var(--color-accent)]">{displayName}</span>
            </h2>
            {result && !loading && (
              <StatusBadge source={result.source} found={result.found} />
            )}
          </div>
          <button
            onClick={onClose}
            className="ml-2 shrink-0 rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text)]"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </header>

        {/* ---------------------------------------------------------------- */}
        {/* Body                                                             */}
        {/* ---------------------------------------------------------------- */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {/* Loading */}
          {loading && (
            <div className="flex items-center gap-2 py-6 text-xs text-[var(--color-text-muted)]">
              <RefreshCw size={14} className="animate-spin" />
              <span>Fetching last session…</span>
            </div>
          )}

          {/* Error */}
          {!loading && error && (
            <div
              className="rounded border px-3 py-2 text-xs"
              style={{
                borderColor: "var(--color-error)",
                background: "rgba(239,68,68,0.06)",
                color: "var(--color-error)",
              }}
            >
              {error}
            </div>
          )}

          {/* Content */}
          {!loading && !error && result && (
            <>
              {/* Timestamp + session id row */}
              <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1">
                {result.last_active_iso && (
                  <span className="text-[11px] text-[var(--color-text-muted)]">
                    Last activity:{" "}
                    <span className="text-[var(--color-text-secondary)]">
                      {result.last_active_iso}
                    </span>
                  </span>
                )}
                {result.session_id && (
                  <span
                    className="max-w-[22ch] truncate text-[11px] text-[var(--color-text-tertiary)]"
                    style={{ fontFamily: "var(--font-mono)" }}
                    title={result.session_id}
                  >
                    {result.session_id}
                  </span>
                )}
              </div>

              {/* Summary markdown */}
              <div
                className="mb-3 rounded border p-3"
                style={{
                  borderColor: "var(--color-border)",
                  background: "var(--color-surface-1)",
                  fontSize: 12,
                }}
              >
                {result.summary_md.trim() ? (
                  <Markdown source={result.summary_md} />
                ) : (
                  <p className="text-[12px] text-[var(--color-text-muted)]">
                    No summary available.
                  </p>
                )}
              </div>

              {/* Not-found hint */}
              {!result.found && (
                <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                  No previous session found. The suggested prompt is generic — you
                  can still inject it as a starting point.
                </p>
              )}
            </>
          )}
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* Footer                                                           */}
        {/* ---------------------------------------------------------------- */}
        <footer className="flex items-center justify-between gap-2 border-t border-[var(--color-border)] px-4 py-2.5">
          {/* Left: secondary actions */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => void fetchRecall()}
              disabled={loading}
              className="flex items-center gap-1 rounded-md border border-[var(--color-border)] px-3 py-1 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-50"
              title="Re-fetch recall"
            >
              <RefreshCw size={11} />
              Refresh
            </button>
            {canOpenTranscript && (
              <button
                onClick={() => void handleOpenTranscript()}
                disabled={loading}
                className="flex items-center gap-1 rounded-md border border-[var(--color-border)] px-3 py-1 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-50"
                title="Open JSONL transcript in editor"
              >
                Open transcript
              </button>
            )}
          </div>

          {/* Right: primary action */}
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="rounded-md border border-[var(--color-border)] px-3 py-1 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)]"
            >
              Cancel
            </button>
            {onInject && (
              <button
                onClick={handleInject}
                disabled={!result?.suggested_prompt.trim() || loading}
                className="rounded-md px-3 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50"
                style={{
                  background: "var(--color-accent)",
                  color: "#000",
                  border: "1px solid var(--color-accent)",
                }}
                title="Inject as prompt in the active terminal input"
              >
                Inject as prompt
              </button>
            )}
            {onSpawn && (
              <button
                onClick={() => void handleSpawn()}
                disabled={!result?.suggested_prompt.trim() || loading || spawning}
                className="rounded-md border border-[var(--color-accent)] px-3 py-1 text-xs text-[var(--color-accent)] hover:bg-[var(--color-accent)]/20 disabled:cursor-not-allowed disabled:opacity-50"
                title="Spawn new Claude session with this prompt"
              >
                {spawning ? "Spawning…" : "Spawn session"}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
