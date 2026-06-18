import { useEffect, useState } from "react";
import { Plus } from "../icons";
import { useDroppableColumn } from "../../../hooks/useKanbanDnd";
import { isBacklogColumn, columnAccent } from "./utils";
import type { ColumnProps, DeleteState } from "./types";
import { BoardCard } from "./BoardCard";

export function BoardColumn({
  columnId,
  name,
  cards,
  allColumns,
  onDropCard,
  onAddCard,
  onEditCard,
  onDeleteCard,
  onRename,
  onDelete,
  onMoveLeft,
  onMoveRight,
  isFirst,
  isLast,
}: ColumnProps) {
  const { columnDropProps, cardDropProps, hover } = useDroppableColumn(
    columnId,
    ({ payload, beforeCardId }) => onDropCard(payload.card_id, beforeCardId),
  );
  const accent = columnAccent(name);

  // Column action menu (three-dot)
  const [colMenuOpen, setColMenuOpen] = useState(false);

  // Inline rename
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(name);
  useEffect(() => {
    if (!editingName) setDraftName(name);
  }, [name, editingName]);

  // Delete flow state machine
  const [deleteState, setDeleteState] = useState<DeleteState>({ phase: "idle" });
  const otherColumns = allColumns.filter((c) => c.id !== columnId);

  const handleDeleteClick = () => {
    if (cards.length === 0) {
      setDeleteState({ phase: "confirm" });
    } else {
      setDeleteState({
        phase: "reassign",
        targetId: otherColumns[0]?.id ?? "",
      });
    }
  };

  const handleDeleteConfirm = async () => {
    setDeleteState({ phase: "busy" });
    try {
      if (cards.length === 0) {
        await onDelete(undefined);
      } else if (deleteState.phase === "reassign") {
        await onDelete(deleteState.targetId);
      }
    } catch (e) {
      // Backend error after optimistic start (shouldn't happen here but guard)
      setDeleteState({ phase: "idle" });
    }
  };

  const isDeleteActive =
    deleteState.phase !== "idle" && deleteState.phase !== "busy";

  return (
    <div
      {...columnDropProps}
      className={[
        "flex h-full min-w-[280px] flex-1 shrink-0 flex-col rounded-md border bg-[var(--color-surface-1)] transition-colors",
        hover
          ? "border-[var(--color-accent)] bg-[var(--color-surface-2)]"
          : isDeleteActive
            ? "border-[var(--color-error)]"
            : "border-[var(--color-border)]",
      ].join(" ")}
    >
      {/* Column header */}
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
                if (draftName.trim() && draftName.trim() !== name) {
                  onRename(draftName);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  setEditingName(false);
                  if (draftName.trim() && draftName.trim() !== name) {
                    onRename(draftName);
                  }
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setDraftName(name);
                  setEditingName(false);
                }
              }}
              className="rounded border border-[var(--color-accent)] bg-[var(--color-surface-1)] px-1 py-0 text-xs font-semibold uppercase tracking-wide"
              style={{ minWidth: 80, width: `${Math.max(draftName.length + 1, 6)}ch` }}
            />
          ) : (
            <span
              onDoubleClick={() => setEditingName(true)}
              title="Doble clic para renombrar"
              className="cursor-text"
            >
              {name}
            </span>
          )}
          <span className="ml-1 rounded bg-[var(--color-surface-2)] px-1.5 py-px text-[10px] font-medium tabular-nums normal-case tracking-normal text-[var(--color-text-muted)]">
            {cards.length}
          </span>
        </span>
        <div className="flex items-center gap-0.5">
          {/* Column actions menu (three-dot) */}
          <button
            onClick={() => { setColMenuOpen((v) => !v); setDeleteState({ phase: "idle" }); }}
            className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-accent)]"
            aria-label="Acciones de columna"
            title="Acciones de columna"
          >
            {/* Three-dot icon rendered as text — no new icon import needed */}
            <span className="select-none text-[13px] leading-none tracking-tight">···</span>
          </button>
          {isBacklogColumn(name) && (
            <button
              onClick={onAddCard}
              className="flex items-center gap-1 rounded px-2 py-1 text-[11.5px] font-medium text-[var(--color-text-muted)] hover:bg-[var(--color-accent)]/10 hover:text-[var(--color-accent)]"
              aria-label="Agregar card"
              title="Agregar card"
            >
              <Plus size={12} />
              Add
            </button>
          )}
        </div>

        {/* Column actions popover */}
        {colMenuOpen && (
          <div
            className="absolute right-1 top-9 z-20 w-52 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] shadow-lg"
            onMouseLeave={() => {
              if (deleteState.phase === "idle") setColMenuOpen(false);
            }}
          >
            <div className="border-b border-[var(--color-border)] px-3 py-1.5 text-[11px] uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
              {name}
            </div>

            {/* Renombrar */}
            <button
              type="button"
              onClick={() => {
                setColMenuOpen(false);
                setEditingName(true);
              }}
              className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text)]"
            >
              Renombrar
            </button>

            {/* Mover izquierda / derecha */}
            <button
              type="button"
              disabled={isFirst}
              onClick={() => { setColMenuOpen(false); onMoveLeft(); }}
              className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text)] disabled:opacity-35"
            >
              Mover a la izquierda
            </button>
            <button
              type="button"
              disabled={isLast}
              onClick={() => { setColMenuOpen(false); onMoveRight(); }}
              className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text)] disabled:opacity-35"
            >
              Mover a la derecha
            </button>

            <div className="my-1 border-t border-[var(--color-border)]" />

            {/* Borrar — inline confirm / reassign */}
            {deleteState.phase === "idle" && (
              <button
                type="button"
                onClick={handleDeleteClick}
                className="block w-full px-3 py-1.5 text-left text-[12px] text-[var(--color-error)] hover:bg-[var(--color-surface-3)]"
              >
                Borrar columna
              </button>
            )}

            {deleteState.phase === "confirm" && (
              <div className="px-3 py-2">
                <p className="mb-2 text-[11px] text-[var(--color-text-secondary)]">
                  La columna esta vacia. Confirmar borrado?
                </p>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => setDeleteState({ phase: "idle" })}
                    className="flex-1 rounded px-2 py-1 text-[11px]"
                    style={{
                      background: "transparent",
                      color: "var(--color-text-tertiary)",
                      border: "1px solid var(--color-border-strong)",
                    }}
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDeleteConfirm()}
                    className="flex-1 rounded px-2 py-1 text-[11px] font-medium"
                    style={{
                      background: "var(--color-error)",
                      color: "#fff",
                    }}
                  >
                    Borrar
                  </button>
                </div>
              </div>
            )}

            {deleteState.phase === "reassign" && (
              <div className="px-3 py-2">
                <p className="mb-1.5 text-[11px] text-[var(--color-text-secondary)]">
                  {cards.length} card{cards.length === 1 ? "" : "s"} se moveran a:
                </p>
                <select
                  value={deleteState.targetId}
                  onChange={(e) =>
                    setDeleteState({ phase: "reassign", targetId: e.target.value })
                  }
                  className="mb-2 w-full rounded px-2 py-1 text-[11.5px] outline-none"
                  style={{
                    background: "var(--color-surface-1)",
                    border: "1px solid var(--color-border-strong)",
                    color: "var(--color-text)",
                  }}
                >
                  {otherColumns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => setDeleteState({ phase: "idle" })}
                    className="flex-1 rounded px-2 py-1 text-[11px]"
                    style={{
                      background: "transparent",
                      color: "var(--color-text-tertiary)",
                      border: "1px solid var(--color-border-strong)",
                    }}
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    disabled={!deleteState.targetId}
                    onClick={() => void handleDeleteConfirm()}
                    className="flex-1 rounded px-2 py-1 text-[11px] font-medium disabled:opacity-40"
                    style={{
                      background: "var(--color-error)",
                      color: "#fff",
                    }}
                  >
                    Borrar
                  </button>
                </div>
              </div>
            )}

            {deleteState.phase === "busy" && (
              <div className="px-3 py-2 text-[11px] text-[var(--color-text-muted)]">
                Borrando…
              </div>
            )}
          </div>
        )}
      </div>

      {/* Cards list */}
      <div className="flex-1 space-y-1.5 overflow-y-auto p-2">
        {cards.length === 0 && (
          <button
            onClick={onAddCard}
            className="block w-full rounded border border-dashed border-[var(--color-border)] px-3 py-4 text-center text-[11.5px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
          >
            <Plus size={11} className="mr-1 inline-block align-text-bottom" />
            Add a card to {name.toLowerCase()}
          </button>
        )}
        {cards.map((card) => (
          <BoardCard
            key={card.id}
            card={card}
            dropProps={cardDropProps(card.id)}
            onEdit={() => onEditCard(card)}
            onDelete={() => onDeleteCard(card.id)}
          />
        ))}
      </div>
    </div>
  );
}
