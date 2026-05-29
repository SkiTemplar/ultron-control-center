import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  DailyPoint,
  ModelStat,
  ProviderUsageRow,
  RouterUsageSummary,
  UsageReport,
  WindowStats,
} from "../types";
import { RouterMetrics } from "./AIRouter/RouterMetrics";

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatNum(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

function shortModel(m: string): string {
  return m
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-/g, " ");
}

// ---------------------------------------------------------------------------
// Weekly reset countdown — Friday 03:00 local time
// ---------------------------------------------------------------------------

// Reset config persisted in localStorage so the user can adjust if the
// Anthropic plan rolls over a different time/day.
type ResetConfig = { weekday: number; hour: number; minute: number };
const RESET_KEY = "ultron.cc.weekly_reset.v1";
const DEFAULT_RESET: ResetConfig = { weekday: 5, hour: 3, minute: 0 }; // Fri 03:00
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function loadResetConfig(): ResetConfig {
  try {
    const raw = localStorage.getItem(RESET_KEY);
    if (!raw) return DEFAULT_RESET;
    const parsed = JSON.parse(raw) as Partial<ResetConfig>;
    return {
      weekday: typeof parsed.weekday === "number" ? parsed.weekday : DEFAULT_RESET.weekday,
      hour: typeof parsed.hour === "number" ? parsed.hour : DEFAULT_RESET.hour,
      minute: typeof parsed.minute === "number" ? parsed.minute : DEFAULT_RESET.minute,
    };
  } catch {
    return DEFAULT_RESET;
  }
}
function saveResetConfig(c: ResetConfig) {
  try {
    localStorage.setItem(RESET_KEY, JSON.stringify(c));
  } catch {}
}

function nextWeeklyReset(cfg: ResetConfig, now: Date = new Date()): Date {
  const target = new Date(now);
  target.setHours(cfg.hour, cfg.minute, 0, 0);
  const dow = target.getDay();
  let daysUntil = (cfg.weekday - dow + 7) % 7;
  if (daysUntil === 0 && now.getTime() >= target.getTime()) {
    daysUntil = 7;
  }
  target.setDate(target.getDate() + daysUntil);
  return target;
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return "now";
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function WeeklyResetCard() {
  const [nowMs, setNowMs] = useState(Date.now());
  const [cfg, setCfg] = useState<ResetConfig>(() => loadResetConfig());
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => saveResetConfig(cfg), [cfg]);

  const target = nextWeeklyReset(cfg, new Date(nowMs));
  const remaining = target.getTime() - nowMs;
  // Percentage of the weekly window already CONSUMED — 0% at the moment of
  // the last reset, 100% when the next reset fires. The semantic for the
  // user is "cuánto llevo de la semana", not lo que queda.
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const pctElapsed = Math.max(0, Math.min(100, ((WEEK_MS - remaining) / WEEK_MS) * 100));
  const targetLabel = target.toLocaleString(undefined, {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

  const hint = `${WEEKDAY_LABELS[cfg.weekday].toLowerCase()} ${String(cfg.hour).padStart(2, "0")}:${String(cfg.minute).padStart(2, "0")}`;

  return (
    <div
      className="rounded p-4"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div className="flex items-baseline justify-between">
        <div
          className="text-[10px] font-medium uppercase tracking-[0.06em]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Weekly reset
        </div>
        <button
          type="button"
          onClick={() => setEditing(!editing)}
          className="text-[10px] transition-colors"
          style={{ color: "var(--color-text-faint)" }}
          title="Configure reset day/time"
        >
          {hint} (edit)
        </button>
      </div>
      <div className="mt-2 flex items-baseline justify-between gap-3">
        <div className="text-[22px] font-semibold tabular-nums leading-tight">
          {formatCountdown(remaining)}
        </div>
        <div
          className="text-[12.5px] font-semibold tabular-nums"
          style={{ color: "var(--color-text-secondary)" }}
          title="Percentage of the weekly window already consumed"
        >
          {pctElapsed.toFixed(1)}%
        </div>
      </div>
      {/* Progress strip — fills as the week elapses. Verde al inicio,
       * ámbar a mitad/dos tercios, rojo cuando queda poco margen. */}
      <div
        className="mt-2 h-1 w-full overflow-hidden rounded-full"
        style={{ background: "var(--color-surface-3)" }}
      >
        <div
          className="h-full rounded-full transition-all"
          style={{
            width: `${pctElapsed}%`,
            background:
              pctElapsed > 85
                ? "var(--color-danger)"
                : pctElapsed > 65
                  ? "var(--color-warn)"
                  : "var(--color-success)",
          }}
        />
      </div>
      <div className="mt-2 text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
        until {targetLabel}
      </div>

      {editing && (
        <div
          className="mt-3 rounded p-2.5"
          style={{
            background: "var(--color-surface-1)",
            border: "1px solid var(--color-border)",
          }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <label
              className="text-[10px] uppercase tracking-wide"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Day
            </label>
            <select
              value={cfg.weekday}
              onChange={(e) =>
                setCfg({ ...cfg, weekday: parseInt(e.target.value, 10) })
              }
              className="rounded px-1.5 py-0.5 text-[11.5px]"
              style={{
                background: "var(--color-surface-2)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
              }}
            >
              {WEEKDAY_LABELS.map((l, i) => (
                <option key={i} value={i}>
                  {l}
                </option>
              ))}
            </select>
            <label
              className="text-[10px] uppercase tracking-wide"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Hour
            </label>
            <input
              type="number"
              min={0}
              max={23}
              value={cfg.hour}
              onChange={(e) =>
                setCfg({
                  ...cfg,
                  hour: Math.max(0, Math.min(23, parseInt(e.target.value, 10) || 0)),
                })
              }
              className="w-12 rounded px-1.5 py-0.5 text-[11.5px] tabular-nums"
              style={{
                background: "var(--color-surface-2)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
                outline: "none",
              }}
            />
            <span style={{ color: "var(--color-text-tertiary)" }}>:</span>
            <input
              type="number"
              min={0}
              max={59}
              value={cfg.minute}
              onChange={(e) =>
                setCfg({
                  ...cfg,
                  minute: Math.max(0, Math.min(59, parseInt(e.target.value, 10) || 0)),
                })
              }
              className="w-12 rounded px-1.5 py-0.5 text-[11.5px] tabular-nums"
              style={{
                background: "var(--color-surface-2)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
                outline: "none",
              }}
            />
            <button
              type="button"
              onClick={() => setCfg(DEFAULT_RESET)}
              className="ml-auto text-[10px]"
              style={{ color: "var(--color-text-tertiary)" }}
              title="Reset to Fri 03:00"
            >
              default
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="text-[10px]"
              style={{ color: "var(--color-text-secondary)" }}
            >
              done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Window card (today / 7d / 30d)
// ---------------------------------------------------------------------------

function WindowCard({
  title,
  hint,
  w,
  emphasized = false,
}: {
  title: string;
  hint: string;
  w: WindowStats;
  emphasized?: boolean;
}) {
  return (
    <div
      className="rounded p-4"
      style={{
        background: emphasized ? "var(--color-surface-3)" : "var(--color-surface-2)",
        border: `1px solid ${
          emphasized ? "var(--color-border-strong)" : "var(--color-border)"
        }`,
      }}
    >
      <div className="flex items-baseline justify-between">
        <div
          className="text-[10px] font-medium uppercase tracking-[0.06em]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {title}
        </div>
        <span className="text-[10px]" style={{ color: "var(--color-text-faint)" }}>
          {hint}
        </span>
      </div>
      <div className="mt-2 text-[22px] font-semibold tabular-nums leading-tight">
        {formatNum(w.tokens_total)}
        <span
          className="ml-1 text-[11.5px] font-normal"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          tokens
        </span>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-[11.5px]">
        <Stat label="Messages" value={w.messages} />
        <Stat label="Sessions" value={w.sessions} />
        <Stat label="Tool calls" value={w.tool_calls} />
      </div>
      {Object.keys(w.tokens_by_model).length > 0 && (
        <div className="mt-3 space-y-1">
          {Object.entries(w.tokens_by_model)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([m, v]) => (
              <div
                key={m}
                className="flex items-baseline justify-between text-[11.5px]"
              >
                <span style={{ color: "var(--color-text-tertiary)" }}>
                  {shortModel(m)}
                </span>
                <span
                  className="tabular-nums"
                  style={{ color: "var(--color-text-secondary)" }}
                >
                  {formatNum(v)}
                </span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-[9px]" style={{ color: "var(--color-text-faint)" }}>
        {label}
      </div>
      <div
        className="tabular-nums"
        style={{ color: "var(--color-text)", fontWeight: 500 }}
      >
        {value.toLocaleString()}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bar chart (last 14 days)
// ---------------------------------------------------------------------------

function DailyBars({ data }: { data: DailyPoint[] }) {
  const max = Math.max(1, ...data.map((d) => d.tokens));
  return (
    <div className="mt-2 flex items-end gap-1.5" style={{ height: 96 }}>
      {data.map((d) => {
        const h = max > 0 ? Math.max(2, (d.tokens / max) * 96) : 2;
        const hasData = d.tokens > 0 || d.messages > 0;
        return (
          <div
            key={d.date}
            className="group relative flex-1"
            style={{ minWidth: 12 }}
            title={`${d.date} · ${formatNum(d.tokens)} tokens · ${d.messages} msgs`}
          >
            <div
              className="rounded-t"
              style={{
                height: `${h}px`,
                background: hasData
                  ? "var(--color-accent)"
                  : "var(--color-surface-3)",
                opacity: hasData ? 0.85 : 0.5,
              }}
            />
            <div
              className="mt-1 text-center text-[9px] tabular-nums"
              style={{ color: "var(--color-text-faint)" }}
            >
              {d.date.slice(5)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model totals table
// ---------------------------------------------------------------------------

function ModelTable({ models }: { models: ModelStat[] }) {
  return (
    <div className="space-y-1">
      {models.map((m) => (
        <div
          key={m.name}
          className="rounded p-3"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
          }}
        >
          <div className="flex items-baseline justify-between">
            <span
              className="text-[12.5px] font-medium"
              style={{ color: "var(--color-text)" }}
            >
              {shortModel(m.name)}
            </span>
            <span
              className="tabular-nums text-[12.5px] font-semibold"
              style={{ color: "var(--color-text)" }}
            >
              {formatNum(m.total)}
            </span>
          </div>
          <div className="mt-2 grid grid-cols-4 gap-3 text-[10.5px]">
            <ModelStatCell label="Input" value={m.input_tokens} />
            <ModelStatCell label="Output" value={m.output_tokens} />
            <ModelStatCell label="Cache read" value={m.cache_read} />
            <ModelStatCell label="Cache create" value={m.cache_create} />
          </div>
        </div>
      ))}
    </div>
  );
}

function ModelStatCell({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div style={{ color: "var(--color-text-faint)" }}>{label}</div>
      <div
        className="tabular-nums"
        style={{ color: "var(--color-text-secondary)" }}
      >
        {formatNum(value)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hour histogram (24 buckets)
// ---------------------------------------------------------------------------

function HourHisto({ counts }: { counts: number[] }) {
  const max = Math.max(1, ...counts);
  return (
    <div className="mt-2 flex items-end gap-px" style={{ height: 48 }}>
      {counts.map((c, h) => {
        const height = (c / max) * 48;
        return (
          <div
            key={h}
            className="flex-1"
            title={`${String(h).padStart(2, "0")}:00 · ${c} sessions`}
            style={{
              height: `${Math.max(2, height)}px`,
              background: c > 0 ? "var(--color-accent)" : "var(--color-surface-3)",
              opacity: c > 0 ? 0.7 : 0.3,
              borderRadius: 1,
            }}
          />
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subscription limit shortcut — one click opens a Claude terminal with
// /usage pre-loaded so the user sees the real 5h window and weekly %.
// ---------------------------------------------------------------------------

function SubscriptionLimitCard({ onOpen, busy }: { onOpen: () => void; busy: boolean }) {
  return (
    <div
      className="mb-6 flex items-center justify-between gap-4 rounded p-4"
      style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
    >
      <div>
        <div
          className="text-[10px] font-medium uppercase tracking-[0.06em]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Límite de suscripción
        </div>
        <p className="mt-1 text-[12.5px]" style={{ color: "var(--color-text-secondary)" }}>
          Abre una sesión Claude con{" "}
          <span style={{ fontFamily: "var(--font-mono, monospace)" }}>/usage</span>{" "}
          para ver el % restante de tu ventana de 5h y uso semanal.
        </p>
      </div>
      <button
        type="button"
        onClick={onOpen}
        disabled={busy}
        className="shrink-0 rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
        style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
      >
        {busy ? "Abriendo…" : "Abrir /usage"}
      </button>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Quota Status Card (P0 2026-05-27 — 98% auto-fallback)
// ---------------------------------------------------------------------------

type QuotaStatus = {
  claude_pct_used: number;
  claude_critical: boolean;
  reset_at: string | null;
  last_check: string;
};

function useQuotaStatus() {
  const [status, setStatus] = useState<QuotaStatus | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = (await invoke("quota_get_status")) as QuotaStatus;
      setStatus(s);
    } catch {
      // Watchdog not registered yet.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    let u1: (() => void) | null = null;
    let u2: (() => void) | null = null;
    let u3: (() => void) | null = null;

    import("@tauri-apps/api/event").then(({ listen }) => {
      listen<QuotaStatus>("quota:updated", (e) => setStatus(e.payload)).then(
        (u) => { u1 = u; }
      );
      listen<QuotaStatus>("quota:critical", (e) => setStatus(e.payload)).then(
        (u) => { u2 = u; }
      );
      listen<QuotaStatus>("quota:reset", (e) => setStatus(e.payload)).then(
        (u) => { u3 = u; }
      );
    });

    return () => { u1?.(); u2?.(); u3?.(); };
  }, []);

  return { status, refresh };
}

function QuotaGauge({ pct, critical }: { pct: number; critical: boolean }) {
  const color = critical
    ? "var(--color-danger)"
    : pct >= 80
      ? "var(--color-warn)"
      : "var(--color-success)";
  return (
    <div
      className="mt-2 h-2 w-full overflow-hidden rounded-full"
      style={{ background: "var(--color-surface-3)" }}
      title={`${pct.toFixed(1)}% used`}
    >
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{ width: `${Math.min(100, pct)}%`, background: color }}
      />
    </div>
  );
}

function QuotaStatusCard() {
  const { status, refresh } = useQuotaStatus();
  const [simBusy, setSimBusy] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);

  async function handleForceReset() {
    setResetBusy(true);
    try {
      await invoke("quota_force_reset");
      await refresh();
    } finally {
      setResetBusy(false);
    }
  }

  async function handleSimulate(pct: number) {
    setSimBusy(true);
    try {
      await invoke("quota_simulate_critical", { pct });
      await refresh();
    } finally {
      setSimBusy(false);
    }
  }

  const pct = status?.claude_pct_used ?? 0;
  const critical = status?.claude_critical ?? false;
  const resetAt = status?.reset_at ? new Date(status.reset_at) : null;

  const statusColor = critical
    ? "var(--color-danger)"
    : pct >= 80
      ? "var(--color-warn)"
      : "var(--color-success)";

  const statusLabel = critical
    ? "CRITICAL — fallback activo"
    : pct >= 80
      ? "Advertencia"
      : "Normal";

  const resetLabel = resetAt
    ? resetAt.toLocaleString(undefined, {
        weekday: "short",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  return (
    <div
      className="mb-6 rounded p-4"
      style={{
        background: critical ? "rgba(248,81,73,0.06)" : "var(--color-surface-2)",
        border: critical
          ? "1px solid rgba(248,81,73,0.35)"
          : "1px solid var(--color-border)",
      }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div
          className="text-[10px] font-medium uppercase tracking-[0.06em]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Quota Claude (suscripción)
        </div>
        <span className="text-[10px] font-semibold" style={{ color: statusColor }}>
          {statusLabel}
        </span>
      </div>

      <div className="mt-2 flex items-baseline justify-between gap-3">
        <div
          className="text-[22px] font-semibold tabular-nums leading-tight"
          style={{ color: statusColor }}
        >
          {pct.toFixed(1)}
          <span
            className="ml-0.5 text-[13px] font-normal"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            %
          </span>
        </div>
        {resetLabel && (
          <div className="text-right text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
            <div className="text-[9px] uppercase tracking-wide">Reset</div>
            {resetLabel}
          </div>
        )}
      </div>

      <QuotaGauge pct={pct} critical={critical} />

      {critical && (
        <div
          className="mt-3 rounded p-2.5 text-[11.5px]"
          style={{
            background: "rgba(248,81,73,0.08)",
            border: "1px solid rgba(248,81,73,0.2)",
            color: "var(--color-danger)",
          }}
        >
          AI Router saltando proveedores Claude. Usando fallbacks (Groq / DeepSeek
          / Gemini / Ollama). Cuando los tokens se renueven pulsa «Reset manual»
          o espera el ciclo automático (60 s).
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {critical && (
          <button
            type="button"
            onClick={handleForceReset}
            disabled={resetBusy}
            className="rounded px-3 py-1 text-[11px] font-medium transition-colors disabled:opacity-50"
            style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
          >
            {resetBusy ? "Reseteando…" : "Reset manual"}
          </button>
        )}
        <button
          type="button"
          onClick={() => void handleSimulate(99.0)}
          disabled={simBusy}
          className="rounded px-2.5 py-1 text-[10.5px] transition-colors disabled:opacity-50"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text-faint)",
            border: "1px solid var(--color-border)",
          }}
          title="Simular estado crítico (testing)"
        >
          Sim 99%
        </button>
        <button
          type="button"
          onClick={() => void handleSimulate(10.0)}
          disabled={simBusy}
          className="rounded px-2.5 py-1 text-[10.5px] transition-colors disabled:opacity-50"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text-faint)",
            border: "1px solid var(--color-border)",
          }}
          title="Limpiar simulación"
        >
          Sim 10%
        </button>
        <span
          className="ml-auto text-[9.5px] tabular-nums"
          style={{ color: "var(--color-text-faint)" }}
        >
          {status ? new Date(status.last_check).toLocaleTimeString() : "—"}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI Router — Fallback-rate gauge
// ---------------------------------------------------------------------------

function FallbackRateGauge({ rate }: { rate: number }) {
  const pct = Math.max(0, Math.min(100, rate * 100));
  const color =
    pct > 50
      ? "var(--color-danger)"
      : pct > 20
        ? "var(--color-warn)"
        : "var(--color-success)";
  const label =
    pct > 50 ? "High fallback rate" : pct > 20 ? "Moderate" : "Healthy";

  return (
    <div
      className="rounded p-4"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div className="flex items-baseline justify-between">
        <div
          className="text-[10px] font-medium uppercase tracking-[0.06em]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Global fallback rate
        </div>
        <span
          className="text-[10px] font-semibold tabular-nums"
          style={{ color }}
        >
          {pct.toFixed(1)}% — {label}
        </span>
      </div>
      <div
        className="mt-2 h-2 w-full overflow-hidden rounded-full"
        style={{ background: "var(--color-surface-3)" }}
      >
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      <p
        className="mt-1.5 text-[10.5px]"
        style={{ color: "var(--color-text-faint)" }}
      >
        EMA(0.1) across all route() calls since last metrics reset. Green &lt;
        20%, amber 20–50%, red &gt; 50%.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI Router — Provider row
// ---------------------------------------------------------------------------

function ZoneChip({
  zone,
  variant,
}: {
  zone: string;
  variant: "primary" | "fallback";
}) {
  const bg =
    variant === "primary"
      ? "rgba(46,160,67,0.15)"
      : "rgba(130,80,255,0.15)";
  const border =
    variant === "primary"
      ? "rgba(46,160,67,0.35)"
      : "rgba(130,80,255,0.35)";
  const textColor =
    variant === "primary" ? "#3fb950" : "#a78bfa";

  return (
    <span
      className="inline-block rounded px-1.5 py-0.5 text-[9.5px] font-medium leading-none"
      style={{ background: bg, border: `1px solid ${border}`, color: textColor }}
      title={variant === "primary" ? "Primary provider for this zone" : "Fallback provider for this zone"}
    >
      {zone}
    </span>
  );
}

function KeyBadge({
  present,
  masked,
  source,
}: {
  present: boolean;
  masked: string | null;
  /** Optional: drives CLI-specific badge text. Absent for legacy rows. */
  source?: string;
}) {
  // --- CLI providers: binary-presence badge instead of API-key badge ---
  if (source === "cli-installed") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9.5px] font-medium leading-none"
        style={{
          background: "rgba(46,160,67,0.12)",
          border: "1px solid rgba(46,160,67,0.3)",
          color: "#3fb950",
        }}
        title="CLI installed and available on PATH"
      >
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: "#3fb950" }}
        />
        CLI OK
      </span>
    );
  }
  if (source === "cli-missing") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9.5px] font-medium leading-none"
        style={{
          background: "rgba(248,81,73,0.10)",
          border: "1px solid rgba(248,81,73,0.28)",
          color: "#f85149",
          fontFamily: "var(--font-mono, monospace)",
        }}
        title="CLI not found on PATH — install and run auth"
      >
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: "#f85149" }}
        />
        CLI missing
      </span>
    );
  }

  // --- Cloud providers: API-key badge ---
  if (present && masked) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9.5px] font-medium leading-none"
        style={{
          background: "rgba(46,160,67,0.12)",
          border: "1px solid rgba(46,160,67,0.3)",
          color: "#3fb950",
          fontFamily: "var(--font-mono, monospace)",
        }}
        title="API key present"
      >
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: "#3fb950" }}
        />
        {masked}
      </span>
    );
  }
  if (present) {
    // Local provider (no key needed)
    return (
      <span
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9.5px] font-medium leading-none"
        style={{
          background: "rgba(46,160,67,0.12)",
          border: "1px solid rgba(46,160,67,0.3)",
          color: "#3fb950",
        }}
      >
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: "#3fb950" }}
        />
        local
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9.5px] font-medium leading-none"
      style={{
        background: "rgba(200,200,200,0.08)",
        border: "1px solid rgba(200,200,200,0.2)",
        color: "var(--color-text-faint)",
        fontFamily: "var(--font-mono, monospace)",
      }}
      title="API key missing or placeholder"
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ background: "var(--color-text-faint)" }}
      />
      missing
    </span>
  );
}

// Free-tier gauge: % del gratuito consumido HOY. Sólo se muestra cuando el
// proveedor tiene un free tier conocido (Gemini, Groq). El usuario pidió ver
// "el % que llevo del gratuito" en vez de sólo el nombre de la key.
function FreeTierBadge({ p }: { p: ProviderUsageRow }) {
  if (p.free_tier_limit == null || p.free_tier_pct == null) return null;
  const pct = Math.max(0, p.free_tier_pct);
  const color =
    pct >= 90
      ? "var(--color-danger)"
      : pct >= 70
        ? "var(--color-warn)"
        : "var(--color-success)";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-[10px] font-medium leading-none"
      style={{
        background: "var(--color-surface-3)",
        border: "1px solid var(--color-border)",
        color: "var(--color-text-secondary)",
      }}
      title={`Free tier (hoy, UTC): ${p.free_tier_used_today} / ${p.free_tier_limit} req aprox. Límite publicado, puede variar.`}
    >
      <span
        className="inline-block h-1.5 w-14 overflow-hidden rounded-full"
        style={{ background: "var(--color-surface-1)" }}
      >
        <span
          className="block h-full rounded-full"
          style={{ width: `${Math.min(100, pct)}%`, background: color }}
        />
      </span>
      <span className="tabular-nums" style={{ color }}>
        {pct.toFixed(0)}%
      </span>
      <span style={{ color: "var(--color-text-faint)" }}>gratuito</span>
    </span>
  );
}

function ProviderRow({ p }: { p: ProviderUsageRow }) {
  return (
    <div
      className="rounded p-3"
      style={{
        background: "var(--color-surface-2)",
        border: p.key_present
          ? "1px solid var(--color-border)"
          : "1px solid rgba(248,81,73,0.18)",
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* Left: label + key badge */}
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="text-[12.5px] font-medium"
            style={{ color: "var(--color-text)" }}
          >
            {p.provider_label}
          </span>
          <KeyBadge
            present={p.key_present}
            masked={p.key_masked}
            source={
              // CLI providers have no key_env_var and their id ends in "-cli".
              // Derive the badge source without a second API call.
              p.key_env_var === "" && p.provider_id.endsWith("-cli")
                ? p.key_present
                  ? "cli-installed"
                  : "cli-missing"
                : undefined
            }
          />
          <FreeTierBadge p={p} />
          {p.key_env_var && (
            <span
              className="text-[9.5px]"
              style={{
                color: "var(--color-text-faint)",
                fontFamily: "var(--font-mono, monospace)",
              }}
            >
              {p.key_env_var}
            </span>
          )}
        </div>
        {/* Right: calls + success + tokens + latency (stats reales) */}
        <div className="flex items-baseline gap-3 text-[11.5px] tabular-nums">
          <div className="text-right">
            <div className="text-[9px] uppercase" style={{ color: "var(--color-text-faint)" }}>
              Calls
            </div>
            <div style={{ color: "var(--color-text-secondary)" }}>
              {p.call_count.toLocaleString()}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[9px] uppercase" style={{ color: "var(--color-text-faint)" }}>
              Success
            </div>
            <div
              style={{
                color:
                  p.call_count === 0
                    ? "var(--color-text-faint)"
                    : p.success_count / p.call_count >= 0.95
                      ? "var(--color-success)"
                      : p.success_count / p.call_count >= 0.8
                        ? "var(--color-warn)"
                        : "var(--color-danger)",
              }}
            >
              {p.call_count > 0
                ? `${Math.round((p.success_count / p.call_count) * 100)}%`
                : "—"}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[9px] uppercase" style={{ color: "var(--color-text-faint)" }}>
              Tokens
            </div>
            <div style={{ color: "var(--color-text-secondary)" }}>
              {p.total_tokens > 0 ? formatNum(p.total_tokens) : "—"}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[9px] uppercase" style={{ color: "var(--color-text-faint)" }}>
              Avg latency
            </div>
            <div style={{ color: "var(--color-text-secondary)" }}>
              {p.latency_ms_avg > 0 ? `${p.latency_ms_avg} ms` : "—"}
            </div>
          </div>
        </div>
      </div>
      {/* Zone chips */}
      {(p.primary_for_zones.length > 0 || p.fallback_for_zones.length > 0) && (
        <div className="mt-2 flex flex-wrap gap-1">
          {p.primary_for_zones.map((z) => (
            <ZoneChip key={`p-${z}`} zone={z} variant="primary" />
          ))}
          {p.fallback_for_zones.map((z) => (
            <ZoneChip key={`f-${z}`} zone={z} variant="fallback" />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI Router — Per-zone pipeline visual
// ---------------------------------------------------------------------------

function ZonePipeline({
  zoneId,
  chain,
  providers,
}: {
  zoneId: string;
  chain: string[];
  providers: ProviderUsageRow[];
}) {
  const providerMap = new Map(providers.map((p) => [p.provider_id, p]));

  return (
    <div
      className="rounded p-3"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div
        className="mb-2 text-[10px] font-medium uppercase tracking-[0.06em]"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        {zoneId}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {chain.map((pid, idx) => {
          const row = providerMap.get(pid);
          const isOk = row?.key_present ?? false;
          const label = row?.provider_label ?? pid;
          return (
            <div key={pid} className="flex items-center gap-1.5">
              {idx > 0 && (
                <span
                  className="text-[10px]"
                  style={{ color: "var(--color-text-faint)" }}
                >
                  →
                </span>
              )}
              <span
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10.5px] font-medium leading-none"
                style={{
                  background: isOk
                    ? "rgba(46,160,67,0.1)"
                    : "rgba(248,81,73,0.08)",
                  border: isOk
                    ? "1px solid rgba(46,160,67,0.28)"
                    : "1px solid rgba(248,81,73,0.22)",
                  color: isOk ? "#3fb950" : "var(--color-danger)",
                }}
                title={isOk ? "Key present — ready" : "Key missing"}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{
                    background: isOk ? "#3fb950" : "var(--color-danger)",
                    flexShrink: 0,
                  }}
                />
                {label}
                {idx === 0 && (
                  <span
                    className="ml-0.5 text-[8.5px] opacity-60"
                    style={{ color: "inherit" }}
                  >
                    primary
                  </span>
                )}
              </span>
            </div>
          );
        })}
        {chain.length === 0 && (
          <span
            className="text-[10.5px]"
            style={{ color: "var(--color-text-faint)" }}
          >
            No providers configured
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab "Router" — provider keys + zone pipelines + fallback gauge
// (previously AiRouterSection, now its own tab)
// ---------------------------------------------------------------------------

function RouterTab() {
  const [summary, setSummary] = useState<RouterUsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = (await invoke("ai_router_usage_summary")) as RouterUsageSummary;
      setSummary(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  const zoneEntries = summary
    ? Object.entries(summary.zone_chains).sort(([a], [b]) => a.localeCompare(b))
    : [];

  return (
    <div>
      {/* ------------------------------------------------------------------ */}
      {/* RouterMetrics — token savings + class distribution (moved from     */}
      {/* Settings > AI Router > Metrics tab)                                */}
      {/* ------------------------------------------------------------------ */}
      <section className="mb-8">
        <div className="mb-3">
          <h2 className="text-[13px] font-semibold">AI Router — métricas</h2>
          <p
            className="mt-0.5 text-[10.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Tokens ahorrados, distribución por clase y tasa de fallback.
          </p>
        </div>
        <RouterMetrics />
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Provider keys + zone chains                                         */}
      {/* ------------------------------------------------------------------ */}
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-[13px] font-semibold">AI Router — provider keys</h2>
          <p
            className="mt-0.5 text-[10.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Live key status, call counts, and zone assignments. Auto-refreshes every 30s.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="shrink-0 rounded px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-50"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text-secondary)",
            border: "1px solid var(--color-border)",
          }}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div
          className="mb-3 flex items-center justify-between gap-4 rounded p-3 text-[12px]"
          style={{
            background: "rgba(248,81,73,0.06)",
            border: "1px solid rgba(248,81,73,0.22)",
            color: "var(--color-danger)",
          }}
        >
          <span>Failed to load AI Router summary: {error}</span>
          <button
            type="button"
            onClick={() => void load()}
            className="shrink-0 rounded px-2 py-0.5 text-[11px] font-medium"
            style={{
              background: "rgba(248,81,73,0.12)",
              border: "1px solid rgba(248,81,73,0.3)",
              color: "var(--color-danger)",
            }}
          >
            Retry
          </button>
        </div>
      )}

      {loading && !summary && !error && (
        <div
          className="rounded p-4 text-[12px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-faint)",
          }}
        >
          Loading provider data…
        </div>
      )}

      {summary && (
        <>
          <FallbackRateGauge rate={summary.fallback_rate} />

          {/* Only render providers that exist in the summary — safe for any
              subset of configured providers (Anthropic + Gemini + Groq only,
              no OpenAI / Ollama required). */}
          {summary.providers.length > 0 ? (
            <div className="mt-4 space-y-2">
              <h3
                className="mb-2 text-[10px] font-medium uppercase tracking-[0.06em]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                Providers ({summary.providers.length})
              </h3>
              {summary.providers.map((p) => (
                <ProviderRow key={p.provider_id} p={p} />
              ))}
            </div>
          ) : (
            <div
              className="mt-3 rounded p-3 text-[12px]"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text-faint)",
              }}
            >
              No providers configured in the AI Router registry.
            </div>
          )}

          {zoneEntries.length > 0 && (
            <div className="mt-4">
              <h3
                className="mb-2 text-[10px] font-medium uppercase tracking-[0.06em]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                Zone chains ({zoneEntries.length})
              </h3>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {zoneEntries.map(([zoneId, chain]) => (
                  <ZonePipeline
                    key={zoneId}
                    zoneId={zoneId}
                    chain={chain}
                    providers={summary.providers}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab "Overview" — Claude usage stats + quota
// ---------------------------------------------------------------------------

type OverviewTabProps = {
  data: UsageReport | null;
  onOpenUsage: () => void;
  usageBusy: boolean;
};

function OverviewTab({ data, onOpenUsage, usageBusy }: OverviewTabProps) {
  return (
    <div>
      <SubscriptionLimitCard onOpen={onOpenUsage} busy={usageBusy} />

      {/* Quota 98% auto-fallback status card (P0 2026-05-27) */}
      <QuotaStatusCard />

      {/* Cache freshness warning */}
      {data && data.cache_age_days !== null && data.cache_age_days > 1 && (
        <div
          className="mb-4 rounded p-3 text-[12px]"
          style={{
            background: "rgba(210, 153, 34, 0.05)",
            border: "1px solid rgba(210, 153, 34, 0.18)",
            color: "var(--color-warn)",
          }}
        >
          stats-cache.json was last computed {data.cache_age_days} days ago (
          {data.last_computed_date}). Claude Code refreshes it on session events
          and on /usage. Open <span style={{ fontFamily: "var(--font-mono)" }}>claude /usage</span>{" "}
          interactively to pull the latest weekly limit numbers from the server.
        </div>
      )}

      {data && (
        <>
          {/* All-time summary */}
          <div
            className="mb-4 flex flex-wrap items-baseline gap-4 rounded p-3"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
            }}
          >
            <div>
              <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--color-text-tertiary)" }}>
                Total sessions
              </div>
              <div
                className="text-[16px] font-semibold tabular-nums"
                style={{ color: "var(--color-text)" }}
              >
                {data.total_sessions.toLocaleString()}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--color-text-tertiary)" }}>
                Total messages
              </div>
              <div
                className="text-[16px] font-semibold tabular-nums"
                style={{ color: "var(--color-text)" }}
              >
                {data.total_messages.toLocaleString()}
              </div>
            </div>
            {data.first_session_date && (
              <div>
                <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--color-text-tertiary)" }}>
                  Since
                </div>
                <div
                  className="text-[12px] tabular-nums"
                  style={{ color: "var(--color-text-secondary)" }}
                >
                  {data.first_session_date.slice(0, 10)}
                </div>
              </div>
            )}
          </div>

          {/* Window cards + Weekly reset countdown */}
          <div className="grid grid-cols-4 gap-3">
            <WindowCard title="Today" hint="24h" w={data.today} />
            <WindowCard title="This week" hint="7 days" w={data.last_7_days} emphasized />
            <WindowCard title="30 days" hint="month" w={data.last_30_days} />
            <WeeklyResetCard />
          </div>

          {/* Daily bars */}
          {data.daily_recent.length > 0 && (
            <section
              className="mt-6 rounded p-4"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border)",
              }}
            >
              <div className="flex items-baseline justify-between">
                <h2 className="text-[13px] font-semibold">Daily tokens (14 days)</h2>
                <span
                  className="text-[10px]"
                  style={{ color: "var(--color-text-faint)" }}
                >
                  hover a bar for detail
                </span>
              </div>
              <DailyBars data={data.daily_recent} />
            </section>
          )}

          {/* Model totals */}
          {data.model_totals.length > 0 && (
            <section className="mt-6">
              <h2 className="mb-2 text-[13px] font-semibold">Model totals (all-time)</h2>
              <ModelTable models={data.model_totals} />
            </section>
          )}

          {/* Hour histogram */}
          {data.hour_counts.some((c) => c > 0) && (
            <section
              className="mt-6 rounded p-4"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border)",
              }}
            >
              <div className="flex items-baseline justify-between">
                <h2 className="text-[13px] font-semibold">Sessions by hour (UTC)</h2>
                <span
                  className="text-[10px]"
                  style={{ color: "var(--color-text-faint)" }}
                >
                  24h
                </span>
              </div>
              <HourHisto counts={data.hour_counts} />
              <div className="mt-1 flex justify-between text-[9px]" style={{ color: "var(--color-text-faint)" }}>
                <span>00</span>
                <span>06</span>
                <span>12</span>
                <span>18</span>
                <span>23</span>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Internal tab strip
// ---------------------------------------------------------------------------

type UsageTab = "overview" | "router";

const USAGE_TABS: { id: UsageTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "router", label: "AI Router" },
];

function UsageTabStrip({
  active,
  onChange,
}: {
  active: UsageTab;
  onChange: (t: UsageTab) => void;
}) {
  return (
    <div
      className="inline-flex rounded p-0.5"
      style={{
        background: "var(--color-surface-1)",
        border: "1px solid var(--color-border-strong)",
      }}
    >
      {USAGE_TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className="rounded px-4 py-1.5 text-[12px] font-medium transition-colors"
          style={{
            background: active === t.id ? "var(--color-surface-3)" : "transparent",
            color:
              active === t.id
                ? "var(--color-text)"
                : "var(--color-text-tertiary)",
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function Usage() {
  const [data, setData] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [usageBusy, setUsageBusy] = useState(false);
  const [activeTab, setActiveTab] = useState<UsageTab>("overview");

  async function load() {
    setLoading(true);
    try {
      const r = (await invoke("claude_usage")) as UsageReport;
      setData(r);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  // Spawns a Claude session in a Windows Terminal tab and seeds the prompt
  // with `/usage` so the user lands directly on the live usage dashboard.
  // The local stats-cache.json gets refreshed by Claude itself as a side
  // effect, so we reload our view too once the user comes back.
  async function openClaudeUsage() {
    setUsageBusy(true);
    setError(null);
    try {
      const { resolveAndSpawn } = await import("../lib/button-prompts");
      await resolveAndSpawn({
        key: "usage.refresh_with_claude",
        cwd: null,
      });
      // Give Claude a beat to refresh the cache before we reload.
      setTimeout(load, 4000);
    } catch (e) {
      setError(String(e));
    } finally {
      setUsageBusy(false);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    // Auto-refresh when the window gets focus — typical scenario: the user
    // came back from a Claude /usage terminal tab and expects the panel to
    // reflect whatever the session just wrote into stats-cache.json.
    const onFocus = () => {
      load();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  return (
    <div className="px-10 py-8">
      <header className="mb-6 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-semibold leading-tight">Usage</h1>
          <p
            className="mt-1 text-[13px]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Claude Code consumption · source: ~/.claude/stats-cache.json
          </p>
        </div>
        <div className="flex items-center gap-3">
          <UsageTabStrip active={activeTab} onChange={setActiveTab} />
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </header>

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

      {activeTab === "overview" && (
        <OverviewTab
          data={data}
          onOpenUsage={openClaudeUsage}
          usageBusy={usageBusy}
        />
      )}

      {activeTab === "router" && <RouterTab />}
    </div>
  );
}
