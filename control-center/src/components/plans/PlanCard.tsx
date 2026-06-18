// PlanCard — single kanban card with drag-and-drop, expand, move, edit, delete.
// Extracted from Plans.tsx as part of the cat7 split refactor.

import { useRoutingTitle } from "../../lib/button-prompts";
import { PriorityBadge } from "./PriorityBadge";
import { COLUMNS } from "./types";
import type { PlanItem } from "./types";

export function PlanCard({
  item,
  onMove,
  expanded,
  onToggle,
  onEdit,
  onDelete,
  onOpenSession,
  onDragStart,
  onDragEnd,
  dragging,
}: {
  item: PlanItem;
  onMove: (target: string) => void;
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onOpenSession: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  dragging: boolean;
}) {
  const openSessionTitle = useRoutingTitle(
    "plans.resolve_one",
    "Open an AI session in ULTRON with this plan as the initial prompt.",
  );
  return (
    <div
      // Native HTML5 drag-and-drop: the whole card is the drag handle. The
      // payload (plan id) travels via dataTransfer, set in onDragStart.
      // Dropping onto a column calls `move(id, target)` — same path as the
      // expand+button flow, which stays in place (DnD is additive).
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", item.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className="rounded p-3 transition-colors"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
        cursor: "grab",
        opacity: dragging ? 0.45 : 1,
      }}
    >
      <div className="flex items-start gap-2">
        <PriorityBadge p={item.priority} />
        <button
          type="button"
          onClick={onToggle}
          className="min-w-0 flex-1 text-left"
        >
          <div
            className="text-[12.5px] font-medium leading-tight"
            style={{
              color: "var(--color-text)",
              overflowWrap: "anywhere",
              wordBreak: "break-word",
            }}
          >
            {item.title || item.id}
          </div>
          <div
            className="mt-0.5 text-[10.5px]"
            style={{
              fontFamily: "var(--font-mono)",
              color: "var(--color-text-faint)",
            }}
          >
            {item.id}
          </div>
        </button>
      </div>
      {item.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {item.tags.slice(0, 6).map((t) => (
            <span
              key={t}
              className="rounded px-1 py-px text-[10px]"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-text-tertiary)",
              }}
            >
              {t}
            </span>
          ))}
        </div>
      )}
      {expanded && item.description && (
        <p
          className="mt-2 text-[11.5px] leading-relaxed"
          style={{ color: "var(--color-text-secondary)", whiteSpace: "pre-wrap" }}
        >
          {item.description}
        </p>
      )}
      {expanded && (
        <div className="mt-2 space-y-1.5">
          <div className="flex flex-wrap gap-1">
            {COLUMNS.filter((c) => c.key !== item.status).map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => onMove(c.key)}
                className="rounded px-2 py-0.5 text-[10.5px] transition-colors"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-secondary)",
                  border: "1px solid var(--color-border)",
                }}
                title={`Move to ${c.label}`}
              >
                {c.label.toLowerCase()}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              onClick={onOpenSession}
              className="rounded px-2 py-0.5 text-[10.5px] font-medium transition-colors"
              style={{
                background: "var(--color-accent)",
                color: "var(--color-accent-text)",
              }}
              title={openSessionTitle}
            >
              Open session
            </button>
            <button
              type="button"
              onClick={onEdit}
              className="rounded px-2 py-0.5 text-[10.5px] transition-colors"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-text-secondary)",
                border: "1px solid var(--color-border)",
              }}
            >
              Edit
            </button>
            <button
              type="button"
              onClick={onDelete}
              className="rounded px-2 py-0.5 text-[10.5px] transition-colors"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-danger)",
                border: "1px solid rgba(248, 81, 73, 0.32)",
              }}
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
