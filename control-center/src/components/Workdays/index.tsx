// ULTRON Control Center - Workdays tab (v2.9.5 — day timeline + wipe)
//
// Lanes:
//   "day"       — timeline horizontal de 24h con hour-blocks por proyecto (H30)
//   "today"     — workday activo + otros workdays del día (vista v2.8)
//   "templates" — 7 workflow templates de orquestación
//   "history"   — workdays pasados agrupados por fecha
//
// Settings: botón "Reset workdays" con backup ZIP automático (H29).
//
// Backend: src-tauri/src/workdays.rs + commands/workdays.rs.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { WorkdaysList } from "./WorkdaysList";
import { WorkdayDetail } from "./WorkdayDetail";
import { WorkdayTemplates } from "./WorkdayTemplates";
import { WorkdayDayTimeline } from "./WorkdayDayTimeline";
import { WorkdayWipeButton } from "./WorkdayWipeButton";
import type { Workday, WorkdayTodayView } from "./types";

export type {
  Workday,
  WorkdayContext,
  WorkdayContextEntry,
  WorkdayGoal,
  WorkdayMetrics,
  WorkdayStatus,
  WorkdayTemplate,
  WorkdayTodayView,
  WorkflowTemplate,
  GoalSource,
  GoalStatus,
  DayPeriod,
  HourBlock,
  WipeReport,
  WorkdayDayView,
} from "./types";

type Lane = "day" | "today" | "templates" | "history";

const REFRESH_MS = 5_000;

export function Workdays() {
  const [lane, setLane] = useState<Lane>("day");
  const [todayView, setTodayView] = useState<WorkdayTodayView | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [todayError, setTodayError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const loadToday = useCallback(async () => {
    try {
      const v = await invoke<WorkdayTodayView>("workday_today_timeline");
      setTodayView(v);
      setTodayError(null);
      // Auto-pick the active workday so the detail pane shows it without
      // a click. Falls back to the first "other today" if no active one.
      if (!selectedId && lane === "today") {
        const next = v.active ?? v.other_today[0] ?? null;
        if (next) setSelectedId(next.id);
      }
    } catch (e: unknown) {
      setTodayError(String(e));
    }
  }, [lane, selectedId]);

  // Live refresh on the today lane.
  useEffect(() => {
    void loadToday();
    if (lane !== "today") return;
    const handle = window.setInterval(() => setTick((t) => t + 1), REFRESH_MS);
    return () => window.clearInterval(handle);
  }, [lane, loadToday]);

  useEffect(() => {
    if (tick > 0) void loadToday();
  }, [tick, loadToday]);

  return (
    <div
      className="flex h-full flex-col"
      style={{ background: "var(--color-bg)" }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between border-b px-6 py-4"
        style={{
          borderColor: "var(--color-border)",
          background: "var(--color-surface-1)",
        }}
      >
        <div className="flex min-w-0 flex-col">
          <h1
            className="text-[17px] font-semibold"
            style={{ color: "var(--color-text)" }}
          >
            Workdays
          </h1>
          <p
            className="mt-0.5 text-[12px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Timeline por horas — sesiones, agentes y kanban se registran solos.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            <LaneBtn
              label="Day"
              active={lane === "day"}
              onClick={() => setLane("day")}
            />
            <LaneBtn
              label="Today"
              active={lane === "today"}
              onClick={() => setLane("today")}
            />
            <LaneBtn
              label="Templates"
              active={lane === "templates"}
              onClick={() => setLane("templates")}
            />
            <LaneBtn
              label="History"
              active={lane === "history"}
              onClick={() => {
                setLane("history");
                setSelectedId(null);
              }}
            />
          </div>
          <WorkdayWipeButton
            onWiped={() => {
              setTodayView(null);
              setSelectedId(null);
              if (lane === "today") void loadToday();
            }}
          />
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {lane === "day" && <WorkdayDayTimeline />}
        {lane === "today" && (
          <TodayLane
            view={todayView}
            error={todayError}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        )}
        {lane === "templates" && (
          <WorkdayTemplates
            onStarted={(wd) => {
              setSelectedId(wd.id);
              setLane("today");
              void loadToday();
            }}
          />
        )}
        {lane === "history" && (
          <HistoryLane
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        )}
      </div>
    </div>
  );
}

interface LaneBtnProps {
  label: string;
  active: boolean;
  onClick: () => void;
}
function LaneBtn({ label, active, onClick }: LaneBtnProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded px-3 py-1.5 text-[12px] font-medium"
      style={{
        background: active ? "var(--color-surface-3)" : "transparent",
        color: active ? "var(--color-text)" : "var(--color-text-tertiary)",
        border: "1px solid var(--color-border)",
      }}
    >
      {label}
    </button>
  );
}

interface TodayLaneProps {
  view: WorkdayTodayView | null;
  error: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}
function TodayLane({ view, error, selectedId, onSelect }: TodayLaneProps) {
  if (error) {
    return (
      <div
        className="flex h-full flex-1 items-center justify-center text-[12px]"
        style={{ color: "var(--color-danger, #ef4444)" }}
      >
        {error}
      </div>
    );
  }
  if (!view) {
    return (
      <div
        className="flex h-full flex-1 items-center justify-center text-[12px]"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Loading today's timeline...
      </div>
    );
  }
  const hasAny = view.active || view.other_today.length > 0;
  if (!hasAny) {
    return (
      <div
        className="flex h-full flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        <div className="text-[14px] font-medium">No activity yet today.</div>
        <div className="max-w-md text-[12px]">
          Launch a Claude / Codex / Gemini session in any registered project --
          a workday will open itself and start tracking sessions, goals and
          shared context.
        </div>
      </div>
    );
  }
  return (
    <>
      <div
        className="flex w-[320px] flex-col overflow-auto border-r"
        style={{
          borderColor: "var(--color-border)",
          background: "var(--color-surface-1)",
        }}
      >
        {view.active && (
          <TodayCard
            label="Active"
            wd={view.active}
            selected={view.active.id === selectedId}
            onClick={() => onSelect(view.active!.id)}
            accent
          />
        )}
        {view.other_today.length > 0 && (
          <div
            className="border-b px-3 py-2 text-[10px] font-semibold uppercase tracking-wider"
            style={{
              color: "var(--color-text-tertiary)",
              borderColor: "var(--color-border)",
            }}
          >
            Other workdays today
          </div>
        )}
        {view.other_today.map((wd) => (
          <TodayCard
            key={wd.id}
            label={wd.status}
            wd={wd}
            selected={wd.id === selectedId}
            onClick={() => onSelect(wd.id)}
          />
        ))}
      </div>
      <div className="flex-1 overflow-hidden">
        {selectedId ? (
          <WorkdayDetail
            workdayId={selectedId}
            refreshKey={view.date}
            onChanged={() => {
              /* live refresh comes from the parent interval */
            }}
          />
        ) : (
          <div
            className="flex h-full items-center justify-center text-[13px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Pick a workday on the left.
          </div>
        )}
      </div>
    </>
  );
}

interface TodayCardProps {
  label: string;
  wd: Workday;
  selected: boolean;
  onClick: () => void;
  accent?: boolean;
}
function TodayCard({ label, wd, selected, onClick, accent }: TodayCardProps) {
  const done = wd.goals.filter((g) => g.status === "done").length;
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full flex-col items-start gap-1 border-b px-3 py-3 text-left transition-colors"
      style={{
        borderColor: "var(--color-border)",
        background: selected ? "var(--color-surface-3)" : "transparent",
      }}
    >
      <div className="flex w-full items-center gap-2">
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{
            background: accent
              ? "var(--color-accent, #22c55e)"
              : "var(--color-text-tertiary, #64748b)",
          }}
        />
        <span
          className="flex-1 truncate text-[13px] font-medium"
          style={{ color: "var(--color-text)" }}
        >
          {wd.title}
        </span>
        <span
          className="rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text-secondary)",
          }}
        >
          {label}
        </span>
      </div>
      <div
        className="flex w-full items-center gap-3 text-[11px]"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        <span>
          {done}/{wd.goals.length} goals
        </span>
        <span>{wd.linked_sessions.length} sessions</span>
        {wd.workflow_template && <span>{wd.workflow_template}</span>}
      </div>
    </button>
  );
}

interface HistoryLaneProps {
  selectedId: string | null;
  onSelect: (id: string) => void;
}
function HistoryLane({ selectedId, onSelect }: HistoryLaneProps) {
  const [items, setItems] = useState<Workday[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    invoke<Workday[]>("workday_history", { limit: 200 })
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
  }, []);

  // Group by date.
  const groups = items.reduce<Record<string, Workday[]>>((acc, wd) => {
    (acc[wd.planned_date] ||= []).push(wd);
    return acc;
  }, {});
  const dates = Object.keys(groups).sort((a, b) => b.localeCompare(a));

  return (
    <>
      <div
        className="flex w-[320px] flex-col overflow-auto border-r"
        style={{
          borderColor: "var(--color-border)",
          background: "var(--color-surface-1)",
        }}
      >
        {loading && (
          <div
            className="px-3 py-4 text-[12px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Loading history...
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
            No historic workdays.
          </div>
        )}
        {dates.map((date) => (
          <div key={date}>
            <div
              className="border-b px-3 py-2 text-[10px] font-semibold uppercase tracking-wider"
              style={{
                color: "var(--color-text-tertiary)",
                borderColor: "var(--color-border)",
                background: "var(--color-surface-2)",
              }}
            >
              {date}
            </div>
            {groups[date].map((wd) => (
              <TodayCard
                key={wd.id}
                label={wd.status}
                wd={wd}
                selected={wd.id === selectedId}
                onClick={() => onSelect(wd.id)}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="flex-1 overflow-hidden">
        {selectedId ? (
          <WorkdayDetail
            workdayId={selectedId}
            refreshKey={0}
            onChanged={() => {
              /* history is read-only-ish; no live refresh */
            }}
          />
        ) : (
          <div
            className="flex h-full items-center justify-center text-[13px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Select a historic workday.
          </div>
        )}
      </div>
    </>
  );
}

// Old list view kept exported for any external consumer that imported it,
// but the redesigned tab no longer mounts it directly.
export { WorkdaysList };
