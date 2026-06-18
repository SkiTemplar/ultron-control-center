// Diagnostics — Recent Fixes Panel

import type { FixHistoryEntry } from "./types";

export function RecentFixesPanel({
  entries,
  onClear,
}: {
  entries: FixHistoryEntry[];
  onClear: () => void;
}) {
  const shown = entries.slice(0, 10);
  return (
    <section
      className="rounded"
      style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
    >
      <header
        className="flex items-center justify-between px-3 py-2"
        style={{ background: "var(--color-surface-1)", borderBottom: "1px solid var(--color-border)" }}
      >
        <div className="text-[13px] font-semibold" style={{ color: "var(--color-text)" }}>
          Recent fixes
        </div>
        <button
          type="button"
          onClick={onClear}
          className="text-[11px] transition-colors hover:underline"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Clear
        </button>
      </header>
      <ul className="divide-y" style={{ borderColor: "var(--color-border)" }}>
        {shown.map((entry, i) => (
          <li key={i} className="flex items-center gap-3 px-3 py-1.5">
            <span
              className="shrink-0 text-[11px]"
              style={{ color: entry.success ? "var(--color-success, #3fb950)" : "var(--color-danger)" }}
            >
              {entry.success ? "OK" : "FAIL"}
            </span>
            <span className="flex-1 truncate text-[12px]" style={{ color: "var(--color-text)" }}>
              {entry.label}
            </span>
            {entry.error_id && (
              <span className="shrink-0 truncate text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
                {entry.error_id}
              </span>
            )}
            <span className="shrink-0 tabular-nums text-[11px]" style={{ color: "var(--color-text-faint, var(--color-text-tertiary))" }}>
              {new Date(entry.ts).toLocaleTimeString()}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
