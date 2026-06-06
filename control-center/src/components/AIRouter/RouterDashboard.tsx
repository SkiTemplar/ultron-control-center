// ULTRON Control Center — AI Router: Dashboard sub-tab
//
// Simple overview the user asked for: savings + model routing at a glance.
//   - A compact summary strip (zones, providers-with-key, fallback rate).
//   - The RouterMetrics dashboard (tokens/cost saved + per-model table).
//
// Data: ai_router_usage_summary() for the strip, ai_router_metrics() inside
// RouterMetrics. Both fall back gracefully when the backend isn't wired.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RouterMetrics } from "./RouterMetrics";

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
  /** Total de invocaciones de route() completadas. */
  routes_total: number;
  zone_chains: Record<string, unknown>;
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

  const zoneCount = summary ? Object.keys(summary.zone_chains).length : 0;
  const providerCount = summary ? summary.providers.length : 0;
  const keyedCount = summary ? summary.providers.filter((p) => p.key_present).length : 0;

  // FIX 2: usar los campos correctos del contrato del backend.
  // real_fallback_rate = fracción de rutas que cayeron a secundario (métrica honesta).
  // attempt_failure_rate = EMA de fallo por intento (puede inflar el número).
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
      <div className="grid grid-cols-2 gap-3 px-6 pt-6 sm:grid-cols-4">
        <SummaryStat label="Zonas" value={String(zoneCount)} />
        <SummaryStat label="Providers con key" value={`${keyedCount}/${providerCount}`} />
        <SummaryStat
          label="Fallback real (cae a secundario)"
          value={`${realFallbackPct}%`}
          color={realFallbackColor}
        />
        <SummaryStat
          label="Tasa de fallo de intentos"
          value={`${attemptFailurePct}%`}
          color={attemptColor}
        />
      </div>

      {/* Savings + per-model breakdown. */}
      <RouterMetrics />
    </div>
  );
}
