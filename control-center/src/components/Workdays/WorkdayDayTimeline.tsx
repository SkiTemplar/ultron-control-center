// WorkdayDayTimeline — vista de día con timeline horizontal de 24h (H30).
//
// Layout:
//   Header: fecha + nav prev/next + date-picker + métricas (horas, proyectos,
//            sessions).
//   Timeline: 24 columnas, una por hora. Cada hora muestra slices de color
//             proporcionales al tiempo por proyecto dentro de ese bloque.
//             Horas sin actividad = gris tenue.
//   Detail panel: al hacer click en una hora se expande mostrando proyectos
//                 con tiempo, sessions vinculadas, y workdays tocados en esa
//                 hora.
//
// Backend: workday_day_view(date?) -> WorkdayDayView
// No polling activo — la vista se recarga al cambiar de fecha.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DayPeriod, HourBlock, Workday, WorkdayDayView } from "./types";

// ---------------------------------------------------------------------------
// Colores por período y por proyecto (paleta cíclica)
// ---------------------------------------------------------------------------

const PERIOD_BG: Record<DayPeriod, string> = {
  night: "rgba(59,130,246,0.15)",     // azul suave
  morning: "rgba(6,182,212,0.15)",    // cyan
  afternoon: "rgba(245,158,11,0.15)", // amber
  evening: "rgba(139,92,246,0.15)",   // violet
};

const PERIOD_ACCENT: Record<DayPeriod, string> = {
  night: "#3b82f6",
  morning: "#06b6d4",
  afternoon: "#f59e0b",
  evening: "#8b5cf6",
};

const PROJECT_PALETTE = [
  "#22c55e", "#3b82f6", "#f59e0b", "#ec4899",
  "#8b5cf6", "#06b6d4", "#ef4444", "#84cc16",
  "#f97316", "#14b8a6",
];

function projectColor(projectId: string, allIds: string[]): string {
  const idx = allIds.indexOf(projectId);
  return PROJECT_PALETTE[idx % PROJECT_PALETTE.length] ?? "#94a3b8";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function prevDay(iso: string): string {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function nextDay(iso: string): string {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function fmtHour(h: number): string {
  return String(h).padStart(2, "0") + ":00";
}

function fmtSeconds(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.round(secs / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

// Collect all project IDs that appear in any block (for consistent coloring).
function allProjectIds(blocks: HourBlock[]): string[] {
  const seen = new Set<string>();
  for (const b of blocks) {
    for (const pid of Object.keys(b.projects)) seen.add(pid);
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// Tiny components
// ---------------------------------------------------------------------------

interface NavBtnProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}
function NavBtn({ label, onClick, disabled }: NavBtnProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded px-2 py-1 text-[12px] font-medium disabled:opacity-40"
      style={{
        background: "transparent",
        color: "var(--color-text-secondary)",
        border: "1px solid var(--color-border-strong)",
      }}
    >
      {label}
    </button>
  );
}

interface MetricChipProps {
  label: string;
  value: string | number;
}
function MetricChip({ label, value }: MetricChipProps) {
  return (
    <div
      className="flex flex-col items-center rounded px-3 py-1.5"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <span
        className="text-[18px] font-semibold tabular-nums"
        style={{ color: "var(--color-text)" }}
      >
        {value}
      </span>
      <span className="text-[10px]" style={{ color: "var(--color-text-tertiary)" }}>
        {label}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HourCell — one column in the timeline
// ---------------------------------------------------------------------------

interface HourCellProps {
  block: HourBlock;
  projectIds: string[];
  maxSecs: number;
  selected: boolean;
  onClick: () => void;
}

function HourCell({ block, projectIds, maxSecs, selected, onClick }: HourCellProps) {
  const totalSecs = Object.values(block.projects).reduce((a, b) => a + b, 0);
  const hasActivity = totalSecs > 0 || block.ai_session_count > 0;

  // Build proportional slices for each project in this hour.
  const slices = Object.entries(block.projects)
    .filter(([, secs]) => secs > 0)
    .map(([pid, secs]) => ({ pid, secs, pct: totalSecs > 0 ? secs / totalSecs : 0 }));

  const barHeight = maxSecs > 0 ? Math.max((totalSecs / maxSecs) * 100, hasActivity ? 8 : 0) : 0;

  return (
    <button
      type="button"
      onClick={onClick}
      title={`${fmtHour(block.hour_start)} — ${hasActivity ? fmtSeconds(totalSecs) : "no activity"}`}
      className="group flex flex-col items-center gap-0.5"
      style={{ minWidth: 28, flex: "1 1 0" }}
    >
      {/* Bar area */}
      <div
        className="relative flex w-full items-end justify-center overflow-hidden rounded-t"
        style={{
          height: 60,
          background: selected
            ? "var(--color-surface-3)"
            : PERIOD_BG[block.period],
          border: selected
            ? `1px solid ${PERIOD_ACCENT[block.period]}`
            : "1px solid transparent",
          transition: "border-color 120ms",
        }}
      >
        {slices.length > 0 ? (
          <div
            className="absolute bottom-0 left-0 right-0 flex overflow-hidden rounded-t"
            style={{ height: `${barHeight}%`, minHeight: hasActivity ? 4 : 0 }}
          >
            {slices.map(({ pid, pct }) => (
              <div
                key={pid}
                style={{
                  width: `${pct * 100}%`,
                  background: projectColor(pid, projectIds),
                  minWidth: 2,
                }}
              />
            ))}
          </div>
        ) : hasActivity ? (
          // Sessions with no focus_seconds → small indicator dot
          <div
            className="absolute bottom-1 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full"
            style={{ background: PERIOD_ACCENT[block.period] }}
          />
        ) : null}

        {/* Session count badge */}
        {block.ai_session_count > 0 && (
          <span
            className="absolute right-0.5 top-0.5 rounded px-0.5 text-[8px] font-bold leading-none"
            style={{
              background: PERIOD_ACCENT[block.period],
              color: "#000",
            }}
          >
            {block.ai_session_count}
          </span>
        )}
      </div>

      {/* Hour label */}
      <span
        className="text-[9px] tabular-nums"
        style={{
          color: hasActivity
            ? PERIOD_ACCENT[block.period]
            : "var(--color-text-faint, #475569)",
          fontWeight: hasActivity ? 600 : 400,
        }}
      >
        {block.hour_start}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// HourDetail — expanded detail for the selected hour
// ---------------------------------------------------------------------------

interface HourDetailProps {
  block: HourBlock;
  workdays: Workday[];
  projectIds: string[];
}

function HourDetail({ block, workdays, projectIds }: HourDetailProps) {
  const totalSecs = Object.values(block.projects).reduce((a, b) => a + b, 0);

  // Find workdays that were active in this hour (have start or context entries
  // pointing to this slot — we use project overlap as a proxy).
  const relevantWds = workdays.filter(
    (wd) =>
      (wd.project_id && block.projects[wd.project_id] !== undefined) ||
      block.linked_sessions.some((s) => wd.linked_sessions.includes(s)),
  );

  return (
    <div
      className="flex flex-col gap-3 rounded-lg p-4"
      style={{
        background: "var(--color-surface-2)",
        border: `1px solid ${PERIOD_ACCENT[block.period]}40`,
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-3">
        <span
          className="rounded px-2 py-0.5 text-[11px] font-semibold uppercase"
          style={{
            background: `${PERIOD_ACCENT[block.period]}22`,
            color: PERIOD_ACCENT[block.period],
          }}
        >
          {block.period}
        </span>
        <span
          className="text-[14px] font-semibold"
          style={{ color: "var(--color-text)" }}
        >
          {fmtHour(block.hour_start)} – {fmtHour(block.hour_end)}
        </span>
        {totalSecs > 0 && (
          <span
            className="ml-auto text-[12px]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            {fmtSeconds(totalSecs)} focus
          </span>
        )}
      </div>

      {/* Projects */}
      {Object.keys(block.projects).length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <div
            className="text-[10px] font-semibold uppercase tracking-wider"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Proyectos
          </div>
          {Object.entries(block.projects)
            .filter(([, secs]) => secs > 0)
            .sort(([, a], [, b]) => b - a)
            .map(([pid, secs]) => {
              const pct =
                totalSecs > 0 ? Math.round((secs / totalSecs) * 100) : 0;
              const color = projectColor(pid, projectIds);
              return (
                <div key={pid} className="flex items-center gap-2">
                  <div
                    className="h-2 w-2 rounded-full flex-shrink-0"
                    style={{ background: color }}
                  />
                  <span
                    className="flex-1 truncate text-[12px]"
                    style={{ color: "var(--color-text)" }}
                  >
                    {pid}
                  </span>
                  <span
                    className="text-[11px] tabular-nums"
                    style={{ color: "var(--color-text-secondary)" }}
                  >
                    {fmtSeconds(secs)}
                  </span>
                  <div
                    className="h-1.5 rounded-full"
                    style={{ width: 48, background: "var(--color-surface-3)" }}
                  >
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${pct}%`,
                        background: color,
                      }}
                    />
                  </div>
                </div>
              );
            })}
        </div>
      ) : null}

      {/* AI sessions */}
      {block.linked_sessions.length > 0 && (
        <div className="flex flex-col gap-1">
          <div
            className="text-[10px] font-semibold uppercase tracking-wider"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            AI Sessions ({block.ai_session_count})
          </div>
          <div className="flex flex-wrap gap-1">
            {block.linked_sessions.map((sid) => (
              <span
                key={sid}
                className="rounded px-1.5 py-0.5 font-mono text-[10px]"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-secondary)",
                }}
              >
                {sid.slice(0, 20)}…
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Linked workdays */}
      {relevantWds.length > 0 && (
        <div className="flex flex-col gap-1">
          <div
            className="text-[10px] font-semibold uppercase tracking-wider"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Workdays activos
          </div>
          {relevantWds.map((wd) => (
            <div
              key={wd.id}
              className="flex items-center gap-2 rounded px-2 py-1"
              style={{
                background: "var(--color-surface-1)",
                border: "1px solid var(--color-border)",
              }}
            >
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{
                  background:
                    wd.status === "in_progress"
                      ? "#22c55e"
                      : "var(--color-text-tertiary)",
                }}
              />
              <span
                className="flex-1 truncate text-[12px]"
                style={{ color: "var(--color-text)" }}
              >
                {wd.title}
              </span>
              <span
                className="text-[10px] uppercase"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {wd.status}
              </span>
            </div>
          ))}
        </div>
      )}

      {!Object.keys(block.projects).length &&
        !block.linked_sessions.length && (
          <div
            className="text-[12px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Sin actividad registrada en esta hora.
          </div>
        )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Period legend
// ---------------------------------------------------------------------------

const PERIODS: { id: DayPeriod; label: string; range: string }[] = [
  { id: "night", label: "Noche", range: "0–6" },
  { id: "morning", label: "Mañana", range: "6–12" },
  { id: "afternoon", label: "Tarde", range: "12–18" },
  { id: "evening", label: "Tarde-noche", range: "18–24" },
];

function PeriodLegend() {
  return (
    <div className="flex flex-wrap gap-2">
      {PERIODS.map((p) => (
        <div key={p.id} className="flex items-center gap-1">
          <div
            className="h-2 w-3 rounded-sm"
            style={{ background: PERIOD_ACCENT[p.id] }}
          />
          <span
            className="text-[10px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {p.label} {p.range}h
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function WorkdayDayTimeline() {
  const [date, setDate] = useState<string>(todayIso);
  const [view, setView] = useState<WorkdayDayView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedHour, setSelectedHour] = useState<number | null>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);

  const loadView = useCallback(async (d: string) => {
    setLoading(true);
    setError(null);
    setSelectedHour(null);
    try {
      const v = await invoke<WorkdayDayView>("workday_day_view", { date: d });
      setView(v);
      // Auto-select first hour with activity.
      const first = v.hour_blocks.find(
        (b) =>
          Object.keys(b.projects).length > 0 || b.ai_session_count > 0,
      );
      if (first) setSelectedHour(first.hour_start);
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadView(date);
  }, [date, loadView]);

  const isToday = date === todayIso();
  const projectIds = view ? allProjectIds(view.hour_blocks) : [];
  const maxSecs =
    view
      ? Math.max(
          ...view.hour_blocks.map((b) =>
            Object.values(b.projects).reduce((a, v) => a + v, 0),
          ),
          1,
        )
      : 1;

  const selectedBlock =
    view && selectedHour !== null
      ? view.hour_blocks[selectedHour]
      : null;

  const totalHours =
    view ? Math.round(view.total_seconds / 3600 * 10) / 10 : 0;

  return (
    // flex-1 + min-w-0: as the sole flex child of the Workdays row container,
    // this must FILL the row and be allowed to shrink below its content width.
    // Without min-w-0 the HourDetail panel's intrinsic width drove the whole
    // tab to reflow on hour selection (card-ux-workdays-responsive).
    <div
      className="flex h-full min-w-0 flex-1 flex-col overflow-hidden"
      style={{ background: "var(--color-bg)" }}
    >
      {/* ------------------------------------------------------------------ */}
      {/* Header                                                              */}
      {/* ------------------------------------------------------------------ */}
      <div
        className="flex flex-col gap-3 border-b px-5 py-4"
        style={{
          borderColor: "var(--color-border)",
          background: "var(--color-surface-1)",
        }}
      >
        {/* Date nav row */}
        <div className="flex items-center gap-2">
          <NavBtn label="◀" onClick={() => setDate(prevDay(date))} />
          <input
            ref={dateInputRef}
            type="date"
            value={date}
            onChange={(e) => {
              if (e.target.value) setDate(e.target.value);
            }}
            className="rounded px-2 py-1 text-[13px] font-semibold"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border-strong)",
              color: "var(--color-text)",
              colorScheme: "dark",
            }}
          />
          <NavBtn
            label="▶"
            onClick={() => setDate(nextDay(date))}
            disabled={isToday}
          />
          {!isToday && (
            <button
              type="button"
              onClick={() => setDate(todayIso())}
              className="rounded px-2 py-1 text-[11px] font-medium"
              style={{
                background: "var(--color-surface-2)",
                color: "var(--color-accent, #22c55e)",
                border: "1px solid var(--color-border)",
              }}
            >
              Hoy
            </button>
          )}
          {loading && (
            <span
              className="text-[11px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Cargando…
            </span>
          )}
        </div>

        {/* Metrics row */}
        {view && (
          <div className="flex flex-wrap gap-2">
            <MetricChip label="horas" value={totalHours} />
            <MetricChip label="proyectos" value={view.project_count} />
            <MetricChip label="sessions" value={view.session_count} />
            <MetricChip label="workdays" value={view.workdays.length} />
          </div>
        )}

        <PeriodLegend />
      </div>

      {/* Error state */}
      {error && (
        <div
          className="px-5 py-3 text-[12px]"
          style={{ color: "var(--color-danger, #ef4444)" }}
        >
          {error}
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Timeline + detail                                                   */}
      {/* ------------------------------------------------------------------ */}
      {view && (
        <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-auto px-5 py-4">
          {/* 24-column timeline */}
          <div
            className="flex items-end gap-0.5 overflow-x-auto rounded-lg p-2"
            style={{
              background: "var(--color-surface-1)",
              border: "1px solid var(--color-border)",
              minHeight: 88,
            }}
          >
            {view.hour_blocks.map((block) => (
              <HourCell
                key={block.hour_start}
                block={block}
                projectIds={projectIds}
                maxSecs={maxSecs}
                selected={selectedHour === block.hour_start}
                onClick={() =>
                  setSelectedHour(
                    selectedHour === block.hour_start
                      ? null
                      : block.hour_start,
                  )
                }
              />
            ))}
          </div>

          {/* Project color legend */}
          {projectIds.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {projectIds.map((pid) => (
                <div key={pid} className="flex items-center gap-1">
                  <div
                    className="h-2 w-2 rounded-full"
                    style={{ background: projectColor(pid, projectIds) }}
                  />
                  <span
                    className="max-w-[120px] truncate text-[10px]"
                    style={{ color: "var(--color-text-secondary)" }}
                  >
                    {pid}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Hour detail */}
          {selectedBlock && (
            <HourDetail
              block={selectedBlock}
              workdays={view.workdays}
              projectIds={projectIds}
            />
          )}

          {/* Empty state */}
          {view.workdays.length === 0 && (
            <div
              className="flex flex-col items-center justify-center gap-2 py-12 text-center"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              <div className="text-[14px] font-medium">
                Sin actividad el {date}
              </div>
              <div className="max-w-xs text-[12px]">
                Los workdays se crean automáticamente cuando lanzas una sesión
                en un proyecto registrado.
              </div>
            </div>
          )}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && !view && (
        <div
          className="flex flex-1 items-center justify-center text-[12px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Cargando timeline…
        </div>
      )}
    </div>
  );
}
