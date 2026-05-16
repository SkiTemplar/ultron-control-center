import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Cost watchdog card — projects daily token/USD burn from the rolling
// token-usage probe log and warns the user before a bill arrives.
// Mounted at the top of SelfImprove.tsx so it sits with the other
// self-improvement telemetry.

type CostSnapshot = {
  window_hours: number;
  total_tokens: number;
  projected_daily_tokens: number;
  projected_daily_usd_low: number;
  projected_daily_usd_high: number;
  top_models: [string, number][];
  alert: string | null;
};

const WINDOWS: { value: number; label: string }[] = [
  { value: 1, label: "1h" },
  { value: 6, label: "6h" },
  { value: 24, label: "24h" },
];

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatUsd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

export function CostWatchdog() {
  const [windowHours, setWindowHours] = useState<number>(6);
  const [snap, setSnap] = useState<CostSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load(hours: number) {
    setLoading(true);
    try {
      const r = (await invoke("compute_cost", { windowHours: hours })) as CostSnapshot;
      setSnap(r);
      setError(null);
    } catch (e) {
      setError(String(e));
      setSnap(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(windowHours);
    const t = setInterval(() => load(windowHours), 60_000);
    return () => clearInterval(t);
  }, [windowHours]);

  const maxTop = useMemo(() => {
    if (!snap || snap.top_models.length === 0) return 1;
    return Math.max(1, ...snap.top_models.map(([, n]) => n));
  }, [snap]);

  return (
    <div
      className="rounded p-4"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <div
            className="text-[12.5px] font-medium"
            style={{ color: "var(--color-text)" }}
          >
            Cost watchdog
          </div>
          <p
            className="mt-1 text-[11px] leading-relaxed"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Projects your daily token spend by extrapolating from a recent
            window of the local usage log. USD is a rough range — actual
            billing depends on the input/output mix per model.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {WINDOWS.map((w) => (
            <button
              key={w.value}
              type="button"
              onClick={() => setWindowHours(w.value)}
              className="rounded px-2 py-1 text-[11px] font-medium transition-colors"
              style={{
                background:
                  windowHours === w.value
                    ? "var(--color-surface-4)"
                    : "var(--color-surface-3)",
                color:
                  windowHours === w.value
                    ? "var(--color-text)"
                    : "var(--color-text-secondary)",
                border: "1px solid var(--color-border-strong)",
              }}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div
          className="mt-3 rounded p-2 text-[11.5px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {snap && (
        <>
          <div className="mt-3 grid grid-cols-3 gap-3">
            <Stat
              label="Tokens in window"
              value={formatNumber(snap.total_tokens)}
              footer={`Last ${snap.window_hours}h`}
            />
            <Stat
              label="Projected daily tokens"
              value={formatNumber(snap.projected_daily_tokens)}
              footer="Straight-line extrapolation"
            />
            <Stat
              label="Projected daily cost"
              value={`${formatUsd(snap.projected_daily_usd_low)} — ${formatUsd(
                snap.projected_daily_usd_high
              )}`}
              footer="Range (low/high)"
            />
          </div>

          {snap.alert && (
            <div
              className="mt-3 rounded p-2.5 text-[11.5px]"
              style={{
                background: "rgba(210, 153, 34, 0.08)",
                border: "1px solid rgba(210, 153, 34, 0.30)",
                color: "var(--color-warn)",
              }}
            >
              {snap.alert}
            </div>
          )}

          {snap.top_models.length > 0 && (
            <div className="mt-3">
              <div
                className="mb-2 text-[10px] font-medium uppercase tracking-[0.06em]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                Top buckets (model / layer)
              </div>
              <div className="space-y-1.5">
                {snap.top_models.map(([name, n]) => {
                  const pct = Math.max(2, Math.round((n / maxTop) * 100));
                  return (
                    <div key={name} className="flex items-center gap-2">
                      <div
                        className="w-32 shrink-0 truncate text-[11px]"
                        style={{
                          color: "var(--color-text-secondary)",
                          fontFamily: "var(--font-mono)",
                        }}
                        title={name}
                      >
                        {name}
                      </div>
                      <div
                        className="relative h-3 flex-1 overflow-hidden rounded-sm"
                        style={{ background: "var(--color-surface-3)" }}
                      >
                        <div
                          className="h-full"
                          style={{
                            width: `${pct}%`,
                            background: "var(--color-text-secondary)",
                            opacity: 0.55,
                          }}
                        />
                      </div>
                      <div
                        className="w-20 shrink-0 text-right text-[11px] tabular-nums"
                        style={{ color: "var(--color-text-tertiary)" }}
                      >
                        {formatNumber(n)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      {!snap && !error && !loading && (
        <div
          className="mt-3 text-[11.5px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          No usage data yet — ~/.ultron/.tmp/token-usage.jsonl is empty or absent.
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  footer,
}: {
  label: string;
  value: string;
  footer: string;
}) {
  return (
    <div
      className="rounded p-3"
      style={{
        background: "var(--color-surface-1)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div
        className="text-[10px] font-medium uppercase tracking-[0.06em]"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        {label}
      </div>
      <div
        className="mt-1 text-[16px] font-semibold tabular-nums"
        style={{ color: "var(--color-text)" }}
      >
        {value}
      </div>
      <div
        className="mt-1 text-[10.5px]"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        {footer}
      </div>
    </div>
  );
}
