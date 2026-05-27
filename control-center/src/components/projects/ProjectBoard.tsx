// ULTRON Control Center 2.0 — Project Kanban board
//
// Loads the per-project KanbanBoard, renders columns + cards, supports HTML5
// drag-and-drop between columns with optimistic UI + rollback on backend
// failure. Card click opens CardEditorModal.
//
// Visual pass (first redesign): tighter cards, better hover, column accent,
// friendlier empty state. DnD wiring untouched.

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Bot, Plus } from "./icons";
import { useDraggableCard, useDroppableColumn } from "../../hooks/useKanbanDnd";
import type { Card, KanbanBoard, KanbanArchive, KanbanArchiveSummary } from "../../types";
import CardEditorModal from "./CardEditorModal";
import DecisionsPanel from "./DecisionsPanel";

type Props = { projectId: string; onOpenTerminal?: () => void };

// v2.6.2 — column name matchers for the "Investigar fused into Backlog" feature.
// USER's quote: "Investigar prefiero que este en la misma columna que backlog
// (dividida en 2)." The Backlog column hosts two visually-separated sub-sections:
// the regular Backlog cards, and an Investigar sub-section. We support two data
// shapes:
//   1. A dedicated "Investigar"/"Research" column exists — we hide it from the
//      regular column row and render its cards inside the Backlog column's
//      Investigar sub-section. Drag-drop targets either column id naturally.
//   2. No dedicated column — cards in the Backlog column whose tags include
//      `investigar` or `research` move to the Investigar sub-section. Drag-drop
//      between sub-sections toggles the tag on/off (card column_id stays as
//      Backlog).
function isBacklogColumn(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes("backlog") || n === "todo" || n === "to do";
}
function isInvestigarColumn(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n.includes("investig") || // investigar / investigate
    n === "research" ||
    n.includes("research") ||
    n === "explore"
  );
}
const INVESTIGAR_TAGS = ["investigar", "research", "investigate"] as const;
function hasInvestigarTag(card: Card): boolean {
  return card.tags.some((t) => INVESTIGAR_TAGS.includes(t.toLowerCase() as typeof INVESTIGAR_TAGS[number]));
}

export default function ProjectBoard({ projectId, onOpenTerminal }: Props) {
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
        // Mirror the move into today's workday so Done moves count as
        // completed goals and other moves leave a context note. Non-fatal:
        // if no active workday exists, the backend returns Ok(None) and we
        // do nothing. Errors are swallowed because the kanban move itself
        // already succeeded — the user does not benefit from a red banner.
        const movedCard = snapshot?.cards.find((c) => c.id === cardId);
        const targetCol = next.columns.find((c) => c.id === targetColumnId);
        if (movedCard && targetCol) {
          void invoke("workday_record_kanban_event", {
            projectId,
            cardId,
            cardTitle: movedCard.title,
            targetColumn: targetCol.name,
          }).catch((e) => {
            // KIRKARDO 1 MED — kanban move already succeeded so we don't
            // bubble this to the UI, but we do log it so a systemic backend
            // failure (no active workday, perms, JSON corruption) is at
            // least visible to anyone watching devtools.
            console.warn("[workday sync]", e);
          });
        }
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

  // v2.6 (card-v26-fb-030): rename a column. Mutates the board immutably
  // and persists via kanban_save (which already accepts the whole board).
  const renameColumn = useCallback(
    async (columnId: string, newName: string) => {
      if (!board) return;
      const trimmed = newName.trim();
      if (!trimmed) return;
      const snapshot = board;
      const next: KanbanBoard = {
        ...board,
        columns: board.columns.map((c) =>
          c.id === columnId ? { ...c, name: trimmed } : c,
        ),
      };
      setBoard(next);
      try {
        await invoke("kanban_save", { projectId, board: next });
      } catch (e) {
        setError(String(e));
        setBoard(snapshot);
      }
    },
    [board, projectId],
  );

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

  if (error && !board) {
    return (
      <div className="p-4 text-xs text-[var(--color-error)]">
        Failed to load board: {error}
      </div>
    );
  }
  if (!board) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-[var(--color-text-muted)]">
        Loading…
      </div>
    );
  }

  return (
    <>
      {/* v2.x: lightweight breadcrumb so it's clear this kanban is scoped to
          the project — distinct from the global Plans tab (which lives at
          ~/.ultron/plans/PLANS.json). The Plans tab now holds cross-project
          personal items only. */}
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-1.5 border-b border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 py-1 text-[11.5px] uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
          <span>Project</span>
          <span className="text-[var(--color-text-faint)]">/</span>
          <span className="text-[var(--color-text-secondary)]">Board</span>
        </div>
        {/* DecisionsPanel — collapsible right rail, sibling of the kanban columns.
            Does NOT participate in drag-drop (KIRKARDO 24). */}
        <DecisionsPanel projectId={projectId} />
        {/* v2.6: board toolbar — search + priority filter chips. Persists
            per-project so the user's view survives reloads. */}
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 py-2 text-[11.5px]">
          <input
            type="text"
            value={boardQuery}
            onChange={(e) => setBoardQuery(e.target.value)}
            placeholder="Search cards…"
            className="min-w-[180px] flex-1 rounded px-2 py-1 text-[11.5px] outline-none"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border-strong)",
              color: "var(--color-text)",
              maxWidth: 320,
            }}
          />
          <div
            className="flex items-center gap-0.5 rounded p-0.5"
            style={{
              background: "var(--color-surface-1)",
              border: "1px solid var(--color-border-strong)",
            }}
            title="Filter by priority"
          >
            {(["all", "p0", "p1", "p2", "p3"] as const).map((p) => {
              const active = priorityFilter === p;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPriorityFilter(p)}
                  className="rounded px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wide transition-colors"
                  style={{
                    background: active
                      ? "var(--color-surface-3)"
                      : "transparent",
                    color: active
                      ? "var(--color-text)"
                      : "var(--color-text-tertiary)",
                  }}
                >
                  {p}
                </button>
              );
            })}
          </div>
          {(boardQuery || priorityFilter !== "all") && (
            <button
              type="button"
              onClick={() => {
                setBoardQuery("");
                setPriorityFilter("all");
              }}
              className="rounded px-2 py-0.5 text-[11.5px]"
              style={{
                background: "transparent",
                color: "var(--color-text-tertiary)",
                border: "1px solid var(--color-border)",
              }}
              title="Clear filters"
            >
              Clear
            </button>
          )}
          {/* v2.6.2 — Archive Done + Show Archived toolbar buttons. USER's
              quote: "me falta un botón para eliminar todos los Done y
              archivarlos en grupos que yo puedo poner nombres". Archives live
              under ~/.ultron/cockpit/projects/<id>/archives/<name>.json. */}
          {(() => {
            const doneCount = board.cards.filter((c) => {
              const col = board.columns.find((x) => x.id === c.column_id);
              return col ? /done|complete/i.test(col.name) : false;
            }).length;
            return (
              <button
                type="button"
                onClick={() => setArchiveModalOpen(true)}
                disabled={doneCount === 0}
                className="rounded px-2 py-0.5 text-[11.5px] font-medium transition-colors disabled:opacity-40"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-secondary)",
                  border: "1px solid var(--color-border-strong)",
                }}
                title={
                  doneCount > 0
                    ? `Move all ${doneCount} Done card${doneCount === 1 ? "" : "s"} into a named archive group`
                    : "No Done cards to archive"
                }
              >
                Archive Done {doneCount > 0 ? `(${doneCount})` : ""}
              </button>
            );
          })()}
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            className="rounded px-2 py-0.5 text-[11.5px] transition-colors"
            style={{
              background: showArchived ? "var(--color-accent)" : "transparent",
              color: showArchived
                ? "var(--color-accent-text)"
                : "var(--color-text-tertiary)",
              border: `1px solid ${showArchived ? "var(--color-accent)" : "var(--color-border)"}`,
            }}
            title="Toggle the Library-style grid of historical Done archives"
          >
            {showArchived ? "Hide Archived" : "Show Archived"}
          </button>
          <span className="ml-auto text-[11.5px]" style={{ color: "var(--color-text-faint)" }}>
            {board.cards.filter(cardMatches).length} / {board.cards.length} cards
          </span>
        </div>
        {/* v2.6.2 — when "Show Archived" is on, render the Library-style box
            grid instead of the live columns. Click a box to inspect its
            cards in a read-only panel. */}
        {showArchived ? (
          <div className="flex flex-1 flex-col overflow-y-auto p-3">
            <div className="mb-2 text-[11.5px] text-[var(--color-text-tertiary)]">
              {archivesLoading
                ? "Loading archives…"
                : archives.length === 0
                  ? "No archives yet — use 'Archive Done' to create one."
                  : `${archives.length} archive group${archives.length === 1 ? "" : "s"}`}
            </div>
            <div
              className="grid gap-3"
              style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}
            >
              {archives.map((a) => (
                <button
                  key={a.name}
                  type="button"
                  onClick={() => void openArchive(a.name)}
                  className="flex h-[120px] flex-col justify-between rounded-md p-3 text-left transition-all hover:-translate-y-px"
                  style={{
                    background: "var(--color-surface-2)",
                    border: "1px solid var(--color-border)",
                    boxShadow: "inset 0 2px 0 var(--color-border)",
                  }}
                  title={`${a.card_count} card${a.card_count === 1 ? "" : "s"} archived ${a.archived_at}`}
                >
                  <div className="text-[10px] uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
                    Archive
                  </div>
                  <div className="truncate text-[14px] font-semibold text-[var(--color-text)]">
                    {a.name}
                  </div>
                  <div className="flex items-center justify-between text-[10.5px] text-[var(--color-text-faint)]">
                    <span>{a.archived_at}</span>
                    <span
                      className="rounded px-1.5 py-0.5 tabular-nums"
                      style={{
                        background: "var(--color-surface-3)",
                        color: "var(--color-text-secondary)",
                      }}
                    >
                      {a.card_count}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-1 gap-3 overflow-x-auto p-3">
          {(() => {
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
            return visibleCols.map((col) => {
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
                    onDispatchPrompt={(prompt) =>
                      void dispatchOrchestratorPrompt(
                        projectId,
                        col.name,
                        prompt,
                        backlogCards.map((c) => c.title),
                      ).then(() => onOpenTerminal?.())
                    }
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
                  onDispatchPrompt={(prompt) =>
                    void dispatchOrchestratorPrompt(
                      projectId,
                      col.name,
                      prompt,
                      board.cards
                        .filter((c) => c.column_id === col.id)
                        .map((c) => c.title),
                    ).then(() => onOpenTerminal?.())
                  }
                  onRename={(newName) => void renameColumn(col.id, newName)}
                />
              );
            });
          })()}
          </div>
        )}
      </div>
      {editing && (
        <CardEditorModal
          projectId={projectId}
          board={board}
          {...(editing.mode === "create"
            ? { mode: "create" as const, columnId: editing.columnId, card: null }
            : {
                mode: "edit" as const,
                columnId: editing.card.column_id,
                card: editing.card,
              })}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
      {error && board && (
        <div className="absolute right-2 bottom-2 rounded-md border border-[var(--color-error)] bg-[var(--color-surface-2)] px-2 py-1 text-xs text-[var(--color-error)]">
          {error}
        </div>
      )}
      {/* v2.6.2 — Archive Done prompt modal. Asks for a group name, then
          backend moves all Done cards into the archive file. */}
      {archiveModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          role="dialog"
          aria-modal="true"
          onClick={() => {
            if (!archiveBusy) {
              setArchiveModalOpen(false);
              setArchiveName("");
            }
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-md bg-[var(--color-surface-1)] p-4 shadow-lg"
            style={{ border: "1px solid var(--color-border-strong)" }}
          >
            <h3 className="text-[14px] font-semibold text-[var(--color-text)]">
              Archive Done cards
            </h3>
            <p className="mt-1 text-[11.5px] text-[var(--color-text-tertiary)]">
              Move every card currently in a Done column into a named archive
              group. The cards disappear from the live board but stay accessible
              via "Show Archived".
            </p>
            <label className="mt-3 block text-[10.5px] uppercase tracking-wide text-[var(--color-text-tertiary)]">
              Archive name
            </label>
            <input
              autoFocus
              value={archiveName}
              onChange={(e) => setArchiveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && archiveName.trim() && !archiveBusy) {
                  void archiveDone(archiveName);
                }
              }}
              placeholder={`e.g. ${new Date().toISOString().slice(0, 10)}-sprint`}
              className="mt-1 w-full rounded px-2 py-1.5 text-[12.5px] outline-none"
              style={{
                background: "var(--color-surface-2)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
              }}
            />
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                disabled={archiveBusy}
                onClick={() => {
                  setArchiveModalOpen(false);
                  setArchiveName("");
                }}
                className="rounded px-3 py-1.5 text-[12px]"
                style={{
                  background: "transparent",
                  color: "var(--color-text-tertiary)",
                  border: "1px solid var(--color-border-strong)",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={archiveBusy || !archiveName.trim()}
                onClick={() => void archiveDone(archiveName)}
                className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-40"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-accent-text)",
                }}
              >
                {archiveBusy ? "Archiving…" : "Archive"}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* v2.6.2 — opened-archive read-only viewer panel. */}
      {openedArchive && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-6"
          role="dialog"
          aria-modal="true"
          onClick={() => setOpenedArchive(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="my-8 w-full max-w-3xl rounded-md bg-[var(--color-surface-1)] p-4 shadow-lg"
            style={{ border: "1px solid var(--color-border-strong)" }}
          >
            <div className="flex items-baseline justify-between">
              <div>
                <h3 className="text-[14px] font-semibold text-[var(--color-text)]">
                  Archive · {openedArchive.name}
                </h3>
                <p className="mt-0.5 text-[11.5px] text-[var(--color-text-tertiary)]">
                  {openedArchive.cards.length} card
                  {openedArchive.cards.length === 1 ? "" : "s"} · archived{" "}
                  {openedArchive.archived_at}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpenedArchive(null)}
                className="rounded px-2 py-0.5 text-[11.5px]"
                style={{
                  background: "transparent",
                  color: "var(--color-text-tertiary)",
                  border: "1px solid var(--color-border)",
                }}
              >
                Close
              </button>
            </div>
            <div className="mt-3 max-h-[60vh] space-y-1.5 overflow-y-auto pr-1">
              {openedArchive.cards.map((c) => (
                <div
                  key={c.id}
                  className="rounded-md p-2 text-xs"
                  style={{
                    background: "var(--color-surface-2)",
                    border: "1px solid var(--color-border)",
                  }}
                >
                  <div className="font-medium text-[var(--color-text)]">
                    {c.title}
                  </div>
                  {c.description && (
                    <div className="mt-0.5 whitespace-pre-wrap text-[11px] text-[var(--color-text-secondary)]">
                      {c.description}
                    </div>
                  )}
                  {c.tags.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {c.tags.map((t) => (
                        <span
                          key={t}
                          className="rounded px-1.5 py-0.5 text-[9.5px]"
                          style={{
                            background: "var(--color-surface-0)",
                            color: "var(--color-text-tertiary)",
                          }}
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

type ColumnProps = {
  columnId: string;
  name: string;
  cards: Card[];
  onDropCard: (cardId: string, beforeCardId: string | null) => void;
  onAddCard: () => void;
  onEditCard: (card: Card) => void;
  onDeleteCard: (cardId: string) => void;
  onDispatchPrompt: (prompt: string) => void;
  // v2.6 (card-v26-fb-030): rename column via double-click on header name.
  onRename: (newName: string) => void;
};

// v2.6.2 — Backlog column with a vertical split: "Backlog" sub-section on top,
// "Investigar" sub-section below. Each sub-section is its own DnD target.
type SplitBacklogProps = {
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
  onDispatchPrompt: (prompt: string) => void;
  onRename: (newName: string) => void;
  backlogName: string;
};

function SplitBacklogColumn({
  backlogColumnId,
  investigarColumnId,
  backlogCards,
  investigarCards,
  investigarColumnExists,
  onDropCard,
  onAddCard,
  onEditCard,
  onDeleteCard,
  onDispatchPrompt,
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
  const [menuOpen, setMenuOpen] = useState(false);
  const presets = useMemo(() => presetsForColumn(backlogName), [backlogName]);
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
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-accent)]"
            aria-label="Dispatch AI on this column"
            title="Dispatch AI session with this column's context"
          >
            <Bot size={12} />
          </button>
        </div>
        {menuOpen && (
          <div
            className="absolute right-1 top-9 z-20 w-60 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] shadow-lg"
            onMouseLeave={() => setMenuOpen(false)}
          >
            <div className="border-b border-[var(--color-border)] px-3 py-1.5 text-[11.5px] uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
              Dispatch for {backlogName}
            </div>
            {presets.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onDispatchPrompt(p.prompt);
                }}
                className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-accent)]"
                title={p.prompt}
              >
                {p.label}
              </button>
            ))}
          </div>
        )}
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

/** Per-column orchestrator presets — each entry maps a column name (matched
 *  case-insensitive substring) to a list of named prompts. The button on the
 *  column header opens a popover with these and dispatches the chosen prompt
 *  as a Claude PTY session preseeded with the column context. */
type ColumnPreset = { label: string; prompt: string };

function presetsForColumn(name: string): ColumnPreset[] {
  const n = name.toLowerCase();
  if (n.includes("backlog") || n.includes("todo") || n.includes("to do")) {
    return [
      {
        label: "Brainstorm new cards",
        prompt: `You are looking at the BACKLOG of this project. Propose 3-5 new tasks that would belong here, based on the project layout and the cards already present. Format each as a card title plus 1-line description.`,
      },
      {
        label: "Prioritise backlog",
        prompt: `Review the BACKLOG and rank the cards by priority (P0 critical, P1 high, P2 medium, P3 nice-to-have). Briefly justify each ranking.`,
      },
    ];
  }
  if (n.includes("open") || n.includes("ready")) {
    return [
      {
        label: "Pick next",
        prompt: `Look at the OPEN column. Pick the single highest-value card to start RIGHT NOW. State which one and why, then outline the first three concrete steps.`,
      },
    ];
  }
  if (n.includes("progress") || n.includes("doing")) {
    return [
      {
        label: "Resume work",
        prompt: `These cards are IN PROGRESS. Pick the one most likely to be unblocked quickly, summarise where it left off, and continue the implementation.`,
      },
      {
        label: "Status check",
        prompt: `For each IN PROGRESS card, summarise current status in one line and flag anything blocked.`,
      },
    ];
  }
  if (n.includes("review")) {
    return [
      {
        label: "Review cards",
        prompt: `Each of these cards is awaiting REVIEW. For each one, identify what needs to be verified, suggest a quick QA plan, and call out any obvious gaps.`,
      },
    ];
  }
  if (n.includes("done") || n.includes("complete")) {
    return [
      {
        label: "Summarise wins",
        prompt: `Write a one-line victory summary for each DONE card. Frame it as a changelog line.`,
      },
    ];
  }
  if (n.includes("block")) {
    return [
      {
        label: "Diagnose blockers",
        prompt: `These cards are BLOCKED. For each one, list the suspected blocker, who/what could unblock it, and a fallback path.`,
      },
    ];
  }
  return [
    {
      label: "Discuss this column",
      prompt: `Discuss the cards currently in this column. What pattern do you see? What would you do next?`,
    },
  ];
}

/** Spawn a Claude PTY pre-seeded with the column context. We invoke
 *  `pty_spawn` directly so the session opens in the project's Terminal tab
 *  (the user can flip to it manually). Prompt is currently not auto-pasted —
 *  the wrapper script's clipboard route is the safer fallback — but the
 *  column name + card titles are baked into the prompt so context is clear. */
async function dispatchOrchestratorPrompt(
  projectId: string,
  columnName: string,
  prompt: string,
  cardTitles: string[],
): Promise<void> {
  const titlesBlock =
    cardTitles.length > 0
      ? cardTitles.map((t) => `  - ${t}`).join("\n")
      : "  (no cards in this column)";
  const fullPrompt = `[Kanban orchestrator — column: ${columnName}]\n\nCards currently in "${columnName}":\n${titlesBlock}\n\nTask: ${prompt}\n`;
  try {
    await invoke("pty_spawn", {
      projectId,
      cardId: null,
      provider: "claude",
      agent: null,
      cwd: ".",
      prompt: fullPrompt,
    });
  } catch (e) {
    console.error("dispatchOrchestratorPrompt failed", e);
  }
}

/** Lookup an accent colour per well-known column name. Falls back to muted. */
function columnAccent(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("backlog") || n.includes("todo") || n.includes("to do"))
    return "#6e7681";
  if (n.includes("progress") || n.includes("doing")) return "#58a6ff";
  if (n.includes("review")) return "#d29922";
  if (n.includes("done") || n.includes("complete")) return "#3fb950";
  if (n.includes("block")) return "#f85149";
  return "var(--color-accent)";
}

function BoardColumn({
  columnId,
  name,
  cards,
  onDropCard,
  onAddCard,
  onEditCard,
  onDeleteCard,
  onDispatchPrompt,
  onRename,
}: ColumnProps) {
  const { columnDropProps, cardDropProps, hover } = useDroppableColumn(
    columnId,
    ({ payload, beforeCardId }) => onDropCard(payload.card_id, beforeCardId),
  );
  const accent = columnAccent(name);
  const [menuOpen, setMenuOpen] = useState(false);
  const presets = useMemo(() => presetsForColumn(name), [name]);
  // v2.6 (card-v26-fb-030): inline rename on double-click of the column name.
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(name);
  useEffect(() => {
    if (!editingName) setDraftName(name);
  }, [name, editingName]);

  return (
    <div
      {...columnDropProps}
      className={[
        // v2.x: min-w-[280px] + flex-1 so columns absorb the right-side
        // dead space the user complained about, while still horizontal-
        // scrolling on narrow viewports.
        "flex h-full min-w-[280px] flex-1 shrink-0 flex-col rounded-md border bg-[var(--color-surface-1)] transition-colors",
        hover
          ? "border-[var(--color-accent)] bg-[var(--color-surface-2)]"
          : "border-[var(--color-border)]",
      ].join(" ")}
    >
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
              title="Double-click to rename"
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
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-accent)]"
            aria-label="Dispatch AI on this column"
            title="Dispatch AI session with this column's context"
          >
            <Bot size={12} />
          </button>
          {isBacklogColumn(name) && (
            <button
              onClick={onAddCard}
              className="flex items-center gap-1 rounded px-2 py-1 text-[11.5px] font-medium text-[var(--color-text-muted)] hover:bg-[var(--color-accent)]/10 hover:text-[var(--color-accent)]"
              aria-label="Add card"
              title="Add card"
            >
              <Plus size={12} />
              Add
            </button>
          )}
        </div>
        {menuOpen && (
          <div
            className="absolute right-1 top-9 z-20 w-60 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] shadow-lg"
            onMouseLeave={() => setMenuOpen(false)}
          >
            <div className="border-b border-[var(--color-border)] px-3 py-1.5 text-[11.5px] uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
              Dispatch for {name}
            </div>
            {presets.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onDispatchPrompt(p.prompt);
                }}
                className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-accent)]"
                title={p.prompt}
              >
                {p.label}
              </button>
            ))}
          </div>
        )}
      </div>
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

type CardProps = {
  card: Card;
  dropProps: {
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: () => void;
    onDrop: (e: React.DragEvent) => void;
  };
  onEdit: () => void;
  onDelete: () => void;
};

function BoardCard({ card, dropProps, onEdit, onDelete }: CardProps) {
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
