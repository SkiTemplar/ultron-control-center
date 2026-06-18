import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Card, ColumnRole, KanbanBoard, KanbanArchive, KanbanArchiveSummary } from "../../../types";
import { INVESTIGAR_TAGS } from "./utils";

export function useProjectBoard(projectId: string) {
  const [board, setBoard] = useState<KanbanBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<
    | { mode: "create"; columnId: string }
    | { mode: "edit"; card: Card }
    | null
  >(null);

  const load = useCallback(async () => {
    try {
      const b = (await invoke("kanban_load", { projectId })) as KanbanBoard;
      setBoard(b);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const moveCard = useCallback(
    async (cardId: string, targetColumnId: string, order: number) => {
      const snapshot = board;
      if (board) {
        setBoard({
          ...board,
          cards: board.cards.map((c) =>
            c.id === cardId ? { ...c, column_id: targetColumnId, order } : c,
          ),
        });
      }
      try {
        const next = (await invoke("kanban_move_card", {
          projectId,
          cardId,
          targetColumnId,
          order,
        })) as KanbanBoard;
        setBoard(next);
      } catch (e) {
        setError(String(e));
        if (snapshot) setBoard(snapshot);
      }
    },
    [board, projectId],
  );

  const deleteCard = useCallback(
    async (cardId: string) => {
      try {
        await invoke("kanban_delete_card", { projectId, cardId });
        await load();
      } catch (e) {
        setError(String(e));
      }
    },
    [load, projectId],
  );

  // v2.14 — rename a column via kanban_rename_column.
  const renameColumn = useCallback(
    async (columnId: string, newName: string) => {
      if (!board) return;
      const trimmed = newName.trim();
      if (!trimmed) return;
      const snapshot = board;
      setBoard({
        ...board,
        columns: board.columns.map((c) =>
          c.id === columnId ? { ...c, name: trimmed } : c,
        ),
      });
      try {
        await invoke("kanban_rename_column", { projectId, columnId, name: trimmed });
        await load();
      } catch (e) {
        setError(String(e));
        setBoard(snapshot);
      }
    },
    [board, projectId, load],
  );

  // v2.14 — add a new column via kanban_add_column.
  const addColumn = useCallback(
    async (name: string, role: ColumnRole) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      try {
        await invoke("kanban_add_column", { projectId, name: trimmed, role });
        await load();
      } catch (e) {
        setError(String(e));
      }
    },
    [projectId, load],
  );

  // v2.14 — delete a column. If the column has cards and reassignToColumnId is
  // not provided, the backend returns Err — the caller must ask the user where
  // to move cards and retry.
  const deleteColumnById = useCallback(
    async (columnId: string, reassignToColumnId?: string) => {
      try {
        await invoke("kanban_delete_column", {
          projectId,
          columnId,
          reassignToColumnId: reassignToColumnId ?? null,
        });
        await load();
      } catch (e) {
        // Re-throw so the column component can decide whether to ask for reassign.
        throw e;
      }
    },
    [projectId, load],
  );

  // v2.14 — reorder columns via kanban_reorder_columns.
  const reorderColumn = useCallback(
    async (columnId: string, direction: "left" | "right") => {
      if (!board) return;
      const sorted = [...board.columns].sort((a, b) => a.order - b.order);
      const idx = sorted.findIndex((c) => c.id === columnId);
      if (idx === -1) return;
      const swapIdx = direction === "left" ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= sorted.length) return;
      const orderedIds = sorted.map((c) => c.id);
      orderedIds[idx] = sorted[swapIdx].id;
      orderedIds[swapIdx] = sorted[idx].id;
      const snapshot = board;
      // Optimistic update.
      const nextCols = sorted.map((c, i) => ({ ...c, order: i }));
      // Swap order values in optimistic state.
      const tmp = nextCols[idx].order;
      nextCols[idx] = { ...nextCols[idx], order: nextCols[swapIdx].order };
      nextCols[swapIdx] = { ...nextCols[swapIdx], order: tmp };
      setBoard({ ...board, columns: orderedIds.map((id, i) => {
        const col = board.columns.find((c) => c.id === id)!;
        return { ...col, order: i };
      })});
      try {
        const next = (await invoke("kanban_reorder_columns", {
          projectId,
          orderedIds,
        })) as KanbanBoard;
        setBoard(next);
      } catch (e) {
        setError(String(e));
        setBoard(snapshot);
      }
    },
    [board, projectId],
  );

  // v2.14 — "+ Columna" form state in the toolbar.
  const [addColOpen, setAddColOpen] = useState(false);
  const [addColName, setAddColName] = useState("");
  const [addColRole, setAddColRole] = useState<ColumnRole>("other");
  const [addColBusy, setAddColBusy] = useState(false);
  const addColInputRef = useRef<HTMLInputElement>(null);

  const submitAddColumn = useCallback(async () => {
    const trimmed = addColName.trim();
    if (!trimmed || addColBusy) return;
    setAddColBusy(true);
    try {
      await addColumn(trimmed, addColRole);
      setAddColOpen(false);
      setAddColName("");
      setAddColRole("other");
    } finally {
      setAddColBusy(false);
    }
  }, [addColName, addColRole, addColBusy, addColumn]);

  // v2.6.2 — archive Done state. The toolbar "Archive Done" button opens a
  // small prompt for a group name; once confirmed the backend writes the
  // archive file and removes the Done cards from the live board. "Show
  // Archived" toggles a Library-style grid of archive boxes.
  const [showArchived, setShowArchived] = useState(false);
  const [archiveModalOpen, setArchiveModalOpen] = useState(false);
  const [archiveName, setArchiveName] = useState("");
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archives, setArchives] = useState<KanbanArchiveSummary[]>([]);
  const [archivesLoading, setArchivesLoading] = useState(false);
  const [openedArchive, setOpenedArchive] = useState<KanbanArchive | null>(null);

  const loadArchives = useCallback(async () => {
    setArchivesLoading(true);
    try {
      const list = (await invoke("kanban_list_archives", { projectId })) as KanbanArchiveSummary[];
      setArchives(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setArchivesLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (showArchived) void loadArchives();
  }, [showArchived, loadArchives]);

  const archiveDone = useCallback(
    async (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      setArchiveBusy(true);
      try {
        await invoke("kanban_archive_done", { projectId, archiveName: trimmed });
        setArchiveModalOpen(false);
        setArchiveName("");
        await load();
        if (showArchived) await loadArchives();
      } catch (e) {
        setError(String(e));
      } finally {
        setArchiveBusy(false);
      }
    },
    [projectId, load, showArchived, loadArchives],
  );

  const openArchive = useCallback(
    async (name: string) => {
      try {
        const arc = (await invoke("kanban_load_archive", {
          projectId,
          archiveName: name,
        })) as KanbanArchive;
        setOpenedArchive(arc);
      } catch (e) {
        setError(String(e));
      }
    },
    [projectId],
  );

  // v2.6: board UX hardening — search + priority filter chips. Persisted
  // per-project in localStorage so the user's preferred view sticks across
  // reloads.
  const filterKey = `board.filters.${projectId}`;
  const [boardQuery, setBoardQuery] = useState<string>(() => {
    try {
      return localStorage.getItem(`${filterKey}.q`) ?? "";
    } catch {
      return "";
    }
  });
  const [priorityFilter, setPriorityFilter] = useState<"all" | "p0" | "p1" | "p2" | "p3">(() => {
    try {
      const v = localStorage.getItem(`${filterKey}.p`);
      if (v === "p0" || v === "p1" || v === "p2" || v === "p3") return v;
    } catch {
      /* ignore */
    }
    return "all";
  });
  useEffect(() => {
    try {
      localStorage.setItem(`${filterKey}.q`, boardQuery);
      localStorage.setItem(`${filterKey}.p`, priorityFilter);
    } catch {
      /* ignore */
    }
  }, [filterKey, boardQuery, priorityFilter]);

  // v2.6.2 — toggle the `investigar` tag on a card so the virtual split
  // works when there's no dedicated Investigar column. Optimistic UI:
  // patch the board client-side, then persist via kanban_update_card.
  const retagInvestigar = useCallback(
    async (cardId: string, addTag: boolean) => {
      if (!board) return;
      const snapshot = board;
      const target = board.cards.find((c) => c.id === cardId);
      if (!target) return;
      const tagsLower = target.tags.map((t) => t.toLowerCase());
      const hasIt = INVESTIGAR_TAGS.some((t) => tagsLower.includes(t));
      const nextTags = addTag
        ? hasIt
          ? target.tags
          : [...target.tags, "investigar"]
        : target.tags.filter(
            (t) => !INVESTIGAR_TAGS.includes(t.toLowerCase() as typeof INVESTIGAR_TAGS[number]),
          );
      if (nextTags === target.tags) return;
      const next: KanbanBoard = {
        ...board,
        cards: board.cards.map((c) =>
          c.id === cardId ? { ...c, tags: nextTags } : c,
        ),
      };
      setBoard(next);
      try {
        await invoke("kanban_update_card", {
          projectId,
          cardId,
          patch: { tags: nextTags },
        });
      } catch (e) {
        setError(String(e));
        setBoard(snapshot);
      }
    },
    [board, projectId],
  );

  const cardMatches = useCallback(
    (card: Card): boolean => {
      if (priorityFilter !== "all") {
        if (!card.tags.includes(priorityFilter)) return false;
      }
      const q = boardQuery.trim().toLowerCase();
      if (!q) return true;
      const hay = `${card.title} ${card.description ?? ""} ${card.tags.join(" ")}`.toLowerCase();
      return hay.includes(q);
    },
    [boardQuery, priorityFilter],
  );

  return {
    board,
    error,
    editing,
    setEditing,
    load,
    moveCard,
    deleteCard,
    renameColumn,
    addColumn,
    deleteColumnById,
    reorderColumn,
    // add column form
    addColOpen,
    setAddColOpen,
    addColName,
    setAddColName,
    addColRole,
    setAddColRole,
    addColBusy,
    addColInputRef,
    submitAddColumn,
    // archive
    showArchived,
    setShowArchived,
    archiveModalOpen,
    setArchiveModalOpen,
    archiveName,
    setArchiveName,
    archiveBusy,
    archives,
    archivesLoading,
    openedArchive,
    setOpenedArchive,
    archiveDone,
    openArchive,
    // filters
    boardQuery,
    setBoardQuery,
    priorityFilter,
    setPriorityFilter,
    retagInvestigar,
    cardMatches,
  };
}
