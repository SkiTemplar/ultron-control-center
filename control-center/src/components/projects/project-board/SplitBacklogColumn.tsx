import { useEffect, useState } from "react";
import { Plus } from "../icons";
import { useDroppableColumn } from "../../../hooks/useKanbanDnd";
import { columnAccent } from "./utils";
import type { SplitBacklogProps } from "./types";
import { BoardCard } from "./BoardCard";

export function SplitBacklogColumn({
  backlogColumnId,
  investigarColumnId,
  backlogCards,
  investigarCards,
  investigarColumnExists,
  onDropCard,
  onAddCard,
  onEditCard,
  onDeleteCard,
  onRename,
  backlogName,
}: SplitBacklogProps) {
  // Two drop zones — one per sub-section. Each routes to onDropCard with the
  // appropriate target column id.
  const backlogDrop = useDroppableColumn(
    backlogColumnId,
    ({ payload, beforeCardId }) =>
      onDropCard(payload.card_id, beforeCardId, backlogColumnId, false),
  );
  const investigarDrop = useDroppableColumn(
    investigarColumnId,
    ({ payload, beforeCardId }) =>
      onDropCard(payload.card_id, beforeCardId, investigarColumnId, true),
  );
  const accent = columnAccent(backlogName);
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(backlogName);
  useEffect(() => {
    if (!editingName) setDraftName(backlogName);
  }, [backlogName, editingName]);

  const totalCards = backlogCards.length + investigarCards.length;

  return (
    <div
      className={[
        "flex h-full min-w-[280px] flex-1 shrink-0 flex-col rounded-md border bg-[var(--color-surface-1)] transition-colors",
        backlogDrop.hover || investigarDrop.hover
          ? "border-[var(--color-accent)] bg-[var(--color-surface-2)]"
          : "border-[var(--color-border)]",
      ].join(" ")}
    >
      {/* Header — same look as a regular column but the badge shows total
          count across both sub-sections. */}
      <div className="relative flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2 text-xs">
        <span className="flex items-center gap-1.5 font-semibold uppercase tracking-wide">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: accent }}
          />
          {editingName ? (
            <input
              autoFocus
              type="text"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={() => {
                setEditingName(false);
                if (draftName.trim() && draftName.trim() !== backlogName) {
                  onRename(draftName);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  setEditingName(false);
                  if (draftName.trim() && draftName.trim() !== backlogName) {
                    onRename(draftName);
                  }
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setDraftName(backlogName);
                  setEditingName(false);
                }
              }}
              className="rounded border border-[var(--color-accent)] bg-[var(--color-surface-1)] px-1 py-0 text-xs font-semibold uppercase tracking-wide"
              style={{ minWidth: 80, width: `${Math.max(draftName.length + 1, 6)}ch` }}
            />
          ) : (
            <span
              onDoubleClick={() => setEditingName(true)}
              title="Double-click to rename — Investigar sub-section is fused into this column"
              className="cursor-text"
            >
              {backlogName}
            </span>
          )}
          <span className="ml-1 rounded bg-[var(--color-surface-2)] px-1.5 py-px text-[10px] font-medium tabular-nums normal-case tracking-normal text-[var(--color-text-muted)]">
            {totalCards}
          </span>
        </span>
      </div>
      {/* Two sub-sections sharing the column body. Each scrolls independently
          via flex-1 + overflow-y-auto. */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Backlog sub-section */}
        <div
          {...backlogDrop.columnDropProps}
          className={[
            "flex flex-1 flex-col overflow-hidden transition-colors",
            backlogDrop.hover ? "bg-[var(--color-surface-2)]" : "",
          ].join(" ")}
        >
          <div className="flex items-center justify-between border-b border-dashed border-[var(--color-border)] px-2 py-1 text-[10px] uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
            <span className="flex items-center gap-1.5">
              <span aria-hidden>Backlog</span>
              <span className="rounded bg-[var(--color-surface-2)] px-1 py-px tabular-nums normal-case tracking-normal">
                {backlogCards.length}
              </span>
            </span>
            <button
              onClick={() => onAddCard(false)}
              className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-[var(--color-text-muted)] hover:bg-[var(--color-accent)]/10 hover:text-[var(--color-accent)]"
              title="Add card to Backlog sub-section"
            >
              <Plus size={10} />
              Add
            </button>
          </div>
          <div className="flex-1 space-y-1.5 overflow-y-auto p-2">
            {backlogCards.length === 0 ? (
              <button
                onClick={() => onAddCard(false)}
                className="block w-full rounded border border-dashed border-[var(--color-border)] px-3 py-3 text-center text-[11px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
              >
                <Plus size={11} className="mr-1 inline-block align-text-bottom" />
                Add a backlog card
              </button>
            ) : (
              backlogCards.map((card) => (
                <BoardCard
                  key={card.id}
                  card={card}
                  dropProps={backlogDrop.cardDropProps(card.id)}
                  onEdit={() => onEditCard(card)}
                  onDelete={() => onDeleteCard(card.id)}
                />
              ))
            )}
          </div>
        </div>
        {/* Investigar sub-section */}
        <div
          {...investigarDrop.columnDropProps}
          className={[
            "flex flex-1 flex-col overflow-hidden border-t border-[var(--color-border-strong)] transition-colors",
            investigarDrop.hover ? "bg-[var(--color-surface-2)]" : "",
          ].join(" ")}
        >
          <div className="flex items-center justify-between border-b border-dashed border-[var(--color-border)] bg-[var(--color-surface-0)] px-2 py-1 text-[10px] uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
            <span className="flex items-center gap-1.5">
              <span aria-hidden>Investigar</span>
              <span
                className="rounded bg-[var(--color-surface-2)] px-1 py-px tabular-nums normal-case tracking-normal"
                title={
                  investigarColumnExists
                    ? "Cards in the Investigar column — fused into Backlog visually"
                    : "Cards in Backlog tagged `investigar` / `research`"
                }
              >
                {investigarCards.length}
              </span>
            </span>
            <button
              onClick={() => onAddCard(true)}
              className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-[var(--color-text-muted)] hover:bg-[var(--color-accent)]/10 hover:text-[var(--color-accent)]"
              title={
                investigarColumnExists
                  ? "Add card to the Investigar column"
                  : "Add card with `investigar` tag"
              }
            >
              <Plus size={10} />
              Add
            </button>
          </div>
          <div className="flex-1 space-y-1.5 overflow-y-auto p-2">
            {investigarCards.length === 0 ? (
              <button
                onClick={() => onAddCard(true)}
                className="block w-full rounded border border-dashed border-[var(--color-border)] px-3 py-3 text-center text-[11px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
              >
                <Plus size={11} className="mr-1 inline-block align-text-bottom" />
                Add a research card
              </button>
            ) : (
              investigarCards.map((card) => (
                <BoardCard
                  key={card.id}
                  card={card}
                  dropProps={investigarDrop.cardDropProps(card.id)}
                  onEdit={() => onEditCard(card)}
                  onDelete={() => onDeleteCard(card.id)}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
