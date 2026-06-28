// Diagnostics — Solve with AI modal

import { FIX_CATALOG } from "./catalogs";

export function SolveWithAiModal({
  problem, onProblemChange, sending, error, eventsCount, hasReport, onCancel, onSend,
}: {
  problem: string; onProblemChange: (v: string) => void; sending: boolean; error: string | null;
  eventsCount: number; hasReport: boolean; onCancel: () => void; onSend: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={onCancel}>
      <div className="w-full max-w-lg rounded p-4"
        style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
        onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 text-[14px] font-semibold" style={{ color: "var(--color-text)" }}>Solve with AI</div>
        <div className="mb-3 text-[12px] leading-snug" style={{ color: "var(--color-text-tertiary)" }}>
          Describe the problem. Claude will be spawned with the current diagnostic snapshot ({eventsCount} recent events
          {hasReport ? ", App health" : ""}, {Object.keys(FIX_CATALOG).length} available fixes).
        </div>
        <textarea
          value={problem}
          onChange={(e) => onProblemChange(e.target.value)}
          placeholder="e.g. Qdrant fails to start, Claude session spawns then dies immediately..."
          rows={5}
          className="w-full rounded p-2 text-[12.5px]"
          style={{ background: "var(--color-surface-1)", color: "var(--color-text)", border: "1px solid var(--color-border)", outline: "none", resize: "vertical" }}
          autoFocus
        />
        {error && (
          <div className="mt-2 rounded px-2 py-1.5 text-[12px]"
            style={{ background: "rgba(248,81,73,0.10)", border: "1px solid rgba(248,81,73,0.30)", color: "var(--color-danger)" }}>
            {error}
          </div>
        )}
        <div className="mt-3 flex justify-end gap-1.5">
          <button type="button" onClick={onCancel} disabled={sending}
            className="rounded px-2.5 py-1 text-[12px] font-medium transition-colors disabled:opacity-50"
            style={{ background: "var(--color-surface-3)", color: "var(--color-text)", border: "1px solid var(--color-border-strong)" }}>
            Cancel
          </button>
          <button type="button" onClick={onSend} disabled={sending}
            className="rounded px-3 py-1 text-[12px] font-medium transition-colors disabled:opacity-50"
            style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}>
            {sending ? "Spawning..." : "Send to Claude"}
          </button>
        </div>
      </div>
    </div>
  );
}
