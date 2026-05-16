import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Activity Timeline view — visualises hook signals + alerts as a per-day
// heatmap (sources x days) plus a chronological event list grouped by day.
// Backed by the `compute_activity_timeline` Tauri command.

export type TimelineEvent = {
  ts: string;
  day: string;
  source: string;
  kind: string;
  summary: string;
};

export type TimelineSummary = {
  events: TimelineEvent[];
  day_counts: Record<string, Record<string, number>>;
};

// 8-colour palette aligned with SelfImprove.tsx's HOOK_SOURCE_COLORS plus
// entries for the two new sources (`alerts`, `news`). Each entry has a `bg`
// (chip background) and `fg` (text + heatmap base) channel. Heatmap cells
// re-use the `fg` rgb triplet with a varying alpha computed from the count.
const SOURCE_COLORS: Record<string, { bg: string; fg: string; rgb: string }> = {
  "hyper-plans": {
    bg: "rgba(88, 166, 255, 0.12)",
    fg: "rgb(88, 166, 255)",
    rgb: "88, 166, 255",
  },
  doctor: {
    bg: "rgba(248, 81, 73, 0.12)",
    fg: "rgb(248, 81, 73)",
    rgb: "248, 81, 73",
  },
  "prompt-feedback": {
    bg: "rgba(210, 153, 34, 0.12)",
    fg: "rgb(210, 153, 34)",
    rgb: "210, 153, 34",
  },
  "token-usage": {
    bg: "rgba(63, 185, 80, 0.12)",
    fg: "rgb(63, 185, 80)",
    rgb: "63, 185, 80",
  },
  "auto-updater": {
    bg: "rgba(163, 113, 247, 0.12)",
    fg: "rgb(163, 113, 247)",
    rgb: "163, 113, 247",
  },
  "mcp-audit": {
    bg: "rgba(255, 138, 0, 0.14)",
    fg: "rgb(255, 138, 0)",
    rgb: "255, 138, 0",
  },
  alerts: {
    bg: "rgba(255, 99, 132, 0.14)",
    fg: "rgb(255, 99, 132)",
    rgb: "255, 99, 132",
  },
  news: {
    bg: "rgba(116, 199, 236, 0.14)",
    fg: "rgb(116, 199, 236)",
    rgb: "116, 199, 236",
  },
};

const FALLBACK_COLOR = {
  bg: "rgba(125, 133, 144, 0.14)",
  fg: "rgb(125, 133, 144)",
  rgb: "125, 133, 144",
};

function colorFor(source: string) {
  return SOURCE_COLORS[source] ?? FALLBACK_COLOR;
}

// Build the inclusive list of YYYY-MM-DD strings for the last `days` days,
// oldest -> newest. We compute in UTC so it matches the backend's day buckets
// (the backend treats the ISO timestamp's first 10 chars as the day key, which
// is already UTC for every source we ingest).
function buildDayList(days: number): string[] {
  const out: string[] = [];
  const now = new Date();
  const base = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(base - i * 86_400_000);
    const y = d.getUTCFullYear().toString().padStart(4, "0");
    const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
    const day = d.getUTCDate().toString().padStart(2, "0");
    out.push(`${y}-${m}-${day}`);
  }
  return out;
}

function formatDayLabel(day: string, compact: boolean): string {
  // "2026-05-16" -> compact: "05-16", verbose: "Thu 16 May"
  if (!compact) {
    const dt = new Date(`${day}T00:00:00Z`);
    if (Number.isNaN(dt.getTime())) return day;
    return dt.toLocaleDateString(undefined, {
      weekday: "short",
      day: "2-digit",
      month: "short",
      timeZone: "UTC",
    });
  }
  return day.slice(5);
}

function intensityAlpha(count: number, maxCount: number): number {
  // log(count+1) / log(maxCount+1) gives a 0..1 ramp that compresses big
  // outliers (a spammy doctor day shouldn't drown everything else).
  if (count <= 0) return 0;
  if (maxCount <= 0) return 0;
  const ratio = Math.log(count + 1) / Math.log(maxCount + 1);
  // Floor at 0.18 so non-zero cells stay visible against the surface bg.
  return 0.18 + ratio * 0.72;
}

const CELL_W = 24;
const CELL_H = 28;
const X_GAP = 4;
const Y_GAP = 4;
const LEFT_PAD = 110;
const TOP_PAD = 40;
const BOTTOM_PAD = 36;
const RIGHT_PAD = 12;

type HoverCell = {
  day: string;
  source: string;
  count: number;
  cx: number;
  cy: number;
};

export function ActivityTimeline() {
  const [window, setWindow] = useState<7 | 30>(7);
  const [data, setData] = useState<TimelineSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [hover, setHover] = useState<HoverCell | null>(null);

  const load = useCallback(
    async (w: number) => {
      setLoading(true);
      setError(null);
      try {
        const r = (await invoke("compute_activity_timeline", {
          days: w,
        })) as TimelineSummary;
        setData(r);
        setLastUpdated(new Date());
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    load(window);
  }, [window, load]);

  const days = useMemo(() => buildDayList(window), [window]);

  // Stable source list — preserve the catalogue order from SOURCE_COLORS so
  // the heatmap rows don't reshuffle as data trickles in. Any unknown source
  // discovered in the data gets appended at the end.
  const sources = useMemo(() => {
    const known = Object.keys(SOURCE_COLORS);
    if (!data) return known;
    const seen = new Set(known);
    for (const ev of data.events) {
      if (!seen.has(ev.source)) {
        known.push(ev.source);
        seen.add(ev.source);
      }
    }
    return known;
  }, [data]);

  // Compute the cell-count lookup and the max for intensity scaling.
  const { matrix, maxCount } = useMemo(() => {
    const m: Record<string, Record<string, number>> = {};
    let max = 0;
    if (data) {
      for (const day of days) {
        const dayMap = data.day_counts[day] ?? {};
        m[day] = dayMap;
        for (const src of sources) {
          const c = dayMap[src] ?? 0;
          if (c > max) max = c;
        }
      }
    }
    return { matrix: m, maxCount: max };
  }, [data, days, sources]);

  // Group events by day for the recent-events list.
  const grouped = useMemo(() => {
    const out: { day: string; events: TimelineEvent[] }[] = [];
    if (!data) return out;
    const byDay = new Map<string, TimelineEvent[]>();
    for (const ev of data.events) {
      const arr = byDay.get(ev.day) ?? [];
      arr.push(ev);
      byDay.set(ev.day, arr);
    }
    // Sort days descending (newest first).
    const sortedDays = Array.from(byDay.keys()).sort((a, b) =>
      a < b ? 1 : a > b ? -1 : 0
    );
    for (const d of sortedDays) {
      out.push({ day: d, events: byDay.get(d) ?? [] });
    }
    return out;
  }, [data]);

  const svgW = LEFT_PAD + days.length * (CELL_W + X_GAP) + RIGHT_PAD;
  const svgH = TOP_PAD + sources.length * (CELL_H + Y_GAP) + BOTTOM_PAD;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex items-center gap-2">
          <div
            className="text-[10px] font-medium uppercase tracking-[0.06em]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Window
          </div>
          {[7, 30].map((w) => {
            const active = window === w;
            return (
              <button
                key={w}
                type="button"
                onClick={() => setWindow(w as 7 | 30)}
                className="rounded px-2 py-0.5 text-[11px] font-medium transition-colors"
                style={{
                  background: active
                    ? "var(--color-surface-3)"
                    : "var(--color-surface-2)",
                  color: active
                    ? "var(--color-text)"
                    : "var(--color-text-secondary)",
                  border: active
                    ? "1px solid var(--color-border-strong)"
                    : "1px solid var(--color-border)",
                }}
              >
                {w}d
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <span
              className="text-[10.5px] tabular-nums"
              style={{ color: "var(--color-text-faint)" }}
            >
              updated {lastUpdated.toLocaleTimeString()}
            </span>
          )}
          <button
            type="button"
            onClick={() => load(window)}
            disabled={loading}
            className="rounded px-2 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border)",
            }}
          >
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <div
          className="rounded p-3 text-[12px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      <div
        className="rounded p-3"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border)",
        }}
      >
        <div
          className="mb-2 text-[10px] font-medium uppercase tracking-[0.06em]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Activity heatmap ({window}d)
        </div>
        <div className="relative" style={{ overflowX: "auto" }}>
          <svg
            viewBox={`0 0 ${svgW} ${svgH}`}
            width={svgW}
            height={svgH}
            style={{ display: "block", maxWidth: "100%" }}
            onMouseLeave={() => setHover(null)}
          >
            {/* Source row labels */}
            {sources.map((src, rowIdx) => {
              const cy = TOP_PAD + rowIdx * (CELL_H + Y_GAP) + CELL_H / 2;
              const c = colorFor(src);
              return (
                <text
                  key={`label-${src}`}
                  x={LEFT_PAD - 10}
                  y={cy}
                  textAnchor="end"
                  dominantBaseline="central"
                  fontSize={10.5}
                  fontFamily="var(--font-mono, ui-monospace)"
                  fill={c.fg}
                >
                  {src}
                </text>
              );
            })}

            {/* Day column labels (rotated 45 deg) */}
            {days.map((day, colIdx) => {
              const cx = LEFT_PAD + colIdx * (CELL_W + X_GAP) + CELL_W / 2;
              const showLabel =
                window <= 7 ||
                colIdx === 0 ||
                colIdx === days.length - 1 ||
                colIdx % 3 === 0;
              if (!showLabel) return null;
              return (
                <text
                  key={`day-${day}`}
                  x={cx}
                  y={TOP_PAD - 8}
                  textAnchor="start"
                  fontSize={9.5}
                  fontFamily="var(--font-mono, ui-monospace)"
                  fill="var(--color-text-tertiary)"
                  transform={`rotate(-45 ${cx} ${TOP_PAD - 8})`}
                >
                  {formatDayLabel(day, true)}
                </text>
              );
            })}

            {/* Cells */}
            {sources.map((src, rowIdx) =>
              days.map((day, colIdx) => {
                const count = matrix[day]?.[src] ?? 0;
                const c = colorFor(src);
                const alpha = intensityAlpha(count, maxCount);
                const x = LEFT_PAD + colIdx * (CELL_W + X_GAP);
                const y = TOP_PAD + rowIdx * (CELL_H + Y_GAP);
                const fill =
                  count > 0
                    ? `rgba(${c.rgb}, ${alpha.toFixed(3)})`
                    : "rgba(255, 255, 255, 0.02)";
                return (
                  <rect
                    key={`cell-${src}-${day}`}
                    x={x}
                    y={y}
                    width={CELL_W}
                    height={CELL_H}
                    rx={3}
                    ry={3}
                    fill={fill}
                    stroke="var(--color-border)"
                    strokeWidth={0.5}
                    onMouseEnter={() =>
                      setHover({
                        day,
                        source: src,
                        count,
                        cx: x + CELL_W / 2,
                        cy: y,
                      })
                    }
                  >
                    <title>{`${day} · ${src} · ${count}`}</title>
                  </rect>
                );
              })
            )}
          </svg>

          {hover && (
            <div
              className="pointer-events-none absolute rounded px-2 py-1 text-[10.5px]"
              style={{
                background: "var(--color-surface-3)",
                border: "1px solid var(--color-border-strong)",
                color: "var(--color-text)",
                left: Math.min(hover.cx + 12, svgW - 160),
                top: hover.cy - 6,
                whiteSpace: "nowrap",
                fontFamily: "var(--font-mono, ui-monospace)",
              }}
            >
              {hover.day} · {hover.source} · {hover.count}
            </div>
          )}
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          {sources.map((src) => {
            const c = colorFor(src);
            return (
              <span
                key={`legend-${src}`}
                className="inline-flex items-center gap-1.5 rounded px-1.5 py-[1px] text-[9.5px] font-medium uppercase tracking-[0.04em]"
                style={{ background: c.bg, color: c.fg }}
              >
                <span
                  style={{
                    display: "inline-block",
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    background: c.fg,
                  }}
                />
                {src}
              </span>
            );
          })}
        </div>
      </div>

      <div>
        <div
          className="mb-2 flex items-baseline justify-between"
        >
          <div
            className="text-[10px] font-medium uppercase tracking-[0.06em] cursor-help"
            style={{ color: "var(--color-text-tertiary)" }}
            title="Tokens consumed by the system prompt cache. The X/Y format means X tokens used over Y limit per session."
          >
            Recent events ({data?.events.length ?? 0})
            <span
              className="ml-1 text-[9px]"
              style={{ color: "var(--color-text-faint)" }}
              aria-hidden="true"
            >
              ⓘ
            </span>
          </div>
          {!loading && data && data.events.length === 0 && (
            <div
              className="text-[10.5px]"
              style={{ color: "var(--color-text-faint)" }}
            >
              No telemetry in the last {window}d
            </div>
          )}
        </div>
        <div className="space-y-3">
          {grouped.map(({ day, events }) => (
            <div key={`grp-${day}`}>
              <div className="mb-1 flex items-baseline gap-2">
                <span
                  className="text-[11px] font-medium tabular-nums"
                  style={{ color: "var(--color-text-secondary)" }}
                >
                  {formatDayLabel(day, false)}
                </span>
                <span
                  className="rounded px-1.5 py-[1px] text-[9.5px] tabular-nums"
                  style={{
                    background: "var(--color-surface-2)",
                    color: "var(--color-text-tertiary)",
                    border: "1px solid var(--color-border)",
                  }}
                >
                  {events.length}
                </span>
              </div>
              <ul
                className="overflow-hidden rounded text-[11.5px]"
                style={{
                  background: "var(--color-surface-2)",
                  border: "1px solid var(--color-border)",
                }}
              >
                {events.slice(0, 40).map((ev, i) => {
                  const c = colorFor(ev.source);
                  return (
                    <li
                      key={`${ev.source}-${ev.ts}-${i}`}
                      className="flex items-baseline gap-2 px-3 py-1.5"
                      style={{
                        borderTop:
                          i === 0 ? "none" : "1px solid var(--color-border)",
                      }}
                    >
                      <span
                        className="tabular-nums"
                        style={{
                          color: "var(--color-text-faint)",
                          fontFamily: "var(--font-mono, ui-monospace)",
                          fontSize: 10,
                          minWidth: 46,
                        }}
                      >
                        {ev.ts.slice(11, 16)}
                      </span>
                      <span
                        className="inline-block rounded px-1.5 py-[1px] text-[9.5px] font-medium uppercase tracking-[0.04em]"
                        style={{
                          background: c.bg,
                          color: c.fg,
                          minWidth: 92,
                          textAlign: "center",
                        }}
                      >
                        {ev.source}
                      </span>
                      <span
                        className="rounded px-1 py-[1px] text-[9.5px]"
                        style={{
                          background: "var(--color-surface-3)",
                          color: "var(--color-text-tertiary)",
                          fontFamily: "var(--font-mono, ui-monospace)",
                        }}
                      >
                        {ev.kind || "—"}
                      </span>
                      <span
                        className="flex-1 truncate"
                        style={{ color: "var(--color-text)" }}
                        title={ev.summary}
                      >
                        {ev.summary || "(no summary)"}
                      </span>
                    </li>
                  );
                })}
                {events.length > 40 && (
                  <li
                    className="px-3 py-1.5 text-[10.5px]"
                    style={{
                      borderTop: "1px solid var(--color-border)",
                      color: "var(--color-text-faint)",
                    }}
                  >
                    +{events.length - 40} more on this day
                  </li>
                )}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
