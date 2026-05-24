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
  // v2.6 (card-v26-fb-026): collapsible day groups. Default = only the
  // newest day expanded, everything older collapsed.
  const [collapsedDays, setCollapsedDays] = useState<Set<string>>(new Set());
  const [userInteracted, setUserInteracted] = useState(false);

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

  // Auto-collapse: when groups arrive for the first time (or the user hasn't
  // touched anything yet), collapse every day except the newest.
  useEffect(() => {
    if (userInteracted) return;
    if (groups.length <= 1) return;
    const next = new Set<string>();
    for (let i = 1; i < groups.length; i++) next.add(groups[i].day);
    setCollapsedDays(next);
  }, [groups, userInteracted]);

  function toggleDay(day: string) {
    setUserInteracted(true);
    setCollapsedDays((prev) => {
      const next = new Set(prev);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      return next;
    });
  }

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
          className="rounded border border-[var(--color-border)] px-2 py-0.5 text-[11.5px] hover:bg-[var(--color-surface-2)] disabled:opacity-40"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="border-b border-[var(--color-error)] bg-[var(--color-surface-2)] px-3 py-1 text-xs text-[var(--color-error)]">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto px-3 py-2">
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

        {/* v27-f22: 2-column day layout. The day label sits in a narrow
            sticky left rail (so it stays visible while you scroll within a
            long day) while the entries occupy the rest of the width — each
            entry renders inline (time · kind · title · detail) instead of
            stacking, which kills the dead right-side gutter the old vertical
            timeline left behind. */}
        {groups.map((group) => {
          const collapsed = collapsedDays.has(group.day);
          return (
            <section
              key={group.day}
              className="mb-4 grid items-start gap-3"
              style={{ gridTemplateColumns: "110px 1fr" }}
            >
              <button
                type="button"
                onClick={() => toggleDay(group.day)}
                className="sticky top-0 z-10 flex w-full items-center justify-end gap-1 bg-[var(--color-surface-0)] py-1 text-right text-[10.5px] font-semibold uppercase tracking-[0.06em] tabular-nums text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-secondary)]"
                style={{ backdropFilter: "blur(2px)" }}
                aria-expanded={!collapsed}
                title={`${collapsed ? "Expand" : "Collapse"} ${formatDay(group.day)} (${group.events.length} events)`}
              >
                <span aria-hidden>{collapsed ? "▸" : "▾"}</span>
                <span>{formatDay(group.day)}</span>
                <span className="text-[var(--color-text-faint)]">
                  ·{group.events.length}
                </span>
              </button>
              {collapsed ? (
                <div />
              ) : (
                <ol className="flex flex-col gap-1.5 border-l border-[var(--color-border)] pl-3">
                  {group.events.map((ev, i) => {
                    const meta = kindMeta(ev.kind);
                    return (
                      <li
                        key={`${group.day}-${i}-${ev.ref_id ?? ev.title}`}
                        className="relative grid items-baseline gap-2"
                        style={{
                          gridTemplateColumns:
                            "auto auto minmax(0, 1fr) minmax(0, 1.2fr)",
                        }}
                      >
                        <span
                          aria-hidden
                          className="absolute -left-[15px] top-1.5 h-2 w-2 rounded-full"
                          style={{
                            background: meta.tint,
                            boxShadow: "0 0 0 2px var(--color-surface-0)",
                          }}
                        />
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
                        <span
                          className="truncate text-[12.5px] leading-snug text-[var(--color-text)]"
                          title={ev.title}
                        >
                          {ev.title}
                        </span>
                        <span
                          className="truncate text-[11.5px] text-[var(--color-text-muted)]"
                          title={ev.detail ?? ""}
                        >
                          {ev.detail ?? ""}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
