import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ActivityTab } from "./usage/ActivityTab";
import type { UsageReport } from "../types";
import { DailyBars, HourHisto, ModelTable, WindowCard } from "./usage/StatParts";

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
// Main
// ---------------------------------------------------------------------------

export function Usage() {
  const [data, setData] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [usageBusy, setUsageBusy] = useState(false);
  // Wiring 2026-08-11 (audit 08-09 #43): pestaña Activity con el timeline de
  // actividad de todo el sistema (compute_activity_timeline).
  const [tab, setTab] = useState<"overview" | "activity">("overview");

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
            {tab === "overview"
              ? "Claude Code consumption · source: ~/.claude/stats-cache.json"
              : "System activity timeline · plans, doctor, routing, alerts, kanban"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <nav className="flex gap-1" role="tablist" aria-label="Usage sections">
            {(
              [
                ["overview", "Overview"],
                ["activity", "Activity"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className="rounded px-3 py-1.5 text-[12px] transition-colors"
                style={{
                  background: tab === id ? "var(--color-surface-3)" : "transparent",
                  color: tab === id ? "var(--color-text)" : "var(--color-text-secondary)",
                  border: `1px solid ${
                    tab === id ? "var(--color-border-strong)" : "transparent"
                  }`,
                }}
              >
                {label}
              </button>
            ))}
          </nav>
          {tab === "overview" && (
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
          )}
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

      {tab === "overview" && (
        <OverviewTab
          data={data}
          onOpenUsage={openClaudeUsage}
          usageBusy={usageBusy}
        />
      )}
      {tab === "activity" && <ActivityTab />}
    </div>
  );
}
