// Plan quota panel — the two gauges `/usage` shows inside Claude Code, served
// from the Anthropic OAuth endpoint via the `claude_plan_limits` command.
//
// Everything else in the Usage tab is consumption computed from local files.
// This card is the only piece that knows how much of the *plan* is left, which
// is the number worth glancing at before starting a long session.
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PlanLimits, PlanWindow } from "../../types";

const POLL_MS = 60_000;

/// "1 h 12 min", "4 min", "3 d 2 h" — a countdown reads better than an ISO
/// instant when the only question is "how long until this frees up".
function untilReset(iso: string | null): string | null {
  if (!iso) return null;
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return null;
  const diffMs = target - Date.now();
  if (diffMs <= 0) return "ahora";
  const mins = Math.round(diffMs / 60_000);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const restMins = mins % 60;
  if (hours < 24) return restMins > 0 ? `${hours} h ${restMins} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours > 0 ? `${days} d ${restHours} h` : `${days} d`;
}

function barColor(percent: number): string {
  if (percent >= 90) return "var(--color-danger, #e5484d)";
  if (percent >= 70) return "var(--color-warning, #ffb224)";
  return "var(--color-accent)";
}

function Gauge({
  title,
  window: w,
  emphasized = false,
}: {
  title: string;
  window: PlanWindow;
  emphasized?: boolean;
}) {
  const pct = Math.min(100, Math.max(0, w.utilization));
  const reset = untilReset(w.resets_at);
  return (
    <div
      className="rounded p-4"
      style={{
        background: emphasized ? "var(--color-surface-3)" : "var(--color-surface-2)",
        border: `1px solid ${emphasized ? "var(--color-border-strong)" : "var(--color-border)"}`,
      }}
    >
      <div className="flex items-baseline justify-between">
        <div
          className="text-[10px] font-medium uppercase tracking-[0.06em]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {title}
        </div>
        {reset && (
          <span className="text-[10px]" style={{ color: "var(--color-text-faint)" }}>
            libera en {reset}
          </span>
        )}
      </div>
      <div className="mt-2 flex items-baseline gap-1">
        <span className="text-[26px] font-semibold tabular-nums leading-none">
          {Math.round(pct)}
        </span>
        <span className="text-[13px]" style={{ color: "var(--color-text-tertiary)" }}>
          % usado
        </span>
      </div>
      <div
        className="mt-3 h-2 w-full overflow-hidden rounded-full"
        style={{ background: "var(--color-surface-1, rgba(127,127,127,0.18))" }}
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={title}
      >
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${pct}%`, background: barColor(pct) }}
        />
      </div>
    </div>
  );
}

export function PlanLimitsCard() {
  const [data, setData] = useState<PlanLimits | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (force = false) => {
    if (force) setBusy(true);
    try {
      const r = (await invoke("claude_plan_limits", { force })) as PlanLimits;
      setData(r);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      if (force) setBusy(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => load(), POLL_MS);
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  // Per-model caps (e.g. Fable) only matter when one actually exists.
  const scoped = (data?.limits ?? []).filter((l) => l.scope_label && l.percent > 0);

  return (
    <div
      className="mb-6 rounded p-4"
      style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
    >
      <header className="mb-3 flex items-baseline justify-between gap-4">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[13px] font-semibold">Límite del plan</h2>
          {data?.subscription_type && (
            <span
              className="rounded px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-[0.06em]"
              style={{ background: "var(--color-surface-3)", color: "var(--color-text-tertiary)" }}
            >
              {data.subscription_type}
            </span>
          )}
          {data?.stale && (
            <span className="text-[10px]" style={{ color: "var(--color-warning, #ffb224)" }}>
              sin conexión · datos en caché
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => load(true)}
          disabled={busy}
          className="shrink-0 rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors disabled:opacity-50"
          style={{ background: "var(--color-surface-3)", color: "var(--color-text-secondary)" }}
        >
          {busy ? "Actualizando…" : "Actualizar"}
        </button>
      </header>

      {error && !data && (
        <p className="text-[12px]" style={{ color: "var(--color-danger, #e5484d)" }}>
          {error}
        </p>
      )}

      {!error && !data && (
        <p className="text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
          Consultando…
        </p>
      )}

      {data && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {data.five_hour && <Gauge title="Ventana 5 h" window={data.five_hour} emphasized />}
            {data.seven_day && <Gauge title="Semanal" window={data.seven_day} />}
          </div>

          {scoped.length > 0 && (
            <div className="mt-3 space-y-1">
              {scoped.map((l) => (
                <div
                  key={`${l.kind}-${l.scope_label}`}
                  className="flex items-baseline justify-between text-[11.5px]"
                >
                  <span style={{ color: "var(--color-text-tertiary)" }}>
                    {l.scope_label}
                    {l.group === "weekly" ? " · semanal" : ""}
                  </span>
                  <span className="tabular-nums" style={{ color: "var(--color-text-secondary)" }}>
                    {Math.round(l.percent)} %
                  </span>
                </div>
              ))}
            </div>
          )}

          {data.breakdown.length > 0 && (
            <div className="mt-4">
              <div
                className="mb-1.5 text-[9px] font-medium uppercase tracking-[0.06em]"
                style={{ color: "var(--color-text-faint)" }}
              >
                Reparto de la semana
              </div>
              <div className="flex h-1.5 w-full overflow-hidden rounded-full">
                {data.breakdown.map((row, i) => (
                  <div
                    key={row.key}
                    title={`${row.display_name}: ${Math.round(row.percent)} %`}
                    style={{
                      width: `${row.percent}%`,
                      background: `var(--color-accent)`,
                      opacity: 1 - i * 0.25,
                    }}
                  />
                ))}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
                {data.breakdown.map((row) => (
                  <span
                    key={row.key}
                    className="text-[11px]"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    {row.display_name}{" "}
                    <span className="tabular-nums" style={{ color: "var(--color-text-secondary)" }}>
                      {Math.round(row.percent)} %
                    </span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
