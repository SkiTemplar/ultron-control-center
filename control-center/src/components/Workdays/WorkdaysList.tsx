// WorkdaysList - legacy list view kept for compatibility.
//
// The v2.8 redesign moved away from a manual list with a "+ New" button.
// Workdays now auto-create on session-start / kanban-move, so the only
// surface that still mounts this file is any third-party consumer that
// imported the named export. The component now renders a read-only flat
// list of recent workdays without the create form.
//
// Tauri commands consumed:
//   list_workdays(status_filter, date_from, date_to, limit) -> Workday[]

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Workday, WorkdayStatus } from "./types";

interface WorkdaysListProps {
  selectedId: string | null;
  onSelect: (id: string) => void;
  refreshKey: number;
  // Kept in the prop type so existing call sites compile, but the new model
  // never invokes it -- workdays are auto-created.
  onCreated?: (wd: Workday) => void;
}

type StatusFilter = "all" | WorkdayStatus;

const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "in_progress", label: "Active" },
  { id: "completed", label: "Done" },
  { id: "archived", label: "Archived" },
];

function statusColor(s: WorkdayStatus): string {
  switch (s) {
    case "in_progress":
      return "var(--color-accent, #22c55e)";
    case "paused":
      return "var(--color-warning, #f59e0b)";
    case "completed":
      return "var(--color-text-tertiary, #94a3b8)";
    case "archived":
      return "var(--color-text-tertiary, #64748b)";
    default:
      return "var(--color-text-secondary, #cbd5e1)";
  }
}

export function WorkdaysList({
  selectedId,
  onSelect,
  refreshKey,
}: WorkdaysListProps) {
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [items, setItems] = useState<Workday[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    invoke<Workday[]>("list_workdays", {
      statusFilter: filter === "all" ? null : filter,
      dateFrom: null,
      dateTo: null,
      limit: 100,
    })
      .then((rows) => {
        if (!cancelled) setItems(rows);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filter, refreshKey]);

  return (
    <div
      className="flex h-full flex-col"
      style={{ background: "var(--color-surface-1)", minWidth: 320 }}
    >
      <div
        className="flex flex-wrap items-center gap-1 border-b px-3 py-2"
        style={{ borderColor: "var(--color-border)" }}
      >
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            className="rounded px-2 py-1 text-[11px] font-medium transition-colors"
            style={{
              background:
                filter === f.id ? "var(--color-surface-3)" : "transparent",
              color:
                filter === f.id
                  ? "var(--color-text)"
                  : "var(--color-text-tertiary)",
              border: "1px solid var(--color-border)",
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto">
        {loading && (
          <div
            className="px-3 py-4 text-[12px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Loading...
          </div>
        )}
        {error && (
          <div
            className="px-3 py-4 text-[12px]"
            style={{ color: "var(--color-danger, #ef4444)" }}
          >
            {error}
          </div>
        )}
        {!loading && !error && items.length === 0 && (
          <div
            className="px-3 py-4 text-[12px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            No workdays yet -- launch a session to open one automatically.
          </div>
        )}
        {items.map((wd) => {
          const active = wd.id === selectedId;
          return (
            <button
              key={wd.id}
              type="button"
              onClick={() => onSelect(wd.id)}
              className="flex w-full flex-col items-start gap-1 border-b px-3 py-2 text-left transition-colors"
              style={{
                borderColor: "var(--color-border)",
                background: active
                  ? "var(--color-surface-3)"
                  : "transparent",
              }}
            >
              <div className="flex w-full items-center gap-2">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: statusColor(wd.status) }}
                />
                <span
                  className="flex-1 truncate text-[13px] font-medium"
                  style={{ color: "var(--color-text)" }}
                >
                  {wd.title}
                </span>
              </div>
              <div
                className="flex w-full items-center gap-2 text-[11px]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                <span>{wd.planned_date}</span>
                <span>{wd.status}</span>
                <span className="ml-auto">{wd.goals.length} goals</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
