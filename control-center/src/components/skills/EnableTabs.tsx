import type { EnableFilter } from "./types";
import { SKILL_ACCENT_SOFT } from "./constants";

export interface EnableTabsProps {
  value: EnableFilter;
  onChange: (v: EnableFilter) => void;
  activeCount: number;
  disabledCount: number;
}

export function EnableTabs({ value, onChange, activeCount, disabledCount }: EnableTabsProps) {
  const tabs: { id: EnableFilter; label: string; count: number }[] = [
    { id: "active", label: "Active", count: activeCount },
    { id: "disabled", label: "Disabled", count: disabledCount },
    { id: "all", label: "All", count: activeCount + disabledCount },
  ];

  return (
    <div
      className="flex items-center gap-1 rounded-lg p-1"
      style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
    >
      {tabs.map((tab) => {
        const isActive = value === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            className="flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium transition-colors"
            style={{
              background: isActive ? "var(--color-surface-4)" : "transparent",
              color: isActive ? "var(--color-text)" : "var(--color-text-secondary)",
              border: isActive ? "1px solid var(--color-border-strong)" : "1px solid transparent",
            }}
          >
            {tab.label}
            <span
              className="rounded-full px-1.5 py-px text-[10px] font-semibold tabular-nums"
              style={{
                background: isActive ? SKILL_ACCENT_SOFT : "var(--color-surface-3)",
                color: isActive ? "#67e8f9" : "var(--color-text-tertiary)",
              }}
            >
              {tab.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
