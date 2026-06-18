// Trigger button for BatchDropdown — renders either a card-style or
// header/inline-style button that toggles the dropdown panel.

import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";

type TriggerButtonProps = {
  open: boolean;
  onToggle: () => void;
  runningName: string | null;
  count: number;
  queueCount: number;
  headerStyle: boolean;
  cardStyle: boolean;
};

export function TriggerButton({
  open,
  onToggle,
  runningName,
  count,
  queueCount,
  headerStyle,
  cardStyle,
}: TriggerButtonProps) {
  if (cardStyle) {
    return (
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full flex-col gap-3 rounded-lg p-4 text-left transition-colors"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border)",
          minHeight: 88,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--color-surface-3)";
          e.currentTarget.style.borderColor = "var(--color-border-strong)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "var(--color-surface-2)";
          e.currentTarget.style.borderColor = "var(--color-border)";
        }}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Ejecutar un script de ~/.ultron/batches/"
      >
        <div
          className="flex h-8 w-8 items-center justify-center rounded-md"
          style={{
            background: "var(--color-surface-1)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-secondary)",
          }}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
        </div>
        <div>
          <div className="flex items-center gap-1.5">
            <span
              className="text-[13px] font-semibold"
              style={{ color: "var(--color-text)" }}
            >
              {runningName ? `Ejecutando: ${runningName}` : "Run Batch"}
            </span>
            {queueCount > 0 && (
              <span
                className="rounded px-1 text-[10px] font-semibold tabular-nums"
                style={{
                  background: "rgba(248,81,73,0.14)",
                  color: "var(--color-danger)",
                  border: "1px solid rgba(248,81,73,0.35)",
                }}
              >
                {queueCount}
              </span>
            )}
          </div>
          <div
            className="mt-0.5 text-[11px] leading-snug"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {count > 0
              ? `${count} script${count === 1 ? "" : "s"} disponible${count === 1 ? "" : "s"}`
              : "Sin scripts en cola"}
          </div>
        </div>
      </button>
    );
  }

  const triggerClassName = headerStyle
    ? "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-40"
    : "flex items-center gap-1.5 rounded px-3 py-1.5 text-[12px] transition-colors disabled:opacity-50";

  const triggerStyle = headerStyle
    ? ({
        borderColor: "rgba(255,255,255,0.10)",
        background: "transparent",
        color: "var(--color-text-muted)",
      } as CSSProperties)
    : ({
        background: "var(--color-surface-3)",
        color: "var(--color-text)",
        border: "1px solid var(--color-border-strong)",
      } as CSSProperties);

  const handleTriggerEnter = headerStyle
    ? (e: ReactMouseEvent<HTMLButtonElement>) => {
        e.currentTarget.style.background = "rgba(255,255,255,0.05)";
        e.currentTarget.style.color = "var(--color-text)";
        e.currentTarget.style.borderColor = "rgba(255,255,255,0.20)";
      }
    : undefined;

  const handleTriggerLeave = headerStyle
    ? (e: ReactMouseEvent<HTMLButtonElement>) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = "var(--color-text-muted)";
        e.currentTarget.style.borderColor = "rgba(255,255,255,0.10)";
      }
    : undefined;

  return (
    <button
      type="button"
      onClick={onToggle}
      className={triggerClassName}
      style={triggerStyle}
      onMouseEnter={handleTriggerEnter}
      onMouseLeave={handleTriggerLeave}
      title="Execute a pre-approved script from ~/.ultron/batches/"
      aria-expanded={open}
      aria-haspopup="menu"
    >
      <span aria-hidden style={{ fontSize: 11, lineHeight: 1 }}>
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
      </span>
      <span>{runningName ? `Running: ${runningName}` : "Run batch"}</span>
      {runningName && (
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          className="animate-spin"
          aria-hidden
        >
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
      )}
      {count > 0 && (
        <span
          className="rounded px-1 text-[10px] tabular-nums"
          style={{
            background: "var(--color-surface-1)",
            color: "var(--color-text-secondary)",
            border: "1px solid var(--color-border)",
          }}
          title={`${count} batch script${count === 1 ? "" : "s"} available`}
        >
          {count}
        </span>
      )}
      {queueCount > 0 && (
        <span
          className="rounded px-1 text-[10px] font-semibold tabular-nums"
          style={{
            background: "rgba(248, 81, 73, 0.14)",
            color: "var(--color-danger)",
            border: "1px solid rgba(248, 81, 73, 0.35)",
          }}
          title={`${queueCount} en cola -- requieren tu click`}
        >
          {queueCount}
        </span>
      )}
      <span aria-hidden style={{ fontSize: 9, opacity: 0.7 }}>
        v
      </span>
    </button>
  );
}
