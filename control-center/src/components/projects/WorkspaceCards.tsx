// Presentational pieces of the project workspace (ProjectWorkspace.tsx):
// the large action cards and the inline icons the workspace needs that are not
// in ./icons.

import type React from "react";

// ---------------------------------------------------------------------------
// Inline icons not in ./icons
// ---------------------------------------------------------------------------

export function UsageIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="6" y1="20" x2="6" y2="12" />
      <line x1="12" y1="20" x2="12" y2="5" />
      <line x1="18" y1="20" x2="18" y2="9" />
    </svg>
  );
}

export function ChevronLeft({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

export function CodeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// PrimaryCard — action tile of the project workspace: icon on the left,
// label (15 px) and subtitle (13 px, up to two lines) stacked; the full
// subtitle stays in the tooltip. Sized for 2560x1440 (repaso 2026-10-18):
// the kanban below gives up some height in exchange.
// ---------------------------------------------------------------------------

export interface PrimaryCardProps {
  icon: React.ReactNode;
  label: string;
  sub: string;
  tint: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}

export function PrimaryCard({
  icon,
  label,
  sub,
  tint,
  onClick,
  disabled = false,
  title,
}: PrimaryCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex min-h-[64px] items-center gap-3 rounded-lg px-3.5 py-2.5 text-left transition-colors disabled:opacity-40"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
        minWidth: 0,
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = "var(--color-surface-3)";
        e.currentTarget.style.borderColor = "var(--color-border-strong)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "var(--color-surface-2)";
        e.currentTarget.style.borderColor = "var(--color-border)";
      }}
    >
      {/* Icon pill */}
      <div
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md"
        style={{
          background: "var(--color-surface-1)",
          border: "1px solid var(--color-border)",
          color: tint,
        }}
      >
        {icon}
      </div>

      {/* Text */}
      <div className="min-w-0">
        <div
          className="truncate text-[15px] font-semibold leading-tight"
          style={{ color: "var(--color-text)" }}
        >
          {label}
        </div>
        <div
          className="mt-1 line-clamp-2 break-words text-[13px] leading-snug"
          title={sub}
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {sub}
        </div>
      </div>
    </button>
  );
}
