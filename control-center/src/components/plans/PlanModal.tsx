// PlanModal — create / edit plan dialog.
// Extracted from Plans.tsx as part of the cat7 split refactor.

import { PRIORITY_OPTIONS, KIND_OPTIONS } from "./types";
import type { PlanFormState } from "./types";

export function PlanModal({
  state,
  busy,
  error,
  onChange,
  onSubmit,
  onClose,
}: {
  state: PlanFormState;
  busy: boolean;
  error: string | null;
  onChange: (next: PlanFormState) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-6"
      style={{ background: "rgba(0,0,0,0.55)" }}
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-[560px] flex-col overflow-hidden rounded"
        style={{
          background: "var(--color-surface-1)",
          border: "1px solid var(--color-border-strong)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <header
          className="flex items-center justify-between border-b px-5 py-3"
          style={{ borderColor: "var(--color-border)" }}
        >
          <h2 className="text-[14px] font-semibold">
            {state.id ? `Edit plan: ${state.id}` : "New plan"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-0.5 text-[12px]"
            style={{ color: "var(--color-text-tertiary)" }}
            aria-label="Close"
          >
            close
          </button>
        </header>
        <div className="flex-1 space-y-3 overflow-auto px-5 py-4">
          <div>
            <label
              className="mb-1 block text-[10px] font-medium uppercase tracking-wide"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Title
            </label>
            <input
              type="text"
              value={state.title}
              onChange={(e) => onChange({ ...state, title: e.target.value })}
              placeholder="Short, imperative title"
              className="w-full rounded px-2.5 py-1.5 text-[12.5px]"
              style={{
                background: "var(--color-surface-2)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
                outline: "none",
              }}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label
                className="mb-1 block text-[10px] font-medium uppercase tracking-wide"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                Priority
              </label>
              <select
                value={state.priority}
                onChange={(e) => onChange({ ...state, priority: e.target.value })}
                className="w-full rounded px-2 py-1.5 text-[12.5px]"
                style={{
                  background: "var(--color-surface-2)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border-strong)",
                }}
              >
                {PRIORITY_OPTIONS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                className="mb-1 block text-[10px] font-medium uppercase tracking-wide"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                Kind
              </label>
              <select
                value={state.kind}
                onChange={(e) => onChange({ ...state, kind: e.target.value })}
                className="w-full rounded px-2 py-1.5 text-[12.5px]"
                style={{
                  background: "var(--color-surface-2)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border-strong)",
                }}
              >
                {KIND_OPTIONS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label
              className="mb-1 block text-[10px] font-medium uppercase tracking-wide"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Tags (comma-separated)
            </label>
            <input
              type="text"
              value={state.tags}
              onChange={(e) => onChange({ ...state, tags: e.target.value })}
              placeholder="release, refactor, infra"
              className="w-full rounded px-2.5 py-1.5 text-[12.5px]"
              style={{
                background: "var(--color-surface-2)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
                outline: "none",
              }}
            />
          </div>
          <div>
            <label
              className="mb-1 block text-[10px] font-medium uppercase tracking-wide"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Description
            </label>
            <textarea
              value={state.description}
              onChange={(e) => onChange({ ...state, description: e.target.value })}
              spellCheck={false}
              className="w-full rounded p-2.5 text-[12px] leading-relaxed"
              style={{
                fontFamily: "var(--font-mono)",
                background: "var(--color-surface-2)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
                outline: "none",
                minHeight: 160,
                resize: "vertical",
              }}
            />
          </div>
          {error && (
            <div
              className="rounded p-2 text-[11.5px]"
              style={{
                background: "rgba(248, 81, 73, 0.06)",
                border: "1px solid rgba(248, 81, 73, 0.22)",
                color: "var(--color-danger)",
              }}
            >
              {error}
            </div>
          )}
        </div>
        <footer
          className="flex items-center justify-end gap-2 border-t px-5 py-3"
          style={{ borderColor: "var(--color-border)" }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded px-3 py-1.5 text-[12px]"
            style={{
              background: "transparent",
              color: "var(--color-text-tertiary)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={busy || !state.title.trim()}
            className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-40"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            {busy ? "Saving..." : state.id ? "Save" : "Create"}
          </button>
        </footer>
      </div>
    </div>
  );
}
