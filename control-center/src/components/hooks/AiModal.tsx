export function AiModal({
  description,
  busy,
  onChange,
  onClose,
  onSubmit,
}: {
  description: string;
  busy: boolean;
  onChange: (v: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={onClose}
    >
      <div
        className="w-[560px] rounded-md border p-5 shadow-xl"
        style={{ borderColor: "var(--color-border)", background: "var(--color-surface-1)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 text-[15px] font-semibold">Add hook with AI</div>

        <div className="mb-3 text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          Describe in plain language what the hook should do. Claude opens a new session, drafts
          the JSON, and you paste the result back into "Add hook" to confirm.
        </div>

        <textarea
          value={description}
          onChange={(e) => onChange(e.target.value)}
          rows={6}
          placeholder="e.g. Before every Bash tool call, log the command being run to ~/.ultron/.tmp/bash-audit.jsonl"
          className="mb-3 w-full rounded px-2 py-1 text-[12px]"
          style={{
            background: "var(--color-surface-2)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border)",
          }}
        />

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-[12px]"
            style={{ background: "var(--color-surface-2)", color: "var(--color-text-secondary)" }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={busy || !description.trim()}
            className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
            style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
          >
            {busy ? "Opening..." : "Open Claude"}
          </button>
        </div>
      </div>
    </div>
  );
}
