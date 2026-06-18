// Scope chips + category pills + enable tabs + search bar for the Agents view.

import type { LibraryViewMode } from "../library/ViewToggle";
import { SCOPES, AGENT_ACCENT_SOFT } from "./types";
import type { ScopeFilter, EnableFilter } from "./types";

interface EnableCounts {
  active: number;
  disabled: number;
}

interface AgentsFiltersProps {
  scope: ScopeFilter;
  category: string;
  categories: string[];
  enableFilter: EnableFilter;
  enableCounts: EnableCounts;
  query: string;
  view: LibraryViewMode;
  onScopeChange: (s: ScopeFilter) => void;
  onCategoryChange: (c: string) => void;
  onEnableFilterChange: (f: EnableFilter) => void;
  onQueryChange: (q: string) => void;
}

export function AgentsFilters({
  scope,
  category,
  categories,
  enableFilter,
  enableCounts,
  query,
  view,
  onScopeChange,
  onCategoryChange,
  onEnableFilterChange,
  onQueryChange,
}: AgentsFiltersProps) {
  return (
    <>
      {/* Active / Disabled / All tabs — same pill style as Skills.tsx */}
      <div
        className="inline-flex items-center gap-1 self-start rounded-lg p-1"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border)",
        }}
      >
        {(
          [
            { id: "active" as const, label: "Active", count: enableCounts.active },
            { id: "disabled" as const, label: "Disabled", count: enableCounts.disabled },
            { id: "all" as const, label: "All", count: enableCounts.active + enableCounts.disabled },
          ] as const
        ).map((tab) => {
          const isActive = enableFilter === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onEnableFilterChange(tab.id)}
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
                  background: isActive ? AGENT_ACCENT_SOFT : "var(--color-surface-3)",
                  color: isActive ? "#c4b5fd" : "var(--color-text-tertiary)",
                }}
              >
                {tab.count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Scope chips + Category pills — same structure as Skills.tsx */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          {SCOPES.map((s) => {
            const isActive = scope === s.id;
            return (
              <button
                key={s.id}
                onClick={() => onScopeChange(s.id)}
                className="rounded-full border px-3 py-1 text-xs transition-colors"
                style={{
                  borderColor: isActive ? "var(--color-accent)" : "var(--color-border-strong)",
                  background: isActive ? "var(--color-accent)" : "transparent",
                  color: isActive ? "var(--color-accent-text)" : "var(--color-text-secondary)",
                }}
              >
                {s.label}
              </button>
            );
          })}
        </div>

        {view !== "blocks" && categories.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className="text-[10.5px] uppercase tracking-wide"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Category
            </span>
            <button
              onClick={() => onCategoryChange("all")}
              className="rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors"
              style={{
                borderColor: category === "all" ? "var(--color-text)" : "var(--color-border-strong)",
                background: category === "all" ? "var(--color-surface-4)" : "transparent",
                color: category === "all" ? "var(--color-text)" : "var(--color-text-secondary)",
              }}
            >
              All
            </button>
            {categories.map((c) => {
              const active = c === category;
              return (
                <button
                  key={c}
                  onClick={() => onCategoryChange(c)}
                  className="rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors"
                  style={{
                    borderColor: active ? "var(--color-text)" : "var(--color-border-strong)",
                    background: active ? "var(--color-surface-4)" : "transparent",
                    color: active ? "var(--color-text)" : "var(--color-text-secondary)",
                  }}
                >
                  {c}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Search bar — identical to Skills/Rules */}
      <input
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Search agents — fuzzy + synonyms, ranked by relevance…"
        className="w-full rounded-md px-3 py-2 text-sm outline-none"
        style={{
          border: "1px solid var(--color-border-strong)",
          background: "var(--color-surface-2)",
          color: "var(--color-text)",
        }}
      />
    </>
  );
}
