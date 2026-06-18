import type { SkillEntry } from "../../types";
import { Sparkle } from "../library/icons";
import { ToggleSwitch } from "./ToggleSwitch";
import { SKILL_ACCENT, SKILL_ACCENT_SOFT } from "./constants";

export interface SkillCardGridProps {
  items: SkillEntry[];
  selected: SkillEntry | null;
  selectMode: boolean;
  checked: Set<string>;
  toggleBusy: Set<string>;
  isEnabled: (s: SkillEntry) => boolean;
  onSelect: (s: SkillEntry) => void;
  onToggleChecked: (name: string) => void;
  onToggle: (s: SkillEntry) => void;
}

export function SkillCardGrid({
  items,
  selected,
  selectMode,
  checked,
  toggleBusy,
  isEnabled,
  onSelect,
  onToggleChecked,
  onToggle,
}: SkillCardGridProps) {
  return (
    <div
      className="grid gap-3"
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}
    >
      {items.map((s) => {
        const isActive = selected?.path === s.path;
        const enabled = isEnabled(s);
        const busy = toggleBusy.has(s.path);
        const isChecked = checked.has(s.name);
        const selectable = selectMode && s.origin === "global";

        return (
          <button
            key={`${s.origin}-${s.path}`}
            type="button"
            onClick={() => (selectable ? onToggleChecked(s.name) : onSelect(s))}
            className="group relative flex h-[140px] flex-col justify-between rounded-xl p-4 text-left transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
            style={{
              background: isActive ? "var(--color-surface-3)" : "var(--color-surface-2)",
              border: `1px solid ${
                selectable && isChecked ? SKILL_ACCENT : isActive ? SKILL_ACCENT : "var(--color-border)"
              }`,
              boxShadow: `inset 0 3px 0 ${SKILL_ACCENT}`,
              opacity: enabled ? 1 : 0.55,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = SKILL_ACCENT;
              e.currentTarget.style.transform = "translateY(-2px)";
              e.currentTarget.style.boxShadow = `inset 0 3px 0 ${SKILL_ACCENT}, 0 6px 18px rgba(0,0,0,0.28)`;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor =
                selectable && isChecked ? SKILL_ACCENT : isActive ? SKILL_ACCENT : "var(--color-border)";
              e.currentTarget.style.transform = "translateY(0)";
              e.currentTarget.style.boxShadow = `inset 0 3px 0 ${SKILL_ACCENT}`;
            }}
            title={s.description || s.name}
          >
            {/* Bulk-select checkbox overlay (only in select mode, global skills) */}
            {selectMode && (
              <input
                type="checkbox"
                checked={isChecked}
                disabled={s.origin !== "global"}
                onChange={() => onToggleChecked(s.name)}
                onClick={(e) => e.stopPropagation()}
                aria-label={`Select ${s.name}`}
                className="absolute right-2 top-2 h-4 w-4"
                style={{ accentColor: "#38bdf8", cursor: s.origin === "global" ? "pointer" : "not-allowed" }}
              />
            )}
            {/* Header row: label chip + toggle */}
            <div className="flex items-center justify-between gap-1.5">
              <div
                className="flex items-center gap-1 text-[10.5px] uppercase tracking-[0.08em]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                <Sparkle size={12} />
                Skill
              </div>
              <div className="flex items-center gap-1.5">
                {busy && (
                  <span
                    className="text-[9px]"
                    style={{ color: "var(--color-text-faint)" }}
                  >
                    …
                  </span>
                )}
                <ToggleSwitch
                  enabled={enabled}
                  busy={busy}
                  readonly={s.origin !== "global"}
                  onToggle={() => onToggle(s)}
                />
              </div>
            </div>

            {/* Skill name */}
            <div
              className="line-clamp-3 text-[18px] font-semibold leading-tight tracking-tight"
              style={{ color: enabled ? "var(--color-text)" : "var(--color-text-secondary)" }}
            >
              {s.name}
            </div>

            {/* Footer: origin badge */}
            <div className="flex items-center justify-between">
              <span
                className="rounded px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide"
                style={{
                  background: SKILL_ACCENT_SOFT,
                  color: "#67e8f9",
                  border: "1px solid rgba(56, 189, 248, 0.35)",
                }}
              >
                {s.origin}
              </span>
              {!enabled && (
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
      })}
    </div>
  );
}
