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

interface ProviderUsageRow {
  provider_id: string;
  key_present: boolean;
}

interface RouterUsageSummary {
  providers: ProviderUsageRow[];
  /** EMA de fallo por intento (ex-fallback_rate). */
  attempt_failure_rate: number;
  /** Fracción de rutas que cayeron a secundario (0.0..=1.0). */
  real_fallback_rate: number;
  /** Contador absoluto de rutas con fallback ganador. */
  real_fallback_count: number;
  /** Total de invocaciones de route() completadas. Optional for old backend compat. */
  routes_total?: number;
  /** Campo legacy — puede estar ausente en versiones nuevas. */
  fallback_rate?: number;
}

function SummaryStat({ label, value, color }: { label: string; value: string; color?: string }) {
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

  // real_fallback_rate = fraction of routes that fell to a secondary provider
  // (the honest metric). attempt_failure_rate = EMA of per-attempt failures
  // (can inflate the number; shown separately as context, not as the headline).
  const realFallbackPct = summary ? Math.round(summary.real_fallback_rate * 100) : 0;
  const attemptFailurePct = summary ? Math.round(summary.attempt_failure_rate * 100) : 0;
  const realFallbackColor =
    realFallbackPct > 50
      ? "var(--color-danger)"
      : realFallbackPct > 20
        ? "var(--color-warn)"
        : "var(--color-success)";
  const attemptColor =
    attemptFailurePct > 50
      ? "var(--color-danger)"
      : attemptFailurePct > 20
        ? "var(--color-warn)"
        : "var(--color-success)";

  return (
    <div className="space-y-2">
      {/* Summary strip — 3 stats: providers keyed, real fallback (headline), attempt failure */}
      <div className="grid grid-cols-2 gap-3 px-6 pt-6 sm:grid-cols-3">
        <SummaryStat
          label="Providers con key"
          value={`${keyedCount}/${providerCount}`}
        />
        <SummaryStat
          label="Fallback real (cae a secundario)"
          value={routesTotal === 0 ? "—" : `${realFallbackPct}%`}
          color={routesTotal === 0 ? undefined : realFallbackColor}
        />
        <SummaryStat
          label="Fallo por intento (EMA)"
          value={routesTotal === 0 ? "—" : `${attemptFailurePct}%`}
          color={routesTotal === 0 ? undefined : attemptColor}
        />
      </div>

      {/* Savings + per-model breakdown. */}
      <RouterMetrics />

      {/* Proxy inline card — folded in from the retired Proxy sub-tab. */}
      <div className="px-6 pb-6">
        <h2
          className="mb-3 text-[13px] font-semibold"
          style={{ color: "var(--color-text-secondary)" }}
        >
          Proxy free-tier
        </h2>
        <ProxyControl />
      </div>
    </div>
  );
}
