// Shared Card wrapper for Dashboard widgets.
//
// Every Dashboard card follows the same skeleton: a title row, optional
// right-aligned action chip, a body that handles loading/error/empty
// states uniformly, and a coloured left-border accent driven by `accent`.
//
// v2.7 FULL REDESIGN: dashboard cards are now visually larger.
//   - `size="lg"` bumps padding, title size, and minHeight so the most
//     important cards (Mem0, Pending, Backup, Recent*, Crash) feel like
//     first-class panels rather than mini-widgets.
//   - Title is no longer uppercase micro-text. The new baseline is 14px
//     semibold (sentence case) so titles read like section headings.
//   - Body baseline bumps from 11.5px to 13px to match the new content
//     density target. Timestamps (tabular-nums) stay at 11px.

import type { ReactNode } from "react";

export type CardAccent = "neutral" | "ok" | "warn" | "danger";
export type CardSize = "md" | "lg";

const ACCENT_COLOR: Record<CardAccent, string> = {
  neutral: "var(--color-border-strong)",
  ok: "var(--color-success)",
  warn: "var(--color-warn)",
  danger: "var(--color-danger)",
};

interface CardProps {
  title: string;
  subtitle?: string;
  accent?: CardAccent;
  size?: CardSize;
  action?: ReactNode;
  loading?: boolean;
  error?: string | null;
  empty?: string | null;
  children?: ReactNode;
}

export function Card({
  title,
  subtitle,
  accent = "neutral",
  size = "lg",
  action,
  loading,
  error,
  empty,
  children,
}: CardProps) {
  const isLarge = size === "lg";
  const padX = isLarge ? "px-5" : "px-4";
  const padTop = isLarge ? "pt-4" : "pt-3";
  const padBottom = isLarge ? "pb-4" : "pb-3";
  const minHeight = isLarge ? 180 : 120;
  const titleClass = isLarge
    ? "text-[14.5px] font-semibold leading-tight"
    : "text-[11.5px] font-medium uppercase tracking-[0.08em]";
  const titleColor = isLarge
    ? "var(--color-text)"
    : "var(--color-text-tertiary)";

  return (
    <div
      className="flex flex-col rounded-md"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
        borderLeft: `3px solid ${ACCENT_COLOR[accent]}`,
        minHeight,
      }}
    >
      <div className={`flex items-start justify-between ${padX} ${padTop}`}>
        <div className="min-w-0 flex-1">
          <h3 className={titleClass} style={{ color: titleColor }}>
            {title}
          </h3>
          {subtitle && (
            <p
              className="mt-0.5 truncate text-[11.5px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {subtitle}
            </p>
          )}
        </div>
        {action && <div className="ml-3 shrink-0">{action}</div>}
      </div>
      <div className={`flex-1 ${padX} ${padBottom} pt-3`}>
        {loading ? (
          <div
            className="text-[13px]"
            style={{ color: "var(--color-text-faint)" }}
          >
            Loading...
          </div>
        ) : error ? (
          <div
            className="rounded p-2 text-[12px]"
            style={{
              background: "rgba(248, 81, 73, 0.06)",
              border: "1px solid rgba(248, 81, 73, 0.22)",
              color: "var(--color-danger)",
              fontFamily: "var(--font-mono, ui-monospace)",
            }}
          >
            {error}
          </div>
        ) : empty ? (
          <div
            className="text-[13px]"
            style={{ color: "var(--color-text-faint)" }}
          >
            {empty}
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

interface SmallButtonProps {
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  variant?: "neutral" | "accent";
  size?: "sm" | "md";
  children: ReactNode;
}

export function SmallButton({
  onClick,
  disabled,
  title,
  variant = "neutral",
  size = "sm",
  children,
}: SmallButtonProps) {
  const accent = variant === "accent";
  const sizeClass =
    size === "md"
      ? "rounded px-3 py-1 text-[12.5px] font-medium"
      : "rounded px-2 py-0.5 text-[11.5px] font-medium";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`${sizeClass} transition-colors disabled:opacity-50`}
      style={{
        background: accent ? "var(--color-accent)" : "var(--color-surface-3)",
        color: accent ? "var(--color-accent-text)" : "var(--color-text)",
        border: accent
          ? "1px solid var(--color-accent)"
          : "1px solid var(--color-border-strong)",
      }}
    >
      {children}
    </button>
  );
}

// Small relative-time helper duplicated across cards.
export function relativeTime(iso?: string | null): string {
  if (!iso) return "never";
  const ts = new Date(iso);
  if (Number.isNaN(ts.getTime())) return iso;
  const diff = Date.now() - ts.getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
