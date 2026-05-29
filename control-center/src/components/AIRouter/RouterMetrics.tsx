// ULTRON Control Center — AI Router: Metrics Dashboard (rediseño funcional 2026-05-30)
//
// Stats REALES (antes salían a cero por un bug de diseño: la tabla agrupaba por
// task-class pero el backend keyea por provider/modelo). Ahora:
//   - Tarjetas: tokens saved, cost saved, total invocations, success rate.
//   - Matriz POR MODELO (by_model): provider · model · calls · success% · tokens · latencia.
//
// Data source: ai_router_metrics() Tauri command (RouterMetrics con by_model).

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ModelMetrics, RouterMetrics as RouterMetricsType } from "./types";

const PLACEHOLDER_METRICS: RouterMetricsType = {
  tokens_saved_total: 0,
  cost_saved_usd: 0,
  by_class: {},
  fallback_rate: 0,
  by_model: {},
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

/** Color del badge de success rate: verde >=95, ámbar 80-95, rojo <80. */
function successColor(pct: number): string {
  if (pct >= 95) return "var(--color-success)";
  if (pct >= 80) return "var(--color-warn)";
  return "var(--color-danger)";
}

function shortModel(m: string): string {
  return m.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

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
      style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
    >
      <span
        className="text-[11px] font-semibold uppercase tracking-wide"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        {label}
      </span>
      <span className="text-[22px] font-bold tabular-nums" style={{ color: color ?? "var(--color-text)" }}>
        {value}
      </span>
      {sub !== undefined && sub.length > 0 && (
        <span className="text-[11px]" style={{ color: "var(--color-text-faint)" }}>
          {sub}
        </span>
      )}
    </div>
  );
}

function SuccessBadge({ pct, calls }: { pct: number; calls: number }) {
  if (calls === 0) {
    return (
      <span className="text-[11px]" style={{ color: "var(--color-text-faint)" }}>
        —
      </span>
    );
  }
  const color = successColor(pct);
  return (
    <span
      className="rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums"
      style={{ background: `${color}22`, color, border: `1px solid ${color}44` }}
    >
      {pct.toFixed(0)}%
    </span>
  );
}

function MetricsEmptyState() {
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 rounded-lg p-8"
      style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)", minHeight: 160 }}
    >
      <span className="text-[13px] font-medium" style={{ color: "var(--color-text-secondary)" }}>
        Aún sin métricas
      </span>
      <span className="text-center text-[12px] max-w-[360px]" style={{ color: "var(--color-text-faint)" }}>
        Haz alguna llamada por el AI Router para poblar el dashboard (botón Test en
        Zones, o cualquier feature que use route(): auto-name de hooks, análisis de
        catálogo, goals de workdays…). El tráfico principal de Claude Code NO pasa por
        aquí.
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function RouterMetrics() {
  const [metrics, setMetrics] = useState<RouterMetricsType>(PLACEHOLDER_METRICS);
  const [loading, setLoading] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [backendError, setBackendError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setBackendError(null);
    try {
      const result = (await invoke("ai_router_metrics")) as RouterMetricsType;
      setMetrics({
        tokens_saved_total: result?.tokens_saved_total ?? 0,
        cost_saved_usd: result?.cost_saved_usd ?? 0,
        fallback_rate: result?.fallback_rate ?? 0,
        by_class: result?.by_class ?? {},
        by_model: result?.by_model ?? {},
      });
      setLastRefreshed(new Date());
    } catch (err) {
      setMetrics(PLACEHOLDER_METRICS);
      setBackendError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Filas por modelo ordenadas por nº de llamadas desc.
  const models = useMemo<ModelMetrics[]>(() => {
    const rows = Object.values(metrics.by_model ?? {});
    return rows.sort((a, b) => b.count - a.count);
  }, [metrics.by_model]);

  const totalCalls = models.reduce((s, m) => s + m.count, 0);
  const totalSuccess = models.reduce((s, m) => s + m.success_count, 0);
  const totalTokens = models.reduce((s, m) => s + m.output_tokens, 0);
  const successRate = totalCalls > 0 ? (totalSuccess / totalCalls) * 100 : 0;

  const isEmpty =
    !loading && backendError === null && totalCalls === 0 && metrics.tokens_saved_total === 0;

  return (
    <div className="p-6 space-y-6">
      {backendError !== null && (
        <div
          className="rounded p-3 text-[12px]"
          style={{ background: "rgba(248,81,73,0.08)", color: "var(--color-danger)", border: "1px solid rgba(248,81,73,0.3)" }}
        >
          <span className="font-semibold">Metrics command failed: </span>
          {backendError}
        </div>
      )}

      {/* Top-line stats (reales) */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard
          label="Tokens ahorrados"
          value={formatNum(metrics.tokens_saved_total)}
          sub="servidos por fallback más barato"
          color="var(--color-success)"
        />
        <StatCard
          label="Coste ahorrado"
          value={formatUsd(metrics.cost_saved_usd)}
          sub="vs. tarifa del primario"
          color="var(--color-success)"
        />
        <StatCard
          label="Invocaciones"
          value={formatNum(totalCalls)}
          sub={`${formatNum(totalTokens)} tokens · fallback ${((metrics.fallback_rate ?? 0) * 100).toFixed(0)}%`}
        />
        <StatCard
          label="Success rate"
          value={totalCalls > 0 ? `${successRate.toFixed(0)}%` : "—"}
          sub={`${formatNum(totalSuccess)}/${formatNum(totalCalls)} OK`}
          color={totalCalls > 0 ? successColor(successRate) : undefined}
        />
      </div>

      {/* Matriz por modelo */}
      {isEmpty ? (
        <MetricsEmptyState />
      ) : (
        <div>
          <h2 className="mb-3 text-[13px] font-semibold" style={{ color: "var(--color-text-secondary)" }}>
            Por modelo ({models.length})
          </h2>
          <div
            className="overflow-hidden rounded-lg"
            style={{ border: "1px solid var(--color-border)", background: "var(--color-surface-2)" }}
          >
            <table className="w-full table-auto text-left">
              <thead>
                <tr style={{ borderBottom: "1px solid var(--color-border)", background: "var(--color-surface-1)" }}>
                  {["Proveedor", "Modelo", "Llamadas", "Success", "Tokens", "Latencia"].map((h) => (
                    <th
                      key={h}
                      className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide"
                      style={{ color: "var(--color-text-tertiary)" }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {models.map((m) => {
                  const pct = m.count > 0 ? (m.success_count / m.count) * 100 : 0;
                  return (
                    <tr key={`${m.provider_id}::${m.model}`} style={{ borderBottom: "1px solid var(--color-border)" }}>
                      <td className="px-4 py-3 text-[12px]" style={{ color: "var(--color-text-secondary)" }}>
                        {m.provider_id}
                      </td>
                      <td className="px-4 py-3 text-[12px] font-medium" style={{ color: "var(--color-text)", fontFamily: "var(--font-mono)" }}>
                        {shortModel(m.model)}
                      </td>
                      <td className="px-4 py-3 text-[12px] tabular-nums" style={{ color: "var(--color-text)" }}>
                        {formatNum(m.count)}
                      </td>
                      <td className="px-4 py-3">
                        <SuccessBadge pct={pct} calls={m.count} />
                      </td>
                      <td className="px-4 py-3 text-[12px] tabular-nums" style={{ color: "var(--color-text-secondary)" }}>
                        {formatNum(m.output_tokens)}
                      </td>
                      <td className="px-4 py-3 text-[12px] tabular-nums" style={{ color: "var(--color-text-secondary)" }}>
                        {m.latency_ms_avg > 0 ? `${m.latency_ms_avg.toLocaleString()} ms` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between">
        <p className="text-[11px]" style={{ color: "var(--color-text-faint)" }}>
          {loading
            ? "Cargando métricas…"
            : lastRefreshed !== null
              ? `Actualizado ${lastRefreshed.toLocaleTimeString()}`
              : "Métricas no disponibles."}
        </p>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="rounded px-3 py-1.5 text-[11px] transition-colors disabled:opacity-40"
          style={{ background: "var(--color-surface-2)", color: "var(--color-text-secondary)", border: "1px solid var(--color-border)" }}
        >
          {loading ? "Refrescando…" : "Refresh"}
        </button>
      </div>
    </div>
  );
}
