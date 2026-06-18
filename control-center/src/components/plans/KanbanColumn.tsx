// KanbanColumn — a single kanban lane with header, action bar, and card list.
// Accepts drag-and-drop events from the parent (Plans) via callbacks.
// Extracted from Plans.tsx as part of the cat7 split refactor.

import { type DragEvent as ReactDragEvent } from "react";
import { ColumnActions } from "./ColumnActions";
import { PlanCard } from "./PlanCard";
import type { PlanItem } from "./types";

export type KanbanColumnProps = {
  columnKey: string;
  label: string;
  tint: string;
  items: PlanItem[];
  dragOverColumn: string | null;
  draggingId: string | null;
  expanded: Set<string>;
  onToggleExpanded: (id: string) => void;
  onMove: (id: string, target: string) => void;
  onEdit: (item: PlanItem) => void;
  onDelete: (item: PlanItem) => void;
  onOpenSession: (item: PlanItem) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDragOver: (e: ReactDragEvent, key: string) => void;
  onDragLeave: (e: ReactDragEvent, key: string) => void;
  onDrop: (e: ReactDragEvent, key: string) => void;
  // ColumnActions props
  onNew: () => void;
  onSprintAi: () => void;
  sprintAiBusy: boolean;
  onExecute: () => void;
  onReview: () => void;
  onResolveBlock: () => void;
  onArchiveSelected: () => void;
  archiveDisabled: boolean;
  archiveCount: number;
};

export function KanbanColumn({
  columnKey,
  label,
  tint,
  items,
  dragOverColumn,
  draggingId,
  expanded,
  onToggleExpanded,
  onMove,
  onEdit,
  onDelete,
  onOpenSession,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  onNew,
  onSprintAi,
  sprintAiBusy,
  onExecute,
  onReview,
  onResolveBlock,
  onArchiveSelected,
  archiveDisabled,
  archiveCount,
}: KanbanColumnProps) {
  const isOver = dragOverColumn === columnKey;

  return (
    <div
      className="flex flex-col overflow-hidden rounded transition-colors"
      style={{
        background: "var(--color-surface-1)",
        border: `1px solid ${isOver ? "var(--color-accent)" : "var(--color-border)"}`,
      }}
    >
      <div
        className="flex items-baseline justify-between border-b px-3 py-2"
        style={{ borderColor: "var(--color-border)" }}
      >
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: tint }}
          />
          <span
            className="text-[11.5px] font-medium uppercase tracking-[0.06em]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            {label}
          </span>
        </div>
        <span
          className="tabular-nums text-[11.5px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {items.length}
        </span>
      </div>
      {/* Per-column action bar. Each column owns the buttons that
          only make sense for items in that lane, so the user
          doesn't have to mentally route "what does this button do
          with my selection?" — context is the column. */}
      <ColumnActions
        column={columnKey}
        onNew={onNew}
        onSprintAi={onSprintAi}
        sprintAiBusy={sprintAiBusy}
        onExecute={onExecute}
        onReview={onReview}
        onResolveBlock={onResolveBlock}
        onArchiveSelected={onArchiveSelected}
        archiveDisabled={archiveDisabled}
        archiveCount={archiveCount}
      />
      <div
        className="flex-1 space-y-2 overflow-auto p-2 transition-colors"
        style={{
          background: isOver ? "var(--color-surface-2)" : "transparent",
        }}
        onDragOver={(e) => onDragOver(e, columnKey)}
        onDragLeave={(e) => onDragLeave(e, columnKey)}
        onDrop={(e) => onDrop(e, columnKey)}
      >
        {items.map((it) => (
          <PlanCard
            key={it.id}
            item={it}
            expanded={expanded.has(it.id)}
            onToggle={() => onToggleExpanded(it.id)}
            onMove={(target) => onMove(it.id, target)}
            onEdit={() => onEdit(it)}
            onDelete={() => onDelete(it)}
            onOpenSession={() => onOpenSession(it)}
            dragging={draggingId === it.id}
            onDragStart={() => onDragStart(it.id)}
            onDragEnd={onDragEnd}
          />
        ))}
      </div>
    </div>
  );
}
