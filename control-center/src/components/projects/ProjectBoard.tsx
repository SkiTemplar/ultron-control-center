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
import { BoardExtensionsContext, type BoardExtensions } from "./project-board/BoardExtensions";
import type { ReactNode } from "react";
import type { KanbanBoard } from "../../types";

export type BoardHeaderContext = { board: KanbanBoard; reload: () => Promise<void> };

type Props = {
  projectId: string;
  /** Extras de un tablero concreto (Portfolio); sin ellos se pinta como siempre. */
  extensions?: BoardExtensions;
  /** Sustituye la miga «Proyecto / Tablero» por una cabecera propia. */
  renderHeader?: (ctx: BoardHeaderContext) => ReactNode;
};

const NO_EXTENSIONS: BoardExtensions = {};

export default function ProjectBoard({ projectId, extensions = NO_EXTENSIONS, renderHeader }: Props) {
  const {
    board,
    error,
    editing,
    setEditing,
    load,
    moveCard,
    deleteCard,
    pendingDelete,
    undoDeleteCard,
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
        No se pudo cargar el tablero: {error}
      </div>
    );
  }
  if (!board) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-[var(--color-text-muted)]">
        Cargando tablero…
      </div>
    );
  }

  return (
    <BoardExtensionsContext.Provider value={extensions}>
      {/* v2.x: lightweight breadcrumb so it's clear this kanban is scoped to
          the project — distinct from the global Plans tab (which lives at
          ~/.ultron/plans/PLANS.json). The Plans tab now holds cross-project
          personal items only. */}
      <div className="flex h-full flex-col">
        {renderHeader ? (
          renderHeader({ board, reload: load })
        ) : (
          <div className="flex items-center gap-1.5 border-b border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 py-1 text-[11.5px] uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
            <span>Proyecto</span>
            <span className="text-[var(--color-text-faint)]">/</span>
            <span className="text-[var(--color-text-secondary)]">Tablero</span>
          </div>
        )}
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
      {pendingDelete && (
        <div
          role="status"
          className="absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] px-3 py-1.5 text-xs text-[var(--color-text)] shadow-lg"
        >
          <span className="max-w-[320px] truncate">Tarjeta «{pendingDelete.title}» borrada.</span>
          <button
            type="button"
            onClick={undoDeleteCard}
            className="rounded px-2 py-0.5 font-medium text-[var(--color-accent)] hover:bg-[var(--color-surface-3)]"
          >
            Deshacer
          </button>
        </div>
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
    </BoardExtensionsContext.Provider>
  );
}
