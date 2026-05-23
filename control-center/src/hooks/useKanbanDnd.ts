// ULTRON Control Center 2.0 — HTML5 DnD helpers for Kanban
//
// Two tiny hook factories that expose the props needed for draggable cards
// and droppable columns. No external library; relies on the Tauri DnD fix
// shipped in 12fd27a.

import { useCallback, useRef, useState } from "react";

const MIME = "application/x-ultron-kanban-card";

export type CardDragPayload = {
  card_id: string;
  source_column_id: string;
};

export function useDraggableCard(payload: CardDragPayload) {
  const [dragging, setDragging] = useState(false);

  const onDragStart = useCallback(
    (e: React.DragEvent) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData(MIME, JSON.stringify(payload));
      // Also set a plain-text fallback so the OS shows a proper drag image.
      e.dataTransfer.setData("text/plain", payload.card_id);
      setDragging(true);
    },
    [payload],
  );

  const onDragEnd = useCallback(() => {
    setDragging(false);
  }, []);

  return {
    draggableProps: {
      draggable: true,
      onDragStart,
      onDragEnd,
    },
    dragging,
  };
}

export type DropResult = {
  payload: CardDragPayload;
  beforeCardId: string | null;
};

export function useDroppableColumn(
  columnId: string,
  onDrop: (result: DropResult) => void,
) {
  const [hover, setHover] = useState(false);
  const lastHoverRef = useRef<string | null>(null);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setHover(true);
    }
  }, []);

  const onDragLeave = useCallback(() => {
    setHover(false);
  }, []);

  const onDropFn = useCallback(
    (e: React.DragEvent, beforeCardId: string | null = null) => {
      e.preventDefault();
      setHover(false);
      const raw = e.dataTransfer.getData(MIME);
      if (!raw) return;
      try {
        const payload = JSON.parse(raw) as CardDragPayload;
        onDrop({ payload, beforeCardId });
      } catch {
        /* invalid drop payload */
      }
    },
    [onDrop],
  );

  const cardDropProps = (beforeCardId: string) => ({
    onDragOver,
    onDragLeave,
    onDrop: (e: React.DragEvent) => onDropFn(e, beforeCardId),
  });

  return {
    columnDropProps: {
      "data-column-id": columnId,
      onDragOver,
      onDragLeave,
      onDrop: (e: React.DragEvent) => onDropFn(e, null),
    },
    cardDropProps,
    hover,
    lastHoverRef,
  };
}
