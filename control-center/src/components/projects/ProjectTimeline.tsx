// ULTRON Control Center 2.0 — Per-project Timeline sub-tab.
//
// Read-only chronological feed aggregated by the Rust backend
// (`project_timeline_list`). Renders as a vertical timeline with sticky
// day headers — newest first, grouped by yyyy-mm-dd.

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TimelineEvent, TimelineEventKind } from "../../types";

type Props = { projectId: string; projectPath?: string };

type DayGroup = {
  day: string;
  events: TimelineEvent[];
};

function groupByDay(events: TimelineEvent[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const ev of events) {
    const day = (ev.at || "").slice(0, 10) || "—";
    const last = groups[groups.length - 1];
    if (last && last.day === day) {
      last.events.push(ev);
    } else {
      groups.push({ day, events: [ev] });
    }
  }
  return groups;
}

function formatDay(iso: string): string {
  if (!iso || iso === "—") return "Unknown date";
  // Render yyyy-mm-dd directly — locale-independent and short.
  return iso;
}

function formatTime(iso: string): string {
  if (!iso) return "";
  // Slice the HH:MM out of yyyy-mm-ddTHH:MM:SSZ; fall back to raw.
  const m = iso.match(/T(\d{2}:\d{2})/);
  return m ? m[1] : "";
}

const KIND_LABEL: Record<TimelineEventKind, string> = {
  session: "Session",
  card_created: "Card created",
  card_moved: "Card moved",
  card_run: "Run",
  backup: "Backup",
};

const KIND_TINT: Record<TimelineEventKind, string> = {
  session: "#58a6ff",
  card_created: "#3fb950",
  card_moved: "#d29922",
  card_run: "#a875ff",
  backup: "#6e7681",
};

function kindMeta(kind: string): { label: string; tint: string } {
  if (kind in KIND_LABEL) {
    const k = kind as TimelineEventKind;
    return { label: KIND_LABEL[k], tint: KIND_TINT[k] };
  }
  return { label: kind, tint: "var(--color-text-muted)" };
}

export default function ProjectTimeline({ projectId, projectPath }: Props) {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = (await invoke("project_timeline_list", {
        projectId,
        projectPath: projectPath ?? null,
      })) as TimelineEvent[];
      setEvents(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId, projectPath]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => groupByDay(events), [events]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-1.5 text-xs">
        <div className="flex items-center gap-2 text-[var(--color-text-muted)]">
          <span>Timeline</span>
          <span className="text-[var(--color-text-faint)]">·</span>
          <span>
            {events.length} event{events.length === 1 ? "" : "s"}
          </span>
        </div>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="rounded border border-[var(--color-border)] px-2 py-0.5 text-[11px] hover:bg-[var(--color-surface-2)] disabled:opacity-40"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="border-b border-[var(--color-error)] bg-[var(--color-surface-2)] px-3 py-1 text-xs text-[var(--color-error)]">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto px-4 py-3">
        {!loading && events.length === 0 && (
          <div className="mx-auto mt-12 max-w-md rounded border border-dashed border-[var(--color-border)] p-6 text-center text-[12px] text-[var(--color-text-muted)]">
            <p className="font-medium text-[var(--color-text-secondary)]">
              Nothing on the timeline yet
            </p>
            <p className="mt-1">
              Sessions you open in this project, kanban card moves and the
              latest backup snapshot will appear here as they happen.
            </p>
          </div>
        )}

        {groups.map((group) => (
          <section key={group.day} className="mb-5">
            <div
              className="sticky top-0 z-10 mb-2 bg-[var(--color-surface-0)] py-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]"
              style={{ backdropFilter: "blur(2px)" }}
            >
              {formatDay(group.day)}
            </div>
            <ol className="relative ml-3 border-l border-[var(--color-border)]">
              {group.events.map((ev, i) => {
                const meta = kindMeta(ev.kind);
                return (
                  <li
                    key={`${group.day}-${i}-${ev.ref_id ?? ev.title}`}
                    className="relative pl-4 pb-3"
                  >
                    <span
                      aria-hidden
                      className="absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full"
                      style={{
                        background: meta.tint,
                        boxShadow: "0 0 0 2px var(--color-surface-0)",
                      }}
                    />
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono text-[10.5px] tabular-nums text-[var(--color-text-faint)]">
                        {formatTime(ev.at)}
                      </span>
                      <span
                        className="rounded px-1.5 py-px text-[9.5px] font-medium uppercase tracking-wide"
                        style={{
                          background: "var(--color-surface-2)",
                          color: meta.tint,
                          border: "1px solid var(--color-border)",
                        }}
                      >
                        {meta.label}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[12.5px] leading-snug text-[var(--color-text)]">
                      {ev.title}
                    </p>
                    {ev.detail && (
                      <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
                        {ev.detail}
                      </p>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}
