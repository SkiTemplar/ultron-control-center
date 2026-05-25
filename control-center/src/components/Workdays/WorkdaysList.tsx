// WorkdaysList - lista de workdays con filtro por status + creacion rapida.
//
// Tauri commands consumidos:
//   list_workdays(status_filter, date_from, date_to, limit) -> Workday[]
//   create_workday(title, planned_date, template_id, goals) -> Workday

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Workday, WorkdayStatus } from "./types";

interface WorkdaysListProps {
  selectedId: string | null;
  onSelect: (id: string) => void;
  refreshKey: number;
  onCreated: (wd: Workday) => void;
}

type StatusFilter = "all" | WorkdayStatus;

const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "planned", label: "Planned" },
  { id: "in_progress", label: "Active" },
  { id: "paused", label: "Paused" },
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

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function WorkdaysList({
  selectedId,
  onSelect,
  refreshKey,
  onCreated,
}: WorkdaysListProps) {
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [items, setItems] = useState<Workday[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // create form state
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDate, setNewDate] = useState(todayIso());
  const [creating, setCreating] = useState(false);

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

  async function handleCreate() {
    if (!newTitle.trim()) return;
    setCreating(true);
    try {
      const wd = await invoke<Workday>("create_workday", {
        title: newTitle.trim(),
        plannedDate: newDate || null,
        templateId: null,
        goals: null,
      });
      onCreated(wd);
      setNewTitle("");
      setNewDate(todayIso());
      setShowCreate(false);
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div
      className="flex h-full flex-col"
      style={{ background: "var(--color-surface-1)", minWidth: 320 }}
    >
      {/* Filter strip */}
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
        <button
          type="button"
          onClick={() => setShowCreate((v) => !v)}
          className="ml-auto rounded px-2 py-1 text-[11px] font-semibold"
          style={{
            background: "var(--color-accent, #2563eb)",
            color: "white",
          }}
        >
          + New
        </button>
      </div>

      {/* Create modal (inline) */}
      {showCreate && (
        <div
          className="flex flex-col gap-2 border-b px-3 py-3"
          style={{
            borderColor: "var(--color-border)",
            background: "var(--color-surface-2)",
          }}
        >
          <input
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Workday title"
            autoFocus
            className="rounded px-2 py-1 text-[12px]"
            style={{
              background: "var(--color-surface-1)",
              border: "1px solid var(--color-border-strong)",
              color: "var(--color-text)",
            }}
          />
          <input
            type="date"
            value={newDate}
            onChange={(e) => setNewDate(e.target.value)}
            className="rounded px-2 py-1 text-[12px]"
            style={{
              background: "var(--color-surface-1)",
              border: "1px solid var(--color-border-strong)",
              color: "var(--color-text)",
            }}
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleCreate}
              disabled={creating || !newTitle.trim()}
              className="flex-1 rounded px-2 py-1 text-[11px] font-medium disabled:opacity-50"
              style={{
                background: "var(--color-accent, #2563eb)",
                color: "white",
              }}
            >
              {creating ? "Creating..." : "Create"}
            </button>
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="rounded px-2 py-1 text-[11px]"
              style={{
                background: "transparent",
                border: "1px solid var(--color-border)",
                color: "var(--color-text-secondary)",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* List */}
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
            No workdays yet.
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
