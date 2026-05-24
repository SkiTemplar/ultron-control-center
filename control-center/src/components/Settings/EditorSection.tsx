import { JsonVisualEditor } from "../JsonVisualEditor";

// ---------------------------------------------------------------------------
// JSON editor — thin wrapper over JsonVisualEditor. The Raw JSON textarea +
// Codex assist + schema validator were removed in v15.2 F9 UX: the visual
// form is now the only mode (simpler UX, no toggle, no stale buffer).
// Edits propagate up through the normal Save flow (timestamped backup,
// atomic write).
// ---------------------------------------------------------------------------

export function JsonEditor({
  obj,
  onChange,
}: {
  obj: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  return (
    <div className="space-y-3">
      <div
        className="text-[11.5px]"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Editable copy of <span style={{ fontFamily: "var(--font-mono)" }}>~/.claude/settings.json</span> · any change takes effect when you click Save (automatic backup)
      </div>
      <JsonVisualEditor obj={obj} onChange={onChange} />
    </div>
  );
}
