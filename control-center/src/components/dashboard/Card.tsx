// Shared Card wrapper for Dashboard widgets.
//
// Every Dashboard card follows the same skeleton: a small uppercase title,
// optional right-aligned action chip, a body that handles loading/error/empty
// states uniformly, and a coloured left-border accent driven by `accent`.

import type { ReactNode } from "react";

export type CardAccent = "neutral" | "ok" | "warn" | "danger";

const ACCENT_COLOR: Record<CardAccent, string> = {
  neutral: "var(--color-border-strong)",
  ok: "var(--color-success)",
  warn: "var(--color-warn)",
  danger: "var(--color-danger)",
};

interface CardProps {
  title: string;
  accent?: CardAccent;
  action?: ReactNode;
  loading?: boolean;
  error?: string | null;
  empty?: string | null;
  children?: ReactNode;
}

export function Card({
  title,
  accent = "neutral",
  action,
  loading,
  error,
  empty,
  children,
}: CardProps) {
  return (
    <div
      className="flex flex-col rounded-md"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
        borderLeft: `3px solid ${ACCENT_COLOR[accent]}`,
        minHeight: 120,
      }}
    >
      <div className="flex items-center justify-between px-4 pt-3">
        <h3
          className="text-[10.5px] font-medium uppercase tracking-[0.08em]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {title}
        </h3>
        {action}
      </div>
      <div className="flex-1 px-4 pb-3 pt-2">
        {loading ? (
          <div
            className="text-[12px]"
            style={{ color: "var(--color-text-faint)" }}
          >
            Loading...
          </div>
        ) : error ? (
          <div
            className="rounded p-2 text-[11.5px]"
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
            className="text-[12px]"
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
  children: ReactNode;
}

export function SmallButton({
  onClick,
  disabled,
  title,
  variant = "neutral",
  children,
}: SmallButtonProps) {
  const accent = variant === "accent";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="rounded px-2 py-0.5 text-[10.5px] font-medium transition-colors disabled:opacity-50"
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
