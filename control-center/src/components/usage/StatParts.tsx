// usage/StatParts.tsx — componentes puros de presentación de la pestaña Usage
// (WindowCard, Stat, DailyBars, ModelTable, ModelStatCell, HourHisto).
// Extraídos de Usage.tsx (2026-08-16, límite 800 líneas): son presentación sin
// estado propio; Usage.tsx conserva el estado y la orquestación.
import type { DailyPoint, ModelStat, WindowStats } from "../../types";
import { formatNum, shortModel } from "./format";

export function WindowCard({
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

export function Stat({ label, value }: { label: string; value: number }) {
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

export function DailyBars({ data }: { data: DailyPoint[] }) {
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

export function ModelTable({ models }: { models: ModelStat[] }) {
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

export function ModelStatCell({ label, value }: { label: string; value: number }) {
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

export function HourHisto({ counts }: { counts: number[] }) {
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

