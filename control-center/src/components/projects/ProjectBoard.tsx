// ULTRON Control Center 2.0 — Project Kanban board
//
// Loads the per-project KanbanBoard, renders columns + cards, supports HTML5
// drag-and-drop between columns with optimistic UI + rollback on backend
// failure. Card click opens CardEditorModal.
//
// Visual pass (first redesign): tighter cards, better hover, column accent,
// friendlier empty state. DnD wiring untouched.

import CardEditorModal from "./CardEditorModal";
import { useProjectBoard } from "./project-board/useProjectBoard";
import { BoardToolbar } from "./project-board/BoardToolbar";
import { BoardColumnsArea } from "./project-board/BoardColumnsArea";
import { ArchiveGrid } from "./project-board/ArchiveGrid";
import { ArchiveDoneModal } from "./project-board/ArchiveDoneModal";
import { ArchiveViewerModal } from "./project-board/ArchiveViewerModal";

type Props = { projectId: string };

export default function ProjectBoard({ projectId }: Props) {
  const {
    board,
    error,
    editing,
    setEditing,
    load,
    moveCard,
    deleteCard,
    renameColumn,
    deleteColumnById,
    reorderColumn,
    addColOpen,
    setAddColOpen,
    addColName,
    setAddColName,
    addColRole,
    setAddColRole,
    addColBusy,
    addColInputRef,
    submitAddColumn,
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
    boardQuery,
    setBoardQuery,
    priorityFilter,
    setPriorityFilter,
    retagInvestigar,
    cardMatches,
  } = useProjectBoard(projectId);

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
        {/* v2.6: board toolbar — search + priority filter chips. Persists
            per-project so the user's view survives reloads. */}
        <BoardToolbar
          board={board}
          boardQuery={boardQuery}
          setBoardQuery={setBoardQuery}
          priorityFilter={priorityFilter}
          setPriorityFilter={setPriorityFilter}
          cardMatchesCount={board.cards.filter(cardMatches).length}
          showArchived={showArchived}
          setShowArchived={setShowArchived}
          setArchiveModalOpen={setArchiveModalOpen}
          addColOpen={addColOpen}
          setAddColOpen={setAddColOpen}
          addColName={addColName}
          setAddColName={setAddColName}
          addColRole={addColRole}
          setAddColRole={setAddColRole}
          addColBusy={addColBusy}
          addColInputRef={addColInputRef}
          submitAddColumn={submitAddColumn}
        />
        {/* v2.6.2 — when "Show Archived" is on, render the Library-style box
            grid instead of the live columns. Click a box to inspect its
            cards in a read-only panel. */}
        {showArchived ? (
          <ArchiveGrid
            archivesLoading={archivesLoading}
            archives={archives}
            onOpenArchive={openArchive}
          />
        ) : (
          <BoardColumnsArea
            board={board}
            cardMatches={cardMatches}
            moveCard={moveCard}
            retagInvestigar={retagInvestigar}
            setEditing={setEditing}
            deleteCard={deleteCard}
            renameColumn={renameColumn}
            deleteColumnById={deleteColumnById}
            reorderColumn={reorderColumn}
          />
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
        <ArchiveDoneModal
          archiveName={archiveName}
          setArchiveName={setArchiveName}
          archiveBusy={archiveBusy}
          setArchiveModalOpen={setArchiveModalOpen}
          setArchiveName_reset={() => setArchiveName("")}
          archiveDone={archiveDone}
        />
      )}
      {/* v2.6.2 — opened-archive read-only viewer panel. */}
      {openedArchive && (
        <ArchiveViewerModal
          openedArchive={openedArchive}
          onClose={() => setOpenedArchive(null)}
        />
      )}
    </>
  );
}
