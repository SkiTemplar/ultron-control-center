// ULTRON Control Center — AI Router: Dashboard sub-tab
//
// Overview: savings + model routing at a glance + inline proxy card.
//   - A compact summary strip (providers-with-key, real fallback rate,
//     attempt failure rate).
//   - The RouterMetrics dashboard (tokens/cost saved + per-model table).
//   - ProxyControl inline card (folded in from the old Proxy sub-tab).
//
// Data: ai_router_usage_summary() for the strip, ai_router_metrics() inside
// RouterMetrics. Both fall back gracefully when the backend isn't wired.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RouterMetrics } from "./RouterMetrics";
import { ProxyControl } from "./ProxyControl";
import { OllamaControl } from "./OllamaControl";

interface ProviderUsageRow {
  provider_id: string;
  key_present: boolean;
  /** Último error terminal de HOY (limpio tras un éxito). F1 2026-06-10. */
  last_error?: string | null;
  last_error_at?: string | null;
  /** Fallos terminales consecutivos hoy (0 tras cualquier éxito). */
  consecutive_failures?: number;
  /** Instante RFC3339 hasta el que route() soft-skipea este provider. */
  cooldown_until?: string | null;
}

interface RouterUsageSummary {
  providers: ProviderUsageRow[];
  /** EMA de fallo por intento: contexto, no una tasa por ruta. */
  attempt_failure_rate: number;
  /** Rutas que el primary no sirvió (fallback o cadena agotada), acumulado. */
  real_fallback_rate: number;
  /** Rutas con la cadena agotada (sin respuesta), acumulado. */
  route_failure_rate?: number;
  routes_failed?: number;
  /** Total de llamadas a route(), fallidas incluidas. */
  routes_total?: number;
  /** Lo mismo que real_fallback_rate sobre las últimas `recent_window` rutas: la señal accionable. */
  real_fallback_rate_recent?: number;
  route_failure_rate_recent?: number;
  recent_window?: number;
}

function rateColor(pct: number): string {
  if (pct > 50) return "var(--color-danger)";
  if (pct > 20) return "var(--color-warn)";
  return "var(--color-success)";
}

const pct = (x: number | undefined) => Math.round((x ?? 0) * 100);

function SummaryStat({
  label,
  value,
  color,
  sub,
}: {
  label: string;
  value: string;
  color?: string;
  sub?: string;
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
      {sub && (
        <span className="text-[11px]" style={{ color: "var(--color-text-faint)" }}>
          {sub}
        </span>
      )}
    </div>
  );
}

export function RouterDashboard() {
  const [summary, setSummary] = useState<RouterUsageSummary | null>(null);

  const load = useCallback(async () => {
    try {
      const r = (await invoke("ai_router_usage_summary")) as RouterUsageSummary;
      setSummary(r);
    } catch {
      setSummary(null);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  const providerCount = summary ? summary.providers.length : 0;
  const keyedCount = summary ? summary.providers.filter((p) => p.key_present).length : 0;
  const routesTotal = summary ? (summary.routes_total ?? 0) : 0;
  const recentWindow = summary?.recent_window ?? 0;

  // Titular = real_fallback_rate sobre la ventana reciente: el dato honesto y
  // accionable (rutas que el primary no sirvió, fallos totales incluidos). El
  // acumulado arrastra proveedores retirados y va como contexto, igual que la
  // EMA de fallo por intento, que no es una tasa por ruta.
  const recentPct = pct(summary?.real_fallback_rate_recent);
  const recentFailedPct = pct(summary?.route_failure_rate_recent);
  const cumulativePct = pct(summary?.real_fallback_rate);
  const cumulativeFailedPct = pct(summary?.route_failure_rate);
  const attemptFailurePct = pct(summary?.attempt_failure_rate);

  return (
    <div className="space-y-2">
      {/* Summary strip — providers keyed, real fallback (recent window, headline), attempt failure */}
      <div className="grid grid-cols-2 gap-3 px-6 pt-6 sm:grid-cols-3">
        <SummaryStat
          label="Proveedores con key"
          value={`${keyedCount}/${providerCount}`}
        />
        <SummaryStat
          label={`Fallback real (últimas ${recentWindow} rutas)`}
          value={recentWindow === 0 ? "—" : `${recentPct}%`}
          color={recentWindow === 0 ? undefined : rateColor(recentPct)}
          sub={
            routesTotal === 0
              ? undefined
              : `sin respuesta ${recentFailedPct}% · acumulado ${cumulativePct}% (sin respuesta ${cumulativeFailedPct}%) de ${routesTotal} rutas`
          }
        />
        <SummaryStat
          label="Fallo por intento (EMA, contexto)"
          value={routesTotal === 0 ? "—" : `${attemptFailurePct}%`}
          color={routesTotal === 0 ? undefined : rateColor(attemptFailurePct)}
        />
      </div>

      {/* Salud de providers (F1): POR QUÉ falla cada provider, no solo cuánto.
          Solo se pinta cuando hay algo que contar (error reciente o cooldown). */}
      {summary && summary.providers.some((p) => p.last_error || p.cooldown_until) && (
        <div className="px-6 pt-2">
          <h2
            className="mb-2 text-[13px] font-semibold"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Salud de los proveedores (hoy)
          </h2>
          <div className="space-y-1">
            {summary.providers
              .filter((p) => p.last_error || p.cooldown_until)
              .map((p) => {
                const cooling =
                  p.cooldown_until && new Date(p.cooldown_until).getTime() > Date.now();
                return (
                  <div
                    key={p.provider_id}
                    className="flex items-start gap-2 rounded-md px-3 py-2 text-[12px]"
                    style={{
                      background: "var(--color-surface-2)",
                      border: "1px solid var(--color-border)",
                    }}
                  >
                    <span className="font-semibold" style={{ color: "var(--color-text)" }}>
                      {p.provider_id}
                    </span>
                    {cooling && (
                      <span
                        className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase"
                        style={{ background: "var(--color-warn)", color: "#000" }}
                        title={`En cooldown hasta ${p.cooldown_until}`}
                      >
                        cooldown
                      </span>
                    )}
                    {(p.consecutive_failures ?? 0) > 0 && (
                      <span style={{ color: "var(--color-text-tertiary)" }}>
                        ×{p.consecutive_failures} seguidos
                      </span>
                    )}
                    <span
                      className="min-w-0 flex-1 truncate"
                      style={{ color: "var(--color-danger)" }}
                      title={p.last_error ?? undefined}
                    >
                      {p.last_error ?? ""}
                    </span>
                  </div>
                );
              })}
          </div>
        </div>
      )}

      {/* Savings + per-model breakdown. */}
      <RouterMetrics />

      {/* Proxy inline card — folded in from the retired Proxy sub-tab. */}
      <div className="px-6 pb-6">
        <h2
          className="mb-3 text-[13px] font-semibold"
          style={{ color: "var(--color-text-secondary)" }}
        >
          Proxy de nivel gratuito
        </h2>
        <ProxyControl />
      </div>

      {/* Modelo local (Ollama) — motor del autocompletado (mismo mando que la bandeja). */}
      <div className="px-6 pb-6">
        <h2
          className="mb-3 text-[13px] font-semibold"
          style={{ color: "var(--color-text-secondary)" }}
        >
          Modelo local (Ollama)
        </h2>
        <OllamaControl />
      </div>
    </div>
  );
}
