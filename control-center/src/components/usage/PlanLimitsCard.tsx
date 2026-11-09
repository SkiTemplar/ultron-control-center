// Plan quota panel — the two gauges `/usage` shows inside Claude Code, served
// from the Anthropic OAuth endpoint via the `claude_plan_limits` command.
//
// Everything else in the Usage tab is consumption computed from local files.
// This card is the only piece that knows how much of the *plan* is left, which
// is the number worth glancing at before starting a long session.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PlanLimits, PlanWindow } from "../../types";
import { planPace, type PlanPace, type PlanWindowKey } from "./planPace";
import { validateSchedule, type UsageSchedule } from "./usageSchedule";
import { planStaleView } from "./planStale";

/// `last_error` llega del backend solo con `stale = true`; el tipo compartido
/// de `types/usage.ts` todavía no lo declara.
type PlanLimitsPayload = PlanLimits & { last_error?: string | null };

const POLL_MS = 60_000;

/// "1 h 12 min", "4 min", "3 d 2 h" — a countdown reads better than an ISO
/// instant when the only question is "how long until this frees up".
function untilReset(iso: string | null): string | null {
  if (!iso) return null;
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return null;
  const diffMs = target - Date.now();
  if (diffMs <= 0) return "ya";
  const mins = Math.round(diffMs / 60_000);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const restMins = mins % 60;
  if (hours < 24) return restMins > 0 ? `${hours} h ${restMins} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours > 0 ? `${days} d ${restHours} h` : `${days} d`;
}

const RESET_FMT = new Intl.DateTimeFormat("es-ES", {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/// The bar colour follows the alert, not only the raw percentage: the 5 h cap
/// alerts at 25 % used, so a 42 % bar must not look calm.
function barColor(percent: number, pace: PlanPace | null): string {
  if (percent >= 90 || pace?.alert) return "var(--color-danger, #e5484d)";
  if (percent >= 70 || pace?.over) return "var(--color-warning, #ffb224)";
  return "var(--color-accent)";
}

/// Vertical tick on the bar: the share of the window already elapsed (or of the
/// expected use, weekly with a schedule). Past the tick means over the pace.
function gaugeMarker(pace: PlanPace | null): { pct: number; label: string } | null {
  if (!pace) return null;
  return {
    pct: Math.min(100, Math.max(0, pace.elapsedPct)),
    label: pace.scheduled
      ? `Uso esperado hasta ahora según tu horario: ${Math.round(pace.elapsedPct)} % (tiempo transcurrido: ${Math.round(pace.linearElapsedPct)} %)`
      : `Ventana transcurrida: ${Math.round(pace.elapsedPct)} %`,
  };
}

function Gauge({
  title,
  windowKey,
  window: w,
  emphasized = false,
  schedule = null,
}: {
  title: string;
  windowKey: PlanWindowKey;
  window: PlanWindow;
  emphasized?: boolean;
  schedule?: UsageSchedule | null;
}) {
  const pct = Math.min(100, Math.max(0, w.utilization));
  const reset = untilReset(w.resets_at);
  const resetDate = w.resets_at ? new Date(w.resets_at) : null;
  const pace = planPace(windowKey, w.utilization, w.resets_at, Date.now(), schedule);
  const marker = gaugeMarker(pace);
  const signalColor = pace?.alert ? "var(--color-danger, #e5484d)" : "var(--color-text-tertiary)";
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
          <span
            className="text-[10px]"
            style={{ color: "var(--color-text-faint)" }}
            title={resetDate && !Number.isNaN(resetDate.getTime()) ? `Se reinicia el ${RESET_FMT.format(resetDate)}` : undefined}
          >
            {reset === "ya" ? "se reinicia ya" : `se reinicia en ${reset}`}
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
        {pace && (
          <span
            className="ml-auto text-[11px] tabular-nums"
            style={{ color: signalColor }}
            title={
              pace.scheduled
                ? `${Math.round(pace.elapsedPct)} % del uso esperado hasta ahora según tu horario (el tiempo va por el ${Math.round(pace.linearElapsedPct)} %). 100 % = el ritmo que agota la cuota justo al reiniciarse.`
                : `${Math.round(pace.elapsedPct)} % de la ventana transcurrido. 100 % = el ritmo que agota la cuota justo al reiniciarse.`
            }
          >
            ritmo {Number.isFinite(pace.projectedPct) ? `${Math.round(pace.projectedPct)} %` : "∞"}
          </span>
        )}
      </div>
      {pace?.alert && (
        <div
          className="mt-2 text-[11px] font-semibold uppercase tracking-[0.06em]"
          style={{ color: "var(--color-danger, #e5484d)" }}
        >
          Reduce el uso · por encima del ritmo
        </div>
      )}
      <div
        className="relative mt-3 h-2 w-full rounded-full"
        style={{ background: "var(--color-surface-1, rgba(127,127,127,0.18))" }}
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={title}
      >
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${pct}%`, background: barColor(pct, pace) }}
        />
        {marker && (
          <div
            className="absolute -top-1 -bottom-1 w-0.5 rounded-full"
            style={{ left: `calc(${marker.pct}% - 1px)`, background: "var(--color-text-secondary)" }}
            title={marker.label}
            aria-hidden
          />
        )}
      </div>
    </div>
  );
}

/// `refreshKey` lets the Usage header drive a forced reload (one Refresh
/// button for the whole tab); 0 means "no manual refresh yet".
export function PlanLimitsCard({ refreshKey = 0 }: { refreshKey?: number }) {
  const [data, setData] = useState<PlanLimitsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Horario de uso (cockpit/usage-schedule.json): pondera el ritmo semanal. Sin
  // fichero queda en null y el ritmo es lineal. Si existe pero es invalido (JSON
  // roto o reglas incumplidas) el ritmo tambien es lineal, pero la tarjeta lo
  // dice: «horario inválido: <motivo>».
  const [schedule, setSchedule] = useState<UsageSchedule | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke("usage_schedule_get")
      .then((raw) => {
        if (cancelled) return;
        if (raw === null || raw === undefined) {
          setSchedule(null);
          setScheduleError(null);
          return;
        }
        const { schedule: valid, error: invalidReason } = validateSchedule(raw);
        setSchedule(valid);
        setScheduleError(invalidReason);
      })
      .catch((e) => {
        if (cancelled) return;
        setSchedule(null);
        setScheduleError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async (force = false) => {
    try {
      const r = (await invoke("claude_plan_limits", { force })) as PlanLimitsPayload;
      setData(r);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // Only a key that changes while mounted is a manual refresh; remounting
  // after switching tabs must not force another round-trip.
  const seenRefreshKey = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey === seenRefreshKey.current) return;
    seenRefreshKey.current = refreshKey;
    void load(true);
  }, [refreshKey, load]);

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

  const staleView = planStaleView(data, error, Date.now());
  const staleColor =
    staleView?.kind === "auth" ? "var(--color-danger, #e5484d)" : "var(--color-warning, #ffb224)";

  // Per-model caps (e.g. Fable) only matter when one actually exists.
  const scoped = (data?.limits ?? []).filter((l) => l.scope_label && l.percent > 0);

  return (
    <div
      className="mb-6 rounded p-4"
      style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
    >
      <header className="mb-3 flex items-baseline justify-between gap-4">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[13px] font-semibold">Límites del plan</h2>
          {data?.subscription_type && (
            <span
              className="rounded px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-[0.06em]"
              style={{ background: "var(--color-surface-3)", color: "var(--color-text-tertiary)" }}
            >
              {data.subscription_type}
            </span>
          )}
          {staleView && (
            <span className="text-[10px]" style={{ color: staleColor }} title={staleView.detail ?? undefined}>
              {staleView.label}
              {staleView.age ? ` · actualizado ${staleView.age}` : ""}
            </span>
          )}
        </div>
      </header>

      {staleView && (staleView.detail || staleView.hint) && (
        <div
          className="mb-3 rounded px-2 py-1.5 text-[11.5px]"
          role="status"
          style={{ background: `color-mix(in srgb, ${staleColor} 10%, transparent)`, color: staleColor }}
        >
          {staleView.detail && <div className="break-words">Falló la última consulta en vivo: {staleView.detail}</div>}
          {staleView.hint && <div className="mt-0.5">{staleView.hint}</div>}
        </div>
      )}

      {scheduleError && (
        <p
          className="mb-3 break-words text-[11.5px]"
          role="status"
          style={{ color: "var(--color-warning, #ffb224)" }}
          title="El ritmo semanal se calcula lineal hasta que se corrija cockpit/usage-schedule.json"
        >
          horario inválido: {scheduleError}
        </p>
      )}

      {error && !data && (
        <p className="text-[12px]" style={{ color: "var(--color-danger, #e5484d)" }}>
          {error}
        </p>
      )}

      {!error && !data && (
        <p className="text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
          Cargando…
        </p>
      )}

      {data && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {data.five_hour && <Gauge title="Ventana de 5 h" windowKey="five_hour" window={data.five_hour} emphasized />}
            {data.seven_day && <Gauge title="Semanal" windowKey="seven_day" window={data.seven_day} schedule={schedule} />}
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
                Desglose semanal
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
