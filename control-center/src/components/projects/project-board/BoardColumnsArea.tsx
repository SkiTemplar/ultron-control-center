import type { Card, KanbanBoard } from "../../../types";
import { isBacklogColumn, isInvestigarColumn, hasInvestigarTag } from "./utils";
import { BoardColumn } from "./BoardColumn";
import { SplitBacklogColumn } from "./SplitBacklogColumn";
import { useHiddenOverflow } from "./useHiddenOverflow";

type BoardColumnsAreaProps = {
  board: KanbanBoard;
  cardMatches: (card: Card) => boolean;
  moveCard: (cardId: string, targetColumnId: string, order: number) => void;
  retagInvestigar: (cardId: string, addTag: boolean) => void;
  setEditing: (
    v:
      | { mode: "create"; columnId: string }
      | { mode: "edit"; card: Card }
      | null,
  ) => void;
  deleteCard: (cardId: string) => void;
  renameColumn: (columnId: string, newName: string) => void;
  deleteColumnById: (columnId: string, reassignToColumnId?: string) => Promise<void>;
  reorderColumn: (columnId: string, direction: "left" | "right") => void;
};

export function BoardColumnsArea({
  board,
  cardMatches,
  moveCard,
  retagInvestigar,
  setEditing,
  deleteCard,
  renameColumn,
  deleteColumnById,
  reorderColumn,
}: BoardColumnsAreaProps) {
  // v2.6.2 — fuse the Investigar column into Backlog. We:
  //   1. Find a backlog column and any investigar-like column.
  //   2. Hide the investigar column from the regular row.
  //   3. Render the backlog column with a special split layout that
  //      holds two sub-sections (Backlog + Investigar) — both DnD
  //      targets, both draggable sources.
  const sortedCols = [...board.columns].sort((a, b) => a.order - b.order);
  const backlogCol = sortedCols.find((c) => isBacklogColumn(c.name));
  const investigarCol = sortedCols.find((c) => isInvestigarColumn(c.name));
  const visibleCols = sortedCols.filter((c) => {
    if (investigarCol && c.id === investigarCol.id) return false;
    return true;
  });
  // Columns cut off on the right are announced at the edge: on narrow
  // windows Done falls outside the board and nothing else would say so.
  const overflow = useHiddenOverflow<HTMLDivElement>(visibleCols.length, "x");
  // El aviso de columnas ocultas vive en un canal propio a la derecha del
  // tablero (no superpuesto): así no tapa tarjetas y, al pulsarlo, desplaza
  // el scroll horizontal del tablero hacia las columnas que faltan.
  const scrollToHidden = () => {
    const el = overflow.ref.current;
    if (!el) return;
    el.scrollBy({ left: Math.max(el.clientWidth * 0.8, 280), behavior: "smooth" });
  };
  const hiddenLabel = `+${overflow.hidden} columna${overflow.hidden === 1 ? "" : "s"}`;

  return (
    <div className="relative flex min-h-0 flex-1">
      <div
        ref={overflow.ref}
        onScroll={overflow.onScroll}
        className="relative flex min-w-0 flex-1 gap-3 overflow-x-auto overflow-y-hidden p-3"
        aria-label="Columnas del tablero"
      >
        {visibleCols.map((col) => {
          const isBacklog = backlogCol && col.id === backlogCol.id;
          const colCards = board.cards
            .filter((c) => c.column_id === col.id)
            .filter(cardMatches)
            .sort((a, b) => a.order - b.order);
          if (isBacklog) {
            // Split logic — when an investigar column exists, those cards
            // flow into the "investigar" sub-section; otherwise we look at
            // tags on the Backlog cards themselves.
            let backlogCards: Card[];
            let investigarCards: Card[];
            if (investigarCol) {
              backlogCards = colCards;
              investigarCards = board.cards
                .filter((c) => c.column_id === investigarCol.id)
                .filter(cardMatches)
                .sort((a, b) => a.order - b.order);
            } else {
              backlogCards = colCards.filter((c) => !hasInvestigarTag(c));
              investigarCards = colCards.filter((c) => hasInvestigarTag(c));
            }
            return (
              <SplitBacklogColumn
                key={col.id}
                backlogColumnId={col.id}
                investigarColumnId={investigarCol?.id ?? col.id}
                backlogCards={backlogCards}
                investigarCards={investigarCards}
                investigarColumnExists={!!investigarCol}
                onDropCard={(cardId, beforeCardId, targetColumnId, toInvestigar) => {
                  // When the Backlog hosts a virtual investigar split (no
                  // dedicated column), moving between sub-sections toggles
                  // the `investigar` tag rather than changing column_id.
                  if (!investigarCol) {
                    void retagInvestigar(cardId, toInvestigar);
                    return;
                  }
                  const inCol = board.cards
                    .filter((c) => c.column_id === targetColumnId)
                    .sort((a, b) => a.order - b.order);
                  let order: number;
                  if (!beforeCardId) {
                    order = inCol.length;
                  } else {
                    const idx = inCol.findIndex((x) => x.id === beforeCardId);
                    order = idx === -1 ? inCol.length : idx;
                  }
                  void moveCard(cardId, targetColumnId, order);
                }}
                onAddCard={(toInvestigar) => {
                  const target =
                    toInvestigar && investigarCol ? investigarCol.id : col.id;
                  setEditing({ mode: "create", columnId: target });
                }}
                onEditCard={(card) => setEditing({ mode: "edit", card })}
                onDeleteCard={(cardId) => void deleteCard(cardId)}
                onRename={(newName) => void renameColumn(col.id, newName)}
                backlogName={col.name}
              />
            );
          }
          return (
            <BoardColumn
              key={col.id}
              columnId={col.id}
              name={col.name}
              cards={colCards}
              allColumns={visibleCols}
              onDropCard={(cardId, beforeCardId) => {
                const inCol = board.cards
                  .filter((c) => c.column_id === col.id)
                  .sort((a, b) => a.order - b.order);
                let order: number;
                if (!beforeCardId) {
                  order = inCol.length;
                } else {
                  const idx = inCol.findIndex((c) => c.id === beforeCardId);
                  order = idx === -1 ? inCol.length : idx;
                }
                void moveCard(cardId, col.id, order);
              }}
              onAddCard={() => setEditing({ mode: "create", columnId: col.id })}
              onEditCard={(card) => setEditing({ mode: "edit", card })}
              onDeleteCard={(cardId) => void deleteCard(cardId)}
              onRename={(newName) => void renameColumn(col.id, newName)}
              onDelete={(reassignId) => deleteColumnById(col.id, reassignId)}
              onMoveLeft={() => void reorderColumn(col.id, "left")}
              onMoveRight={() => void reorderColumn(col.id, "right")}
              isFirst={visibleCols[0].id === col.id}
              isLast={visibleCols[visibleCols.length - 1].id === col.id}
            />
          );
        })}
        {/* Margen final: el padding derecho de un contenedor flex con scroll
            no siempre entra en el área desplazable y la última columna
            quedaba pegada al borde. */}
        <div aria-hidden data-overflow-ignore className="w-px shrink-0" />
      </div>
      {overflow.hidden > 0 && (
        <button
          type="button"
          onClick={scrollToHidden}
          className="my-3 mr-2 flex w-7 shrink-0 flex-col items-center justify-center gap-1.5 rounded border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] text-[10.5px] font-medium text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
          title={`${hiddenLabel} a la derecha: desplazar el tablero`}
          aria-label={`${hiddenLabel} a la derecha: desplazar el tablero`}
        >
          <span aria-hidden className="text-[13px] leading-none">›</span>
          <span style={{ writingMode: "vertical-rl" }}>{hiddenLabel}</span>
        </button>
      )}
    </div>
  );
}
