import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DailyPoint, ModelStat, UsageReport, WindowStats } from "../types";

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
          className="ml-1 text-[11px] font-normal"
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
                className="flex items-baseline justify-between text-[11px]"
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
// Main
// ---------------------------------------------------------------------------

export function Usage() {
  const [data, setData] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
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

          {/* Window cards */}
          <div className="grid grid-cols-3 gap-3">
            <WindowCard title="Today" hint="24h" w={data.today} />
            <WindowCard title="This week" hint="7 days" w={data.last_7_days} emphasized />
            <WindowCard title="30 days" hint="month" w={data.last_30_days} />
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
