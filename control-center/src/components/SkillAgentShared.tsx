// Shared UI primitives for the Skills and Agents tabs.
//
// Why: the two tabs intentionally render the same chrome — same row
// layout, same filter pill, same header buttons — because Skills and
// Agents are the same shape of object (markdown with frontmatter, both
// running through the same prompt-injection scanner). Keeping a single
// source of truth for these primitives means a fix in Skills lands in
// Agents for free and the two tabs cannot drift visually.
//
// Scope: only the *generic* widgets live here. Row content that depends
// on the underlying type (state badge for Skills, model badge for
// Agents) stays in the caller via render-props, so we don't ship a
// god-component with a `kind: "skill" | "agent"` switch.

import type { CSSProperties, ReactNode } from "react";
import { securityHintFromInfo } from "./SecurityPanel";

// ---------------------------------------------------------------------------
// HeaderBtn — compact button used in the Preview header (Edit / AI /
// Security / Delete / Cancel / Save / etc). Default + danger variants.
// ---------------------------------------------------------------------------

export function HeaderBtn({
  label,
  onClick,
  disabled,
  variant = "default",
  title,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: "default" | "danger";
  title?: string;
}) {
  const danger = variant === "danger";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="rounded px-2 py-1 text-[11.5px] transition-colors disabled:opacity-40"
      style={{
        background: "var(--color-surface-2)",
        color: danger ? "var(--color-danger)" : "var(--color-text-secondary)",
        border: `1px solid ${
          danger ? "rgba(248, 81, 73, 0.32)" : "var(--color-border-strong)"
        }`,
      }}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Pill — filter chip used in the list header (Active / Plugin / Quarantined…)
// ---------------------------------------------------------------------------

export function Pill({
  active,
  label,
  count,
  onClick,
  color,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
  color?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded px-2.5 py-1 text-[11.5px] transition-colors"
      style={{
        background: active ? "var(--color-surface-3)" : "transparent",
        color: active ? "var(--color-text)" : "var(--color-text-tertiary)",
        border: `1px solid ${active ? "var(--color-border-strong)" : "var(--color-border)"}`,
      }}
    >
      {color && (
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: color, opacity: active ? 1 : 0.4 }}
        />
      )}
      <span>{label}</span>
      <span
        className="tabular-nums"
        style={{ color: active ? "var(--color-text-secondary)" : "var(--color-text-faint)" }}
      >
        {count}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// SkillAgentRow — list row shared between the Skills and Agents tabs.
//
// The container, hover/select treatment, security hint badge, name +
// description block are all identical between the two tabs (they look
// the same at 12 px and would diverge by accident if we kept two
// copies). The differences are concentrated in two slots:
//
//   - `leftBadge` : the kind-specific pill on the left (state for
//                    Skills, hardcoded "agent" for Agents).
//   - `rightMeta` : the trailing meta (usage count for Skills, model
//                    pill for Agents).
//
// Anything else that needs to diverge later (e.g. a `tools` chip strip
// in Agents) can be appended via `extra` without touching the shared
// surface. The component is deliberately small — it's primitive enough
// that "shared row" doesn't become "shared list".
// ---------------------------------------------------------------------------

export function SkillAgentRow({
  name,
  description,
  selected,
  onClick,
  security,
  leftBadge,
  rightMeta,
}: {
  name: string;
  description?: string | null;
  selected: boolean;
  onClick: () => void;
  security: Parameters<typeof securityHintFromInfo>[0];
  leftBadge: ReactNode;
  rightMeta?: ReactNode;
}) {
  const sec = securityHintFromInfo(security ?? null);
  const baseStyle: CSSProperties = {
    background: selected ? "var(--color-surface-3)" : "transparent",
    border: `1px solid ${selected ? "var(--color-border-strong)" : "transparent"}`,
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-baseline gap-3 rounded px-3 py-2 text-left transition-colors"
      style={baseStyle}
      onMouseEnter={(e) => {
        if (!selected)
          (e.currentTarget as HTMLButtonElement).style.background =
            "var(--color-surface-2)";
      }}
      onMouseLeave={(e) => {
        if (!selected)
          (e.currentTarget as HTMLButtonElement).style.background = "transparent";
      }}
    >
      {leftBadge}
      {sec && (
        <span
          className="shrink-0 rounded px-1.5 py-px text-[10px] font-medium tabular-nums"
          style={{ background: sec.bg, color: sec.color }}
          title={sec.title}
        >
          {sec.label}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div
          className="truncate text-[12.5px] font-medium"
          style={{ color: "var(--color-text)" }}
        >
          {name}
        </div>
        {description && (
          <div
            className="truncate text-[11.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {description}
          </div>
        )}
      </div>
      {rightMeta}
    </button>
  );
}

// ---------------------------------------------------------------------------
// KindBadge — small left-side pill rendered before the name.
//
// Convenience wrapper so callers don't have to repeat the same span
// markup in every Row implementation. `minWidth` defaults to 56 px so
// rows align vertically across short ("agent") and long ("quarantine")
// labels.
// ---------------------------------------------------------------------------

export function KindBadge({
  label,
  bg,
  color,
  minWidth = 56,
}: {
  label: string;
  bg: string;
  color: string;
  minWidth?: number;
}) {
  return (
    <span
      className="shrink-0 rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide tabular-nums"
      style={{ background: bg, color, minWidth, textAlign: "center" }}
    >
      {label}
    </span>
  );
}
