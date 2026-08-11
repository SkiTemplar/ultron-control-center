// Usage → Activity — timeline de actividad del sistema completo (no solo
// tokens Claude): hyper-plans, doctor, prompt-feedback, token-usage,
// auto-updater, mcp-audit, alerts y workdays/kanban. Consume
// compute_activity_timeline (heatmap día×fuente + eventos recientes).
// Wiring 2026-08-11 (audit 08-09 #43).

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type TimelineEvent = {
  ts: string;
  day: string; // YYYY-MM-DD
  source: string;
  kind: string;
  summary: string;
};

type TimelineSummary = {
  events: TimelineEvent[];
  day_counts: Record<string, Record<string, number>>;
};

const WINDOWS = [7, 30, 90] as const;
const MAX_EVENTS_SHOWN = 150;

/// Últimos `n` días en UTC (YYYY-MM-DD), ascendente — mismo eje de días que
/// usa el backend (ts_to_day sobre timestamps ISO), así los huecos sin
/// actividad se ven como celdas vacías en vez de desaparecer.
function lastDaysUtc(n: number): string[] {
  const out: string[] = [];
  const now = Date.now();
  for (let i = n - 1; i >= 0; i--) {
    out.push(new Date(now - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

function heatOpacity(count: number, max: number): number {
  if (count <= 0) return 0;
  // Escala perceptible desde 1 evento; satura en el máximo del período.
  return 0.25 + 0.65 * Math.min(1, count / Math.max(1, max));
}

export function ActivityTab() {
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(30);
  const [data, setData] = useState<TimelineSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const r = (await invoke("compute_activity_timeline", {
          days,
        })) as TimelineSummary;
        if (!cancelled) {
          setData(r);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [days]);

  const dayAxis = lastDaysUtc(days);
  const sources = data
    ? Array.from(
        new Set(
          Object.values(data.day_counts).flatMap((bySource) =>
            Object.keys(bySource),
          ),
        ),
      ).sort()
    : [];
  const maxCount = data
    ? Math.max(
        1,
        ...Object.values(data.day_counts).flatMap((bySource) =>
          Object.values(bySource),
        ),
      )
    : 1;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
          Actividad de TODO el sistema (plans, doctor, routing, alerts,
          kanban…), no solo tokens Claude.
        </p>
        <div className="flex gap-1">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setDays(w)}
              className="rounded px-2.5 py-1 text-[11.5px] tabular-nums transition-colors"
              style={{
                background: days === w ? "var(--color-surface-3)" : "transparent",
                color: days === w ? "var(--color-text)" : "var(--color-text-secondary)",
                border: `1px solid ${
                  days === w ? "var(--color-border-strong)" : "var(--color-border)"
                }`,
              }}
            >
              {w}d
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div
          className="mb-4 rounded p-3 text-[12.5px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {loading && !data && (
        <p className="text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
          Loading…
        </p>
      )}

      {data && (
        <>
          {/* Heatmap día × fuente */}
          <div
            className="mb-6 overflow-x-auto rounded p-4"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
            }}
          >
            {sources.length === 0 ? (
              <p className="text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
                Sin eventos en los últimos {days} días.
              </p>
            ) : (
              <table className="border-separate" style={{ borderSpacing: 2 }}>
                <tbody>
                  {sources.map((src) => (
                    <tr key={src}>
                      <td
                        className="whitespace-nowrap pr-3 text-right text-[10.5px]"
                        style={{ color: "var(--color-text-tertiary)" }}
                      >
                        {src}
                      </td>
                      {dayAxis.map((day) => {
                        const count = data.day_counts[day]?.[src] ?? 0;
                        return (
                          <td key={day} title={`${day} · ${src} · ${count}`}>
                            <div
                              className="rounded-sm"
                              style={{
                                width: 12,
                                height: 12,
                                background:
                                  count > 0
                                    ? "var(--color-accent)"
                                    : "var(--color-surface-3)",
                                opacity: count > 0 ? heatOpacity(count, maxCount) : 0.45,
                              }}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  {/* Eje de días: primer día, medio y último para no saturar */}
                  <tr>
                    <td />
                    {dayAxis.map((day, i) => {
                      const show =
                        i === 0 || i === dayAxis.length - 1 || i === Math.floor(dayAxis.length / 2);
                      return (
                        <td key={day} className="pt-1">
                          {show && (
                            <span
                              className="block text-[8.5px] tabular-nums"
                              style={{ color: "var(--color-text-faint)" }}
                            >
                              {day.slice(5)}
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                </tbody>
              </table>
            )}
          </div>

          {/* Eventos recientes */}
          <div className="mb-2 flex items-baseline justify-between">
            <h3 className="text-[12.5px] font-medium">Recent events</h3>
            <span className="text-[11px] tabular-nums" style={{ color: "var(--color-text-faint)" }}>
              {data.events.length > MAX_EVENTS_SHOWN
                ? `${MAX_EVENTS_SHOWN} of ${data.events.length}`
                : data.events.length}
            </span>
          </div>
          <div className="space-y-1">
            {data.events.slice(0, MAX_EVENTS_SHOWN).map((ev, i) => (
              <div
                key={`${ev.ts}-${ev.source}-${i}`}
                className="flex items-baseline gap-3 rounded px-3 py-1.5"
                style={{
                  background: "var(--color-surface-2)",
                  border: "1px solid var(--color-border)",
                }}
              >
                <span
                  className="shrink-0 text-[10.5px] tabular-nums"
                  style={{ color: "var(--color-text-faint)" }}
                  title={ev.ts}
                >
                  {ev.ts.slice(5, 16).replace("T", " ")}
                </span>
                <span
                  className="shrink-0 rounded px-1.5 text-[10px] uppercase tracking-wide"
                  style={{
                    background: "var(--color-surface-3)",
                    color: "var(--color-text-secondary)",
                  }}
                >
                  {ev.source}
                </span>
                <span
                  className="shrink-0 text-[10.5px]"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  {ev.kind}
                </span>
                <span
                  className="min-w-0 flex-1 truncate text-[11.5px]"
                  style={{ color: "var(--color-text-secondary)" }}
                  title={ev.summary}
                >
                  {ev.summary}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
