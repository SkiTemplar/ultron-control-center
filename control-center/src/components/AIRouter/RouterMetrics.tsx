// ULTRON Control Center — AI Router: Metrics Dashboard (rediseño funcional 2026-05-30)
//
// Stats REALES (antes salían a cero por un bug de diseño: la tabla agrupaba por
// task-class pero el backend keyea por provider/modelo). Ahora:
//   - Cuando totalCalls === 0: banner informativo + acordeón "Avanzado" colapsado.
//   - Cuando totalCalls > 0: Tarjetas + Matriz POR MODELO visibles.
//   - Tarjetas: tokens saved, cost saved, total invocations, éxito por ruta
//     (routeSuccess.ts; el éxito por intento no ve las cadenas saltadas enteras).
//   - Matriz POR MODELO (by_model): provider · model · calls · success% · tokens · latencia.
//
// Data source: ai_router_metrics() Tauri command (RouterMetrics con by_model).

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { routeSuccess } from "./routeSuccess";
import type { ModelMetrics, RouterMetrics as RouterMetricsType } from "./types";

const PLACEHOLDER_METRICS: RouterMetricsType = {
  fallback_output_tokens: 0,
  cost_saved_usd: 0,
  by_class: {},
  by_model: {},
};

/** "error 20 · rate_limit 3", de más a menos frecuente. */
function formatFailReasons(reasons: Record<string, number> | undefined): string {
  return Object.entries(reasons ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${reason} ${formatNum(n)}`)
    .join(" · ");
}

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
      style={{
        background: `color-mix(in srgb, ${color} 13%, transparent)`,
        color,
        border: `1px solid color-mix(in srgb, ${color} 27%, transparent)`,
      }}
    >
      {pct.toFixed(0)}%
    </span>
  );
}

// ---------------------------------------------------------------------------

export function RouterMetrics() {
  const [metrics, setMetrics] = useState<RouterMetricsType>(PLACEHOLDER_METRICS);
  const [loading, setLoading] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setBackendError(null);
    try {
      const result = (await invoke("ai_router_metrics")) as RouterMetricsType;
      setMetrics({
        // Legacy payloads named this counter tokens_saved_total.
        fallback_output_tokens:
          result?.fallback_output_tokens ??
          (result as { tokens_saved_total?: number } | null)?.tokens_saved_total ??
          0,
        cost_saved_usd: result?.cost_saved_usd ?? 0,
        real_fallback_count: result?.real_fallback_count ?? 0,
        routes_failed: result?.routes_failed ?? 0,
        routes_total: result?.routes_total ?? 0,
        recent_outcomes: result?.recent_outcomes ?? [],
        fail_reasons: result?.fail_reasons ?? {},
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
  const routes = routeSuccess(metrics);

  // Una cadena saltada entera no hace intentos: también es tráfico.
  const hasTraffic = totalCalls > 0 || routes.routesTotal > 0;

  return (
    <div className="p-6 space-y-6">
      {backendError !== null && (
        <div
          className="rounded p-3 text-[12px]"
          style={{ background: "rgba(248,81,73,0.08)", color: "var(--color-danger)", border: "1px solid rgba(248,81,73,0.3)" }}
        >
          <span className="font-semibold">Ha fallado el comando de métricas: </span>
          {backendError}
        </div>
      )}

      {/* Sin tráfico — banner informativo + acordeón avanzado colapsado */}
      {!loading && !hasTraffic && (
        <div
          className="rounded-lg p-4"
          style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
        >
          <p className="text-[13px] font-medium" style={{ color: "var(--color-text-secondary)" }}>
            El Router de IA aún no está registrando tráfico
          </p>
          <p className="mt-1.5 text-[12px] leading-relaxed" style={{ color: "var(--color-text-faint)" }}>
            Las métricas aparecerán aquí cuando alguna función use el router (captura de
            memoria, nombre automático de hooks, análisis del catálogo…).
            El tráfico principal de Claude Code no pasa por aquí.
          </p>
        </div>
      )}

      {/* Con tráfico: tarjetas + matriz */}
      {hasTraffic && (
        <>
          <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Tokens de salida del fallback"
              value={formatNum(metrics.fallback_output_tokens)}
              sub="Tokens de salida del fallback barato (no = ahorro de contexto)"
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
              sub={`${formatNum(totalTokens)} tokens · ${formatNum(metrics.routes_total ?? 0)} rutas (${formatNum(metrics.routes_failed ?? 0)} sin respuesta)`}
            />
            <StatCard
              label="Éxito por ruta"
              value={routes.pct === null ? "—" : `${routes.pct.toFixed(0)}%`}
              sub={[
                routes.window > 0
                  ? `${formatNum(routes.failedRecent)} de ${formatNum(routes.window)} rutas sin respuesta`
                  : null,
                routes.cumulativePct === null
                  ? null
                  : `acumulado ${routes.cumulativePct.toFixed(0)}% de ${formatNum(routes.routesTotal)}`,
                `intentos ${formatNum(totalSuccess)}/${formatNum(totalCalls)} OK`,
                formatFailReasons(metrics.fail_reasons)
                  ? `fallos: ${formatFailReasons(metrics.fail_reasons)}`
                  : null,
              ]
                .filter((part) => part !== null)
                .join(" · ")}
              color={routes.pct === null ? undefined : successColor(routes.pct)}
            />
          </div>

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
                    {["Proveedor", "Modelo", "Llamadas", "Éxito por intento", "Tokens", "Latencia media", "p50", "p95"].map((h) => (
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
                        <td className="px-4 py-3 text-[12px] tabular-nums" style={{ color: "var(--color-text-secondary)" }}>
                          {(m.latency_p50_ms ?? 0) > 0 ? `${(m.latency_p50_ms ?? 0).toLocaleString()} ms` : "—"}
                        </td>
                        <td className="px-4 py-3 text-[12px] tabular-nums" style={{ color: "var(--color-text-secondary)" }}>
                          {(m.latency_p95_ms ?? 0) > 0 ? `${(m.latency_p95_ms ?? 0).toLocaleString()} ms` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* Avanzado — acordeon que solo se muestra/expande cuando totalCalls > 0 */}
      {!loading && (
        <div
          className="rounded-lg overflow-hidden"
          style={{ border: "1px solid var(--color-border)" }}
        >
          <button
            type="button"
            onClick={() => setAdvancedOpen((prev) => !prev)}
            disabled={!hasTraffic}
            className="flex w-full items-center justify-between px-4 py-3 text-[12px] font-medium transition-colors disabled:opacity-40"
            style={{
              background: "var(--color-surface-1)",
              color: "var(--color-text-secondary)",
            }}
            title={hasTraffic ? undefined : "Disponible cuando el router haya procesado tráfico"}
          >
            <span>Avanzado — desglose por clase de tarea</span>
            <span style={{ color: "var(--color-text-faint)" }}>
              {advancedOpen ? "▲" : "▼"}
            </span>
          </button>

          {advancedOpen && hasTraffic && (
            <div className="px-4 py-3 space-y-2" style={{ background: "var(--color-surface-2)" }}>
              {Object.entries(metrics.by_class).length === 0 ? (
                <p className="text-[12px]" style={{ color: "var(--color-text-faint)" }}>
                  Sin datos de clase disponibles.
                </p>
              ) : (
                Object.entries(metrics.by_class).map(([cls, cm]) => (
                  <div key={cls} className="flex items-center justify-between text-[12px]">
                    <span className="capitalize" style={{ color: "var(--color-text-secondary)" }}>
                      {cls}
                    </span>
                    <span className="tabular-nums" style={{ color: "var(--color-text)" }}>
                      {formatNum(cm.count)} llamadas · {formatNum(cm.tokens)} tok ·{" "}
                      {cm.latency_p95_ms > 0 ? `p95 ${cm.latency_p95_ms}ms` : "—"}
                    </span>
                  </div>
                ))
              )}
            </div>
          )}
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
          {loading ? "Actualizando…" : "Actualizar"}
        </button>
      </div>
    </div>
  );
}
