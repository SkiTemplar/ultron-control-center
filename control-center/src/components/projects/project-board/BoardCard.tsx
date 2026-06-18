import { useMemo } from "react";
import { Bot } from "../icons";
import { useDraggableCard } from "../../../hooks/useKanbanDnd";
import type { CardProps } from "./types";

export function BoardCard({ card, dropProps, onEdit, onDelete }: CardProps) {
  const { draggableProps, dragging } = useDraggableCard({
    card_id: card.id,
    source_column_id: card.column_id,
  });
  const liveRun = useMemo(
    () =>
      card.runs.length > 0 && card.runs[card.runs.length - 1].status.kind === "running",
    [card.runs],
  );
  const lastRun = card.runs.length > 0 ? card.runs[card.runs.length - 1] : null;

  return (
    <div
      {...draggableProps}
      {...dropProps}
      onClick={onEdit}
      className={[
        "group cursor-grab rounded-md border bg-[var(--color-surface-2)] p-2 text-xs shadow-sm transition-all active:cursor-grabbing",
        dragging ? "opacity-40" : "",
        "border-[var(--color-border)] hover:-translate-y-px hover:border-[var(--color-accent)] hover:shadow-md",
      ].join(" ")}
    >
      <div className="mb-1 flex items-start justify-between gap-2">
        <span className="line-clamp-2 text-[12px] font-medium leading-snug text-[var(--color-text)]">
          {card.title}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="rounded p-0.5 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-[var(--color-surface-0)] hover:text-[var(--color-error)] group-hover:opacity-100"
          aria-label="Delete card"
          title="Delete"
        >
          ×
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
        {/* v2.6 (card-v26-fb-029): priority badge from first tag matching
            /^p\d$/. p0=danger, p1=warn, p2/p3=neutral. Filtered out of the
            regular tag display below so it doesn't appear twice. */}
        {(() => {
          const p = card.tags.find((t) => /^p\d$/.test(t));
          if (!p) return null;
          const palette: Record<string, { bg: string; fg: string }> = {
            p0: { bg: "rgba(248, 81, 73, 0.18)", fg: "var(--color-danger)" },
            p1: { bg: "rgba(210, 153, 34, 0.18)", fg: "var(--color-warn)" },
            p2: { bg: "var(--color-surface-3)", fg: "var(--color-text)" },
            p3: { bg: "var(--color-surface-0)", fg: "var(--color-text-muted)" },
          };
          const c = palette[p] ?? palette.p3;
          return (
            <span
              className="rounded px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider"
              style={{ background: c.bg, color: c.fg }}
              title={`Priority: ${p.toUpperCase()}`}
            >
              {p.toUpperCase()}
            </span>
          );
        })()}
        {card.agent && (
          <span
            className="flex items-center gap-1 rounded bg-[var(--color-surface-0)] px-1.5 py-0.5 font-medium"
            title={`Agent: ${card.agent}`}
          >
            <Bot size={10} />
            {card.agent}
          </span>
        )}
        {liveRun ? (
          <span className="flex items-center gap-1 rounded bg-[var(--color-accent)]/10 px-1.5 py-0.5 font-medium text-[var(--color-accent)]">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-accent)]" />
            live
          </span>
        ) : lastRun ? (
          <span
            className="rounded px-1.5 py-0.5 font-medium"
            style={{
              background:
                lastRun.status.kind === "failed"
                  ? "rgba(248, 81, 73, 0.10)"
                  : "var(--color-surface-0)",
              color:
                lastRun.status.kind === "failed"
                  ? "var(--color-error)"
                  : "var(--color-text-muted)",
            }}
            title={`Last run: ${lastRun.status.kind}`}
          >
            {lastRun.status.kind}
          </span>
        ) : null}
        {card.tags.filter((t) => !/^p\d$/.test(t)).slice(0, 2).map((t) => (
          <span
            key={t}
            className="rounded bg-[var(--color-surface-0)] px-1.5 py-0.5"
          >
            {t}
          </span>
        ))}
        {card.tags.filter((t) => !/^p\d$/.test(t)).length > 2 && (
          <span className="text-[var(--color-text-muted)]">
            +{card.tags.filter((t) => !/^p\d$/.test(t)).length - 2}
          </span>
        )}
      </div>
    </div>
  );
}
