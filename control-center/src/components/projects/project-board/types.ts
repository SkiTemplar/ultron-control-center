import type { Card, Column } from "../../../types";

export type Props = { projectId: string };

export type ColumnProps = {
  columnId: string;
  name: string;
  cards: Card[];
  allColumns: Column[];
  onDropCard: (cardId: string, beforeCardId: string | null) => void;
  onAddCard: () => void;
  onEditCard: (card: Card) => void;
  onDeleteCard: (cardId: string) => void;
  onRename: (newName: string) => void;
  onDelete: (reassignToColumnId?: string) => Promise<void>;
  onMoveLeft: () => void;
  onMoveRight: () => void;
  isFirst: boolean;
  isLast: boolean;
};

// v2.6.2 — Backlog column with a vertical split: "Backlog" sub-section on top,
// "Investigar" sub-section below. Each sub-section is its own DnD target.
export type SplitBacklogProps = {
  backlogColumnId: string;
  investigarColumnId: string;
  backlogCards: Card[];
  investigarCards: Card[];
  /** True when a dedicated Investigar column exists in the board. False when
   *  we are using the tag-based virtual split (no separate column id). */
  investigarColumnExists: boolean;
  onDropCard: (
    cardId: string,
    beforeCardId: string | null,
    targetColumnId: string,
    toInvestigar: boolean,
  ) => void;
  onAddCard: (toInvestigar: boolean) => void;
  onEditCard: (card: Card) => void;
  onDeleteCard: (cardId: string) => void;
  onRename: (newName: string) => void;
  backlogName: string;
};

export type CardProps = {
  card: Card;
  dropProps: {
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: () => void;
    onDrop: (e: React.DragEvent) => void;
  };
  onEdit: () => void;
  onDelete: () => void;
};

// DeleteConfirm — three-state inline confirm flow for column deletion.
//   idle      → shows "Borrar" button
//   confirm   → shows "Confirmar borrado" / Cancelar (for empty columns)
//   reassign  → shows a select of other columns to move cards to
export type DeleteState =
  | { phase: "idle" }
  | { phase: "confirm" }
  | { phase: "reassign"; targetId: string }
  | { phase: "busy" };
