// ULTRON Control Center — Recall Last Session dialog.
//
// Pulls a structured summary of the most recent Claude Code session for the
// active project (backend `recall_last_session`) and gives the user two ways
// to act on it: copy a paste-ready prompt to the clipboard, or spawn a fresh
// Claude PTY in the project terminal preloaded with that prompt.
//
// Markdown rendering is intentionally minimal — we ship summaries that look
// like plain bullet lists, so we avoid pulling in a full markdown parser and
// just render the text inside a `<pre>` block. This keeps the bundle small
// and leaves the door open for a richer renderer later (the summary itself
// is already markdown-flavoured).

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, History, Clock } from "../icons";
import type { RecallResult } from "../../../types";

type Props = {
  /** Optional project id — when set, recall is scoped to that project. When
   *  omitted, the global recall command is used (used from the global
   *  Control Center terminal). */
  projectId?: string;
  /** Close handler. The dialog never closes itself except via this. */
  onClose: () => void;
  /** Called when the user clicks "Spawn new Claude session with this prompt".
   *  The parent decides where to spawn the PTY (per-project ProjectTerminal
   *  routes it into the active tab; the global terminal opens a new one). */
  onSpawn?: (prompt: string) => Promise<void> | void;
};

export default function RecallSessionDialog({
  projectId,
  onClose,
  onSpawn,
}: Props) {
  const [result, setResult] = useState<RecallResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const [spawning, setSpawning] = useState(false);

  // Load the recall payload on mount. Re-invokes when projectId changes
  // (the dialog is keyed by project in ProjectTerminal so this is mostly
  // mount-time only).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const cmd = projectId
          ? "recall_last_session"
          : "recall_last_session_global";
        const args = projectId ? { projectId } : {};
        const r = await invoke<RecallResult>(cmd, args);
        if (cancelled) return;
        setResult(r);
        setDraft(r.suggested_prompt);
      } catch (e) {
        if (cancelled) return;
        setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const handleCopy = useCallback(async () => {
    if (!draft.trim()) return;
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      setError(`Clipboard error: ${e}`);
    }
  }, [draft]);

  const handleSpawn = useCallback(async () => {
    if (!draft.trim() || !onSpawn) return;
    setSpawning(true);
    setError(null);
    try {
      await onSpawn(draft);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSpawning(false);
    }
  }, [draft, onSpawn, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2.5">
          <div className="flex items-center gap-2">
            <History size={14} />
            <h2 className="text-sm font-semibold">Recall last session</h2>
            {result?.source && result.source !== "none" && (
              <span
                className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]"
                title="Origen del resumen"
              >
                {result.source}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {loading && (
            <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
              <Clock size={12} />
              <span>Buscando la última sesión…</span>
            </div>
          )}

          {!loading && error && (
            <div className="rounded border border-[var(--color-error)] bg-[var(--color-surface-0)] p-2 text-xs text-[var(--color-error)]">
              {error}
            </div>
          )}

          {!loading && !error && result && (
            <>
              {result.last_active_iso && (
                <div className="mb-2 text-[11px] text-[var(--color-text-muted)]">
                  Última actividad: {result.last_active_iso}
                </div>
              )}
              <pre className="mb-3 whitespace-pre-wrap break-words rounded border border-[var(--color-border)] bg-[var(--color-surface-0)] p-3 font-mono text-[11px] leading-snug text-[var(--color-text)]">
                {result.summary_md}
              </pre>
              <label
                htmlFor="recall-prompt"
                className="mb-1 block text-[11px] uppercase tracking-wide text-[var(--color-text-muted)]"
              >
                Prompt sugerido (editable)
              </label>
              <textarea
                id="recall-prompt"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={5}
                className="w-full resize-y rounded border border-[var(--color-border)] bg-[var(--color-surface-0)] p-2 font-mono text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
                spellCheck={false}
              />
              {!result.found && (
                <p className="mt-2 text-[11px] text-[var(--color-text-muted)]">
                  No se encontró sesión previa. El prompt sugerido es genérico
                  — edítalo si quieres.
                </p>
              )}
            </>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-[var(--color-border)] px-4 py-2.5">
          <button
            onClick={onClose}
            className="rounded-md border border-[var(--color-border)] px-3 py-1 text-xs hover:bg-[var(--color-surface-2)]"
          >
            Cancel
          </button>
          <button
            onClick={handleCopy}
            disabled={!draft.trim() || loading}
            className="rounded-md border border-[var(--color-border)] px-3 py-1 text-xs hover:bg-[var(--color-surface-2)] disabled:cursor-not-allowed disabled:opacity-50"
            title="Copia el prompt al portapapeles"
          >
            {copied ? "Copied!" : "Copy prompt"}
          </button>
          {onSpawn && (
            <button
              onClick={handleSpawn}
              disabled={!draft.trim() || loading || spawning}
              className="rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)]/20 px-3 py-1 text-xs text-[var(--color-accent)] hover:bg-[var(--color-accent)]/30 disabled:cursor-not-allowed disabled:opacity-50"
              title="Lanza una nueva sesión Claude con este prompt"
            >
              {spawning ? "Spawning…" : "Spawn new Claude session"}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
