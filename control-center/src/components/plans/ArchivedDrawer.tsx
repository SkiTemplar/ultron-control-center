// ArchivedDrawer — slide-in panel showing archived / merged plans.
// Extracted from Plans.tsx as part of the cat7 split refactor.

import { PriorityBadge } from "./PriorityBadge";
import type { PlanItem } from "./types";

export function ArchivedDrawer({
  archivedItems,
  archivedDays,
  onDaysChange,
  onClose,
  onRestore,
}: {
  archivedItems: PlanItem[];
  archivedDays: number;
  onDaysChange: (days: number) => void;
  onClose: () => void;
  onRestore: (id: string) => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-end"
      style={{ background: "rgba(0,0,0,0.45)" }}
      onClick={onClose}
    >
      <div
        className="flex h-full w-full max-w-[520px] flex-col overflow-hidden"
        style={{
          background: "var(--color-surface-1)",
          borderLeft: "1px solid var(--color-border-strong)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <header
          className="flex items-center justify-between border-b px-5 py-3"
          style={{ borderColor: "var(--color-border)" }}
        >
          <div>
            <h3 className="text-[14px] font-semibold">Archived plans</h3>
            <p
              className="mt-0.5 text-[11.5px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Resolved more than {archivedDays} days ago — off the kanban
              but still in PLANS.json ({archivedItems.length} items).
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label
              className="text-[10px] uppercase tracking-wide"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Days
            </label>
            <input
              type="number"
              min={1}
              max={365}
              value={archivedDays}
              onChange={(e) =>
                onDaysChange(Math.max(1, Number(e.target.value) || 30))
              }
              className="w-16 rounded px-1.5 py-0.5 text-[12px]"
              style={{
                background: "var(--color-surface-2)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
              }}
              title="Threshold in days for auto-archiving resolved plans (default 30, persists for the session only)."
            />
            <button
              type="button"
              onClick={onClose}
              className="rounded px-2 py-0.5 text-[12px]"
              style={{ color: "var(--color-text-tertiary)" }}
              aria-label="Close"
            >
              close
            </button>
          </div>
        </header>
        <div className="flex-1 space-y-2 overflow-auto p-3">
          {archivedItems.length === 0 && (
            <p
              className="px-1 py-4 text-center text-[12px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              No archived plans yet.
            </p>
          )}
          {archivedItems.map((it) => (
            <div
              key={it.id}
              className="rounded p-2.5"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border)",
              }}
            >
              <div className="flex items-start gap-2">
                <PriorityBadge p={it.priority} />
                <div className="min-w-0 flex-1">
                  <div
                    className="text-[12.5px] font-medium leading-tight"
                    style={{ color: "var(--color-text)" }}
                  >
                    {it.title || it.id}
                  </div>
                  <div
                    className="mt-0.5 text-[10.5px]"
                    style={{
                      fontFamily: "var(--font-mono)",
                      color: "var(--color-text-faint)",
                    }}
                  >
                    {it.id} · resolved {it.resolved_at?.slice(0, 10) ?? "?"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onRestore(it.id)}
                  className="rounded px-2 py-0.5 text-[10.5px]"
                  style={{
                    background: "var(--color-surface-3)",
                    color: "var(--color-text-secondary)",
                    border: "1px solid var(--color-border)",
                  }}
                  title="Return this plan to the kanban (status=resolved) so it shows up again."
                >
                  Restore
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
