// Single agent card — 140px tall violet inset ribbon card.

import type { AgentEntry } from "../../types";
import { Bot } from "../library/icons";
import { AGENT_ACCENT, AGENT_ACCENT_SOFT, NO_CATEGORY } from "./types";
import { deriveCategory } from "./helpers";

interface AgentCardProps {
  agent: AgentEntry;
  isActive: boolean;
  selectMode: boolean;
  isChecked: boolean;
  onSelect: (a: AgentEntry) => void;
  onToggleChecked: (name: string) => void;
}

export function AgentCard({
  agent: a,
  isActive,
  selectMode,
  isChecked,
  onSelect,
  onToggleChecked,
}: AgentCardProps) {
  const cat = deriveCategory(a);
  const selectable = selectMode && a.origin === "global";

  return (
    <button
      key={`${a.origin}-${a.path}`}
      type="button"
      onClick={() => (selectable ? onToggleChecked(a.name) : onSelect(a))}
      className="group relative flex h-[140px] flex-col justify-between rounded-xl p-4 text-left transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
      style={{
        background: isActive ? "var(--color-surface-3)" : "var(--color-surface-2)",
        border: `1px solid ${
          selectable && isChecked ? AGENT_ACCENT : isActive ? AGENT_ACCENT : "var(--color-border)"
        }`,
        boxShadow: `inset 0 3px 0 ${AGENT_ACCENT}`,
        opacity: a.enabled ? 1 : 0.55,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = AGENT_ACCENT;
        e.currentTarget.style.transform = "translateY(-2px)";
        e.currentTarget.style.boxShadow = `inset 0 3px 0 ${AGENT_ACCENT}, 0 6px 18px rgba(0,0,0,0.28)`;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor =
          selectable && isChecked ? AGENT_ACCENT : isActive ? AGENT_ACCENT : "var(--color-border)";
        e.currentTarget.style.transform = "translateY(0)";
        e.currentTarget.style.boxShadow = `inset 0 3px 0 ${AGENT_ACCENT}`;
      }}
      title={a.description || a.name}
    >
      {/* Bulk-select checkbox overlay (select mode, global agents) */}
      {selectMode && (
        <input
          type="checkbox"
          checked={isChecked}
          disabled={a.origin !== "global"}
          onChange={() => onToggleChecked(a.name)}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Select ${a.name}`}
          className="absolute right-2 top-2 h-4 w-4"
          style={{ accentColor: "#a78bfa", cursor: a.origin === "global" ? "pointer" : "not-allowed" }}
        />
      )}
      {/* Header row: label chip + origin badge */}
      <div className="flex items-center justify-between gap-1.5">
        <div
          className="flex items-center gap-1 text-[10.5px] uppercase tracking-[0.08em]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          <Bot size={12} />
          Agent
        </div>
        <span
          className="rounded px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide"
          style={{
            background: AGENT_ACCENT_SOFT,
            color: "#c4b5fd",
            border: "1px solid rgba(167, 139, 250, 0.35)",
          }}
        >
          {cat !== NO_CATEGORY ? cat : a.origin}
        </span>
      </div>

      {/* Agent name */}
      <div
        className="line-clamp-3 text-[18px] font-semibold leading-tight tracking-tight"
        style={{ color: a.enabled ? "var(--color-text)" : "var(--color-text-secondary)" }}
      >
        {a.name}
      </div>

      {/* Footer: origin badge + disabled label */}
      <div className="flex items-center justify-between">
        <span
          className="rounded px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide"
          style={{
            background: AGENT_ACCENT_SOFT,
            color: "#c4b5fd",
            border: "1px solid rgba(167, 139, 250, 0.35)",
          }}
        >
          {a.origin}
        </span>
        {!a.enabled && (
          <span
            className="text-[9.5px] uppercase tracking-wide"
            style={{ color: "var(--color-text-faint)" }}
          >
            disabled
          </span>
        )}
      </div>
    </button>
  );
}
