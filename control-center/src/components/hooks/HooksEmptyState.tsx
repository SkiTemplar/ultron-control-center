import { eventColors } from "./constants";

export function HooksEmptyState({ onAdd, onAi }: { onAdd: () => void; onAi: () => void }) {
  return (
    <div
      className="rounded p-5"
      style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
    >
      <div className="mb-1 text-[14px] font-semibold" style={{ color: "var(--color-text)" }}>
        No hooks configured
      </div>
      <p
        className="mb-4 text-[12px] leading-relaxed"
        style={{ color: "var(--color-text-secondary)" }}
      >
        Hooks are shell commands Claude Code runs around tool calls and session lifecycle events.
        They live in{" "}
        <code style={{ fontFamily: "var(--font-mono)" }}>~/.claude/settings.json</code> under the{" "}
        <code style={{ fontFamily: "var(--font-mono)" }}>hooks</code> key.
      </p>
      <div className="mb-4 grid grid-cols-1 gap-2 md:grid-cols-3">
        {(["PreToolUse", "PostToolUse", "Stop"] as const).map((ev) => {
          const colors = eventColors(ev);
          const desc: Record<string, string> = {
            PreToolUse: "Before a tool runs. Exit 2 to block. Good for command audits and policy checks.",
            PostToolUse: "After a tool succeeds. Good for auto-format, lint, dependency updates.",
            Stop: "When Claude finishes responding. Good for end-of-session checks (debug statements, dirty git tree).",
          };
          return (
            <div
              key={ev}
              className="rounded p-2.5"
              style={{
                background: "var(--color-surface-1)",
                border: "1px solid var(--color-border)",
                boxShadow: `inset 0 3px 0 ${colors.ribbon}`,
              }}
            >
              <div
                className="mb-1 inline-block rounded px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide"
                style={{ background: colors.chipBg, color: colors.chipFg }}
              >
                {ev}
              </div>
              <div
                className="text-[11.5px] leading-snug"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {desc[ev]}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onAdd}
          className="rounded px-3 py-1.5 text-[12px] font-medium"
          style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
        >
          Add your first hook
        </button>
        <button
          type="button"
          onClick={onAi}
          className="rounded px-3 py-1.5 text-[12px] font-medium"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
          }}
          title="Describe what you want in plain English; Claude drafts the JSON"
        >
          Add with AI
        </button>
      </div>
    </div>
  );
}
