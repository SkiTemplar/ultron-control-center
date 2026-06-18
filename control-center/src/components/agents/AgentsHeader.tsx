// Page header for the Agents view — mirrors Skills.tsx header structure.

import { Plus } from "../library/icons";
import { ViewToggle } from "../library/ViewToggle";
import type { LibraryViewMode } from "../library/ViewToggle";
import { AGENT_ACCENT, AGENT_ACCENT_SOFT } from "./types";

interface AgentsHeaderProps {
  totalCount: number;
  filteredCount: number;
  view: LibraryViewMode;
  selectMode: boolean;
  onViewChange: (mode: LibraryViewMode) => void;
  onCreateOpen: () => void;
  onToggleSelectMode: () => void;
  onReload: () => void;
}

export function AgentsHeader({
  totalCount,
  filteredCount,
  view,
  selectMode,
  onViewChange,
  onCreateOpen,
  onToggleSelectMode,
  onReload,
}: AgentsHeaderProps) {
  return (
    <header className="flex items-center justify-between gap-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-lg font-semibold">Agents</h2>
        <span className="text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          ~/.claude/agents/**/*.md · {filteredCount} of {totalCount}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <ViewToggle mode={view} onChange={onViewChange} />
        <button
          onClick={onCreateOpen}
          className="inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium"
          style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
        >
          <Plus size={12} /> New agent
        </button>
        <button
          onClick={onToggleSelectMode}
          className="rounded-md border px-3 py-1 text-xs"
          style={{
            borderColor: selectMode ? AGENT_ACCENT : "var(--color-border-strong)",
            background: selectMode ? AGENT_ACCENT_SOFT : "var(--color-surface-2)",
            color: selectMode ? "#c4b5fd" : "var(--color-text)",
          }}
          title="Toggle multi-select mode to bulk enable/disable global agents"
        >
          {selectMode ? "Done selecting" : "Select"}
        </button>
        <button
          onClick={onReload}
          className="rounded-md border px-3 py-1 text-xs"
          style={{
            borderColor: "var(--color-border-strong)",
            background: "var(--color-surface-2)",
            color: "var(--color-text)",
          }}
        >
          Refresh
        </button>
      </div>
    </header>
  );
}
