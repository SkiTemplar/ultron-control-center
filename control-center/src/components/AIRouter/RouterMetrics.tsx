// ULTRON Control Center — AI Router: Metrics Dashboard
//
// Shows aggregate routing performance:
//   - Total tokens saved and USD cost saved
//   - Distribution by task class (trivial / light / medium / heavy)
//   - Fallback rate (fraction of calls that hit a fallback)
//   - p95 latency per task class
//
// Data source: ai_router_metrics() Tauri command.
// Uses a static placeholder when the command is unavailable.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProviderClass, RouterMetrics as RouterMetricsType } from "./types";

// ---------------------------------------------------------------------------
// Placeholder data shown when the backend is not yet wired.
// ---------------------------------------------------------------------------

const PLACEHOLDER_METRICS: RouterMetricsType = {
  tokens_saved_total: 0,
  cost_saved_usd: 0.0,
  by_class: {
    trivial: { count: 0, tokens: 0, latency_p95_ms: 0 },
    light: { count: 0, tokens: 0, latency_p95_ms: 0 },
    medium: { count: 0, tokens: 0, latency_p95_ms: 0 },
    heavy: { count: 0, tokens: 0, latency_p95_ms: 0 },
  },
  fallback_rate: 0,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CLASS_ORDER: ProviderClass[] = ["trivial", "light", "medium", "heavy"];

const CLASS_COLORS: Record<ProviderClass, string> = {
  trivial: "var(--color-success)",
  light: "var(--color-warn)",
  medium: "#a875ff",
  heavy: "var(--color-danger)",
};

function formatNum(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

function formatUsd(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(2)}k`;
  return `$${n.toFixed(4)}`;
}

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div
      className="flex flex-col gap-1 rounded-lg p-4"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <span
        className="text-[11px] font-semibold uppercase tracking-wide"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        {label}
      </span>
      <span
        className="text-[22px] font-bold tabular-nums"
        style={{ color: color ?? "var(--color-text)" }}
      >
        {value}
      </span>
      {sub !== undefined && sub.length > 0 && (
        <span
          className="text-[11px]"
          style={{ color: "var(--color-text-faint)" }}
        >
          {sub}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RouterMetrics
// ---------------------------------------------------------------------------

export function RouterMetrics() {
  const [metrics, setMetrics] = useState<RouterMetricsType>(PLACEHOLDER_METRICS);
  const [loading, setLoading] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = (await invoke("ai_router_metrics")) as RouterMetricsType;
      setMetrics(result);
      setLastRefreshed(new Date());
    } catch {
      // Backend not yet wired — keep placeholder but mark loaded.
      setMetrics(PLACEHOLDER_METRICS);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const totalCalls = CLASS_ORDER.reduce(
    (sum, cls) => sum + metrics.by_class[cls].count,
    0,
  );

  const totalTokens = CLASS_ORDER.reduce(
    (sum, cls) => sum + metrics.by_class[cls].tokens,
    0,
  );

  return (
    <div className="p-6 space-y-6">
      {/* ------------------------------------------------------------------ */}
      {/* Top-line stats                                                      */}
      {/* ------------------------------------------------------------------ */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard
          label="Tokens saved"
          value={formatNum(metrics.tokens_saved_total)}
          sub="vs. always using heaviest model"
          color="var(--color-success)"
        />
        <StatCard
          label="Cost saved"
          value={formatUsd(metrics.cost_saved_usd)}
          sub="estimated savings"
          color="var(--color-success)"
        />
        <StatCard
          label="Total invocations"
          value={formatNum(totalCalls)}
          sub={`${formatNum(totalTokens)} tokens total`}
        />
        <StatCard
          label="Fallback rate"
          value={`${(metrics.fallback_rate * 100).toFixed(1)}%`}
          sub="calls that hit a fallback"
          color={
            metrics.fallback_rate > 0.15
              ? "var(--color-danger)"
              : "var(--color-text)"
          }
        />
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Class breakdown                                                     */}
      {/* ------------------------------------------------------------------ */}
      <div>
        <h2
          className="mb-3 text-[13px] font-semibold"
          style={{ color: "var(--color-text-secondary)" }}
        >
          Distribution by task class
        </h2>
        <div
          className="overflow-hidden rounded-lg"
          style={{
            border: "1px solid var(--color-border)",
            background: "var(--color-surface-2)",
          }}
        >
          <table className="w-full table-auto text-left">
            <thead>
              <tr
                style={{
                  borderBottom: "1px solid var(--color-border)",
                  background: "var(--color-surface-1)",
                }}
              >
                {["Class", "Invocations", "Tokens", "p95 Latency", "Share"].map(
                  (h) => (
                    <th
                      key={h}
                      className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide"
                      style={{ color: "var(--color-text-tertiary)" }}
                    >
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {CLASS_ORDER.map((cls) => {
                const cm = metrics.by_class[cls];
                const share =
                  totalCalls > 0 ? (cm.count / totalCalls) * 100 : 0;
                const color = CLASS_COLORS[cls];

                return (
                  <tr
                    key={cls}
                    style={{ borderBottom: "1px solid var(--color-border)" }}
                  >
                    {/* Class badge */}
                    <td className="px-4 py-3">
                      <span
                        className="rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
                        style={{
                          background: `${color}22`,
                          color,
                          border: `1px solid ${color}44`,
                        }}
                      >
                        {cls}
                      </span>
                    </td>

                    {/* Count */}
                    <td
                      className="px-4 py-3 text-[12px] tabular-nums"
                      style={{ color: "var(--color-text)" }}
                    >
                      {formatNum(cm.count)}
                    </td>

                    {/* Tokens */}
                    <td
                      className="px-4 py-3 text-[12px] tabular-nums"
                      style={{ color: "var(--color-text-secondary)" }}
                    >
                      {formatNum(cm.tokens)}
                    </td>

                    {/* p95 latency */}
                    <td
                      className="px-4 py-3 text-[12px] tabular-nums"
                      style={{ color: "var(--color-text-secondary)" }}
                    >
                      {cm.latency_p95_ms > 0
                        ? `${cm.latency_p95_ms.toLocaleString()} ms`
                        : "—"}
                    </td>

                    {/* Share bar */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div
                          className="h-1.5 rounded-full overflow-hidden"
                          style={{
                            width: 80,
                            background: "var(--color-surface-1)",
                          }}
                        >
                          <div
                            className="h-full rounded-full transition-all"
                            style={{
                              width: `${Math.min(share, 100)}%`,
                              background: color,
                            }}
                          />
                        </div>
                        <span
                          className="text-[11px] tabular-nums"
                          style={{ color: "var(--color-text-faint)" }}
                        >
                          {share.toFixed(1)}%
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Footer                                                              */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex items-center justify-between">
        <p
          className="text-[11px]"
          style={{ color: "var(--color-text-faint)" }}
        >
          {loading
            ? "Loading metrics..."
            : lastRefreshed !== null
              ? `Last refreshed ${lastRefreshed.toLocaleTimeString()}`
              : "Metrics unavailable — backend command not yet wired."}
        </p>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="rounded px-3 py-1.5 text-[11px] transition-colors disabled:opacity-40"
          style={{
            background: "var(--color-surface-2)",
            color: "var(--color-text-secondary)",
            border: "1px solid var(--color-border)",
          }}
        >
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>
    </div>
  );
}
