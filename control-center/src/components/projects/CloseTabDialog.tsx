// ULTRON Control Center 2.0 — Confirm dialog when closing a project tab with live PTYs.

import { AlertTriangle } from "./icons";
import type { PtySessionSummary } from "../../types";

type Props = {
  sessions: PtySessionSummary[];
  onCancel: () => void;
  onBackground: () => void;
  onKill: () => void;
};

export default function CloseTabDialog({
  sessions,
  onCancel,
  onBackground,
  onKill,
}: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5 shadow-xl">
        <div className="mb-3 flex items-center gap-2">
          <AlertTriangle size={16} className="text-[var(--color-warn)]" />
          <h2 className="text-sm font-semibold">Active sessions detected</h2>
        </div>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          This project has {sessions.length} live PTY session
          {sessions.length === 1 ? "" : "s"}. Choose how to proceed:
        </p>
        <ul className="mb-4 max-h-32 overflow-y-auto rounded border border-[var(--color-border)] bg-[var(--color-surface-0)] p-2 text-xs">
          {sessions.map((s) => (
            <li key={s.id} className="flex items-center justify-between py-0.5">
              <span className="font-mono">{s.id.slice(-12)}</span>
              <span className="text-[var(--color-text-muted)]">
                {s.provider}
                {s.card_id ? ` · card ${s.card_id.slice(-6)}` : ""}
              </span>
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md border border-[var(--color-border)] px-3 py-1 text-xs hover:bg-[var(--color-surface-2)]"
          >
            Cancel
          </button>
          <button
            onClick={onBackground}
            className="rounded-md border border-[var(--color-border)] px-3 py-1 text-xs hover:bg-[var(--color-surface-2)]"
          >
            Background
          </button>
          <button
            onClick={onKill}
            className="rounded-md border border-[var(--color-error)] bg-[var(--color-error)]/20 px-3 py-1 text-xs text-[var(--color-error)] hover:bg-[var(--color-error)]/30"
          >
            Kill all
          </button>
        </div>
      </div>
    </div>
  );
}
