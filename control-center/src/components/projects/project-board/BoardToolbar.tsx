import { Plus } from "../icons";
import type { KanbanBoard, ColumnRole } from "../../../types";

type BoardToolbarProps = {
  board: KanbanBoard;
  boardQuery: string;
  setBoardQuery: (v: string) => void;
  priorityFilter: "all" | "p0" | "p1" | "p2" | "p3";
  setPriorityFilter: (v: "all" | "p0" | "p1" | "p2" | "p3") => void;
  cardMatchesCount: number;
  showArchived: boolean;
  setShowArchived: (fn: (v: boolean) => boolean) => void;
  setArchiveModalOpen: (v: boolean) => void;
  addColOpen: boolean;
  setAddColOpen: (fn: (v: boolean) => boolean) => void;
  addColName: string;
  setAddColName: (v: string) => void;
  addColRole: ColumnRole;
  setAddColRole: (v: ColumnRole) => void;
  addColBusy: boolean;
  addColInputRef: React.RefObject<HTMLInputElement | null>;
  submitAddColumn: () => void;
};

export function BoardToolbar({
  board,
  boardQuery,
  setBoardQuery,
  priorityFilter,
  setPriorityFilter,
  cardMatchesCount,
  showArchived,
  setShowArchived,
  setArchiveModalOpen,
  addColOpen,
  setAddColOpen,
  addColName,
  setAddColName,
  addColRole,
  setAddColRole,
  addColBusy,
  addColInputRef,
  submitAddColumn,
}: BoardToolbarProps) {
  return (
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
      {/* v2.6.2 — Archive Done + Show Archived toolbar buttons. Per the
          user's request, a button bulk-removes all Done cards and archives
          them into named groups. Archives live under
          ~/.ultron/cockpit/projects/<id>/archives/<name>.json. */}
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
      {/* v2.14 — "+ Columna" button + inline popover form. */}
      <div className="relative ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setAddColOpen((v) => !v);
            if (!addColOpen) {
              setTimeout(() => addColInputRef.current?.focus(), 30);
            }
          }}
          className="flex items-center gap-1 rounded px-2 py-0.5 text-[11.5px] font-medium transition-colors"
          style={{
            background: addColOpen ? "var(--color-accent)" : "var(--color-surface-3)",
            color: addColOpen ? "var(--color-accent-text)" : "var(--color-text-secondary)",
            border: `1px solid ${addColOpen ? "var(--color-accent)" : "var(--color-border-strong)"}`,
          }}
          title="Agregar columna al board"
        >
          <Plus size={11} />
          Columna
        </button>
        {addColOpen && (
          <div
            className="absolute right-0 top-8 z-30 w-64 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-1)] p-3 shadow-lg"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setAddColOpen(() => false);
                setAddColName("");
                setAddColRole("other");
              }
            }}
          >
            <div className="mb-2 text-[10.5px] uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
              Nueva columna
            </div>
            <input
              ref={addColInputRef}
              type="text"
              value={addColName}
              onChange={(e) => setAddColName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitAddColumn();
              }}
              placeholder="Nombre de la columna"
              className="mb-2 w-full rounded px-2 py-1 text-[12px] outline-none"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border-strong)",
                color: "var(--color-text)",
              }}
            />
            <label className="mb-1 block text-[10px] uppercase tracking-wide text-[var(--color-text-tertiary)]">
              Rol
            </label>
            <select
              value={addColRole}
              onChange={(e) => setAddColRole(e.target.value as ColumnRole)}
              className="mb-3 w-full rounded px-2 py-1 text-[12px] outline-none"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border-strong)",
                color: "var(--color-text)",
              }}
            >
              <option value="todo">Todo (backlog / pendiente)</option>
              <option value="doing">Doing (en progreso)</option>
              <option value="blocked">Blocked (bloqueado)</option>
              <option value="done">Done (completado)</option>
              <option value="other">Otro</option>
            </select>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                disabled={addColBusy}
                onClick={() => {
                  setAddColOpen(() => false);
                  setAddColName("");
                  setAddColRole("other");
                }}
                className="rounded px-2.5 py-1 text-[11.5px]"
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
                disabled={addColBusy || !addColName.trim()}
                onClick={() => void submitAddColumn()}
                className="rounded px-2.5 py-1 text-[11.5px] font-medium disabled:opacity-40"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-accent-text)",
                }}
              >
                {addColBusy ? "Creando…" : "Crear"}
              </button>
            </div>
          </div>
        )}
        <span className="text-[11.5px]" style={{ color: "var(--color-text-faint)" }}>
          {cardMatchesCount} / {board.cards.length} cards
        </span>
      </div>
    </div>
  );
}
