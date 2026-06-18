import { type DragEvent as ReactDragEvent } from "react";

// Plans tab — read/write PLANS.json. Kanban (Open / In progress / Blocked /
// Resolved) + create/edit/delete + clean-resolved bulk + "Open resolution
// session" per card that spawns Claude in the ULTRON cwd with the plan
// context preseeded as the first prompt.

import { usePlans } from "./plans/usePlans";
import { KanbanColumn } from "./plans/KanbanColumn";
import { PlanModal } from "./plans/PlanModal";
import { ArchivedDrawer } from "./plans/ArchivedDrawer";
import { DeleteConfirmDialog, ArchiveConfirmDialog } from "./plans/ConfirmDialogs";
import { COLUMNS, BOTTOM_COLUMNS } from "./plans/types";

export function Plans() {
  const {
    report,
    loading,
    error,
    query,
    setQuery,
    priorityFilter,
    expanded,
    modalState,
    setModalState,
    modalBusy,
    modalError,
    pendingDelete,
    setPendingDelete,
    deleteBusy,
    pendingClean,
    setPendingClean,
    cleanBusy,
    info,
    aiBusy,
    archivedOpen,
    setArchivedOpen,
    archivedDays,
    setArchivedDays,
    draggingId,
    setDraggingId,
    dragOverColumn,
    setDragOverColumn,
    archivedItems,
    grouped,
    resolvedCount,
    totalActive,
    priorityKeys,
    load,
    move,
    submitPlan,
    confirmDelete,
    spawnClaudePlanFlow,
    aiSprintPlan,
    cleanResolved,
    openResolutionSession,
    togglePriority,
    toggleExpanded,
    startNew,
    startEdit,
  } = usePlans();

  // Drop handler for kanban columns. Reads the plan id from dataTransfer
  // and routes through `move` — the same `patch_plan_status` call the
  // expand+button flow uses. No-op if dropped on the card's own column.
  function handleColumnDrop(e: ReactDragEvent, target: string) {
    e.preventDefault();
    setDragOverColumn(null);
    setDraggingId(null);
    const id = e.dataTransfer.getData("text/plain");
    if (!id) return;
    const current = report?.items.find((it) => it.id === id);
    if (current && current.status === target) return;
    void move(id, target);
  }

  function handleDragOver(e: ReactDragEvent, key: string) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOverColumn !== key) setDragOverColumn(key);
  }

  function handleDragLeave(e: ReactDragEvent, key: string) {
    // Only clear when the pointer actually leaves the lane, not
    // when it crosses a child card boundary.
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragOverColumn((prev) => (prev === key ? null : prev));
    }
  }

  // Shared props forwarded to every KanbanColumn instance.
  const columnActionProps = {
    onNew: startNew,
    onSprintAi: aiSprintPlan,
    sprintAiBusy: aiBusy,
    onExecute: () => spawnClaudePlanFlow("execute"),
    onReview: () => spawnClaudePlanFlow("review"),
    onResolveBlock: () => spawnClaudePlanFlow("resolve"),
    onArchiveSelected: () => setPendingClean(true),
    archiveDisabled: resolvedCount === 0,
    archiveCount: resolvedCount,
  };

  return (
    <div className="flex h-full flex-col overflow-hidden px-8 py-6">
      <header className="mb-4 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-semibold leading-tight">Plans</h1>
          <p
            className="mt-1 text-[13px]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            ~/.ultron/plans/PLANS.json - {totalActive} items - updated {report?.updated_at?.slice(0, 19) ?? "-"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setArchivedOpen(true)}
            className="rounded px-3 py-1.5 text-[12px] transition-colors"
            style={{
              background: "transparent",
              color: "var(--color-text-tertiary)",
              border: "1px solid var(--color-border-strong)",
            }}
            title={`Show archived plans (resolved > ${archivedDays} days). Auto-archive runs every 5 min.`}
          >
            Show archived
          </button>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="rounded px-3 py-1.5 text-[12px] transition-colors disabled:opacity-50"
            style={{
              background: "transparent",
              color: "var(--color-text-tertiary)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>
      </header>

      {/* v2.x slim: the rolled-up stats strip (total + priority counts +
          archived) has been removed at the user's request. The Plans tab is
          now intentionally focused on the kanban board itself. The archived
          drawer is still reachable via the "Show archived" button in the
          header. Per-column counts live in the column headers below. */}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by id, title, tag or description..."
          className="rounded px-3 py-1.5 text-[12.5px]"
          style={{
            background: "var(--color-surface-2)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
            outline: "none",
            minWidth: 280,
          }}
        />
        {priorityKeys.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => togglePriority(p)}
            className="rounded px-2 py-1 text-[11.5px] transition-colors"
            style={{
              background: priorityFilter.has(p)
                ? "var(--color-surface-3)"
                : "transparent",
              color: priorityFilter.has(p)
                ? "var(--color-text)"
                : "var(--color-text-tertiary)",
              border: `1px solid ${
                priorityFilter.has(p)
                  ? "var(--color-border-strong)"
                  : "var(--color-border)"
              }`,
            }}
          >
            {p}
          </button>
        ))}
      </div>

      {error && (
        <div
          className="mb-3 rounded p-3 text-[12px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {info && (
        <div
          className="mb-3 rounded p-2 text-[12px]"
          style={{
            background: "rgba(63, 185, 80, 0.08)",
            border: "1px solid rgba(63, 185, 80, 0.22)",
            color: "var(--color-success)",
          }}
        >
          {info}
        </div>
      )}

      {/* v15.5.18 (user request): 2-row layout. Top row = active states
          (open / in_progress / resolved). Bottom row = exception + terminal
          states (revision / blocked / rejected). Stops the horizontal scroll
          caused by long titles in `open` and gives the eye the natural
          reading order. `merged` plans live in the Archived drawer. */}
      <div className="flex flex-1 flex-col gap-3 overflow-hidden">
        <div className="grid flex-1 grid-cols-3 gap-3 overflow-hidden">
          {COLUMNS.filter((c) => ["open", "in_progress", "resolved"].includes(c.key)).map((c) => (
            <KanbanColumn
              key={c.key}
              columnKey={c.key}
              label={c.label}
              tint={c.tint}
              items={grouped[c.key] ?? []}
              dragOverColumn={dragOverColumn}
              draggingId={draggingId}
              expanded={expanded}
              onToggleExpanded={toggleExpanded}
              onMove={move}
              onEdit={startEdit}
              onDelete={setPendingDelete}
              onOpenSession={openResolutionSession}
              onDragStart={setDraggingId}
              onDragEnd={() => { setDraggingId(null); setDragOverColumn(null); }}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleColumnDrop}
              {...columnActionProps}
            />
          ))}
        </div>
        {/* Bottom row — exception + terminal states
            (revision / blocked / rejected). grid-cols-3 mirrors the top
            row so the 3 lanes line up vertically with open / in_progress
            / resolved (was md:grid-cols-4, a leftover from when `merged`
            was a 4th column — it left a dead slot and broke alignment). */}
        <div className="grid grid-cols-3 gap-3 overflow-hidden" style={{ maxHeight: "45%" }}>
          {COLUMNS.filter((c) => BOTTOM_COLUMNS.includes(c.key)).map((c) => (
            <KanbanColumn
              key={c.key}
              columnKey={c.key}
              label={c.label}
              tint={c.tint}
              items={grouped[c.key] ?? []}
              dragOverColumn={dragOverColumn}
              draggingId={draggingId}
              expanded={expanded}
              onToggleExpanded={toggleExpanded}
              onMove={move}
              onEdit={startEdit}
              onDelete={setPendingDelete}
              onOpenSession={openResolutionSession}
              onDragStart={setDraggingId}
              onDragEnd={() => { setDraggingId(null); setDragOverColumn(null); }}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleColumnDrop}
              {...columnActionProps}
            />
          ))}
        </div>
      </div>

      {archivedOpen && (
        <ArchivedDrawer
          archivedItems={archivedItems}
          archivedDays={archivedDays}
          onDaysChange={setArchivedDays}
          onClose={() => setArchivedOpen(false)}
          onRestore={(id) => move(id, "resolved")}
        />
      )}

      {modalState && (
        <PlanModal
          state={modalState}
          busy={modalBusy}
          error={modalError}
          onChange={setModalState}
          onSubmit={submitPlan}
          onClose={() => setModalState(null)}
        />
      )}

      {pendingDelete && (
        <DeleteConfirmDialog
          plan={pendingDelete}
          busy={deleteBusy}
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {pendingClean && (
        <ArchiveConfirmDialog
          resolvedCount={resolvedCount}
          busy={cleanBusy}
          onConfirm={cleanResolved}
          onCancel={() => setPendingClean(false)}
        />
      )}
    </div>
  );
}
