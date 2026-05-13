import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CmdResult, QdrantHealth, AlertEntry, ChangelogEntry, GlobalStatus } from "../types";
import { statusColor } from "../lib/status";

type Props = {
  qdrant: QdrantHealth | null;
  qdrantErr: string | null;
  alerts: AlertEntry[];
  changelog: ChangelogEntry[];
  globalStatus: GlobalStatus;
};

function formatRelative(iso?: string): string {
  if (!iso) return "—";
  const ts = new Date(iso);
  if (isNaN(ts.getTime())) return iso;
  const diff = Date.now() - ts.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function MetricCard({
  label,
  value,
  detail,
  statusDot,
  emphasis = "normal",
}: {
  label: string;
  value: string;
  detail?: string;
  statusDot?: GlobalStatus;
  emphasis?: "normal" | "warn" | "critical";
}) {
  const bg =
    emphasis === "critical"
      ? "rgba(248, 81, 73, 0.06)"
      : emphasis === "warn"
        ? "rgba(210, 153, 34, 0.05)"
        : "var(--color-surface-2)";
  const border =
    emphasis === "critical"
      ? "rgba(248, 81, 73, 0.22)"
      : emphasis === "warn"
        ? "rgba(210, 153, 34, 0.18)"
        : "var(--color-border)";
  const labelColor =
    emphasis === "critical"
      ? "var(--color-danger)"
      : emphasis === "warn"
        ? "var(--color-warn)"
        : "var(--color-text-tertiary)";

  return (
    <div
      className="rounded-md px-5 py-4 transition-colors"
      style={{
        background: bg,
        border: `1px solid ${border}`,
      }}
    >
      <div className="flex items-center justify-between">
        <div
          className="text-[11px] font-medium uppercase tracking-[0.06em]"
          style={{ color: labelColor }}
        >
          {label}
        </div>
        {statusDot && (
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: statusColor(statusDot) }}
          />
        )}
      </div>
      <div className="mt-1.5 text-[20px] font-semibold leading-tight tabular-nums">
        {value}
      </div>
      {detail && (
        <div className="mt-1 text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
          {detail}
        </div>
      )}
    </div>
  );
}

export function Dashboard({
  qdrant,
  qdrantErr,
  alerts,
  changelog,
  globalStatus,
}: Props) {
  const [statusOutput, setStatusOutput] = useState<CmdResult | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);

  async function runStatus() {
    setStatusLoading(true);
    try {
      const r = (await invoke("ultron_status")) as CmdResult;
      setStatusOutput(r);
    } catch (e) {
      setStatusOutput({
        success: false,
        stdout: "",
        stderr: String(e),
        exit_code: null,
      });
    } finally {
      setStatusLoading(false);
    }
  }

  const qdrantDot: GlobalStatus = !qdrant && !qdrantErr ? "loading" : qdrant?.status === "up" ? "ok" : "down";
  const alertsCritical = alerts.filter((a) => a.severity === "critical" || a.severity === "blocking").length;
  const alertsWarn = alerts.filter((a) => a.severity === "warn").length;
  const alertsActionable = alertsCritical + alertsWarn;
  const alertsEmphasis: "normal" | "warn" | "critical" =
    alertsCritical > 0 ? "critical" : alertsWarn > 0 ? "warn" : "normal";
  const alertsDot: GlobalStatus = alertsCritical > 0 ? "down" : alertsWarn > 0 ? "warn" : "ok";
  const lastChange = changelog[0];

  return (
    <div className="px-10 py-8">
      <header className="mb-8">
        <h1 className="text-[20px] font-semibold leading-tight">Dashboard</h1>
        <p className="mt-1 text-[13px]" style={{ color: "var(--color-text-secondary)" }}>
          System overview · Control Center v15.1
        </p>
      </header>

      <div className="grid grid-cols-4 gap-3">
        <MetricCard
          label="Qdrant"
          value={qdrant?.status ?? (qdrantErr ? "no signal" : "—")}
          detail={qdrant ? `${qdrant.elapsed_sec}s startup` : qdrantErr ?? "checking…"}
          statusDot={qdrantDot}
        />
        <MetricCard
          label="Alerts"
          value={String(alerts.length)}
          detail={
            alertsActionable === 0
              ? "all info"
              : `${alertsActionable} actionable · ${alertsCritical} critical`
          }
          statusDot={alertsDot}
          emphasis={alertsEmphasis}
        />
        <MetricCard
          label="MCPs"
          value="—"
          detail="phase 3"
        />
        <MetricCard
          label="Brain index"
          value="—"
          detail="phase 5"
        />
      </div>

      {/* Quick action: ultron status sidecar */}
      <section className="mt-8">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[14px] font-semibold">Quick check</h2>
          <button
            type="button"
            onClick={runStatus}
            disabled={statusLoading}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            {statusLoading ? "Running…" : "Run ultron status"}
          </button>
        </div>
        <p
          className="mt-1 text-[12px]"
          style={{ color: "var(--color-text-secondary)" }}
        >
          Invokes <span style={{ fontFamily: "var(--font-mono)" }}>ultron.ps1 status</span> via Tauri shell sidecar.
        </p>
        {statusOutput && (
          <pre
            className="mt-3 max-h-80 overflow-auto rounded p-3 text-[11.5px] leading-relaxed"
            style={{
              background: "var(--color-surface-1)",
              border: "1px solid var(--color-border)",
              fontFamily: "var(--font-mono)",
              color: "var(--color-text-secondary)",
              whiteSpace: "pre-wrap",
            }}
          >
            {statusOutput.stdout || statusOutput.stderr || "(no output)"}
            {statusOutput.exit_code !== null && (
              <div className="mt-3" style={{ color: "var(--color-text-tertiary)" }}>
                — exit {statusOutput.exit_code}
              </div>
            )}
          </pre>
        )}
      </section>

      {/* Recent changelog summary */}
      {lastChange && (
        <section className="mt-8">
          <h2 className="text-[14px] font-semibold">Latest change</h2>
          <div
            className="mt-2 rounded p-4"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
            }}
          >
            <div className="flex items-baseline gap-2">
              <span
                className="rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-secondary)",
                }}
              >
                {lastChange.type}
              </span>
              <span style={{ color: "var(--color-text-tertiary)" }} className="text-[11px]">
                {lastChange.scope}
              </span>
              <span style={{ color: "var(--color-text-tertiary)" }} className="ml-auto text-[11px]">
                {formatRelative(lastChange.ts)}
              </span>
            </div>
            <div className="mt-2 text-[13px] font-medium">{lastChange.title}</div>
          </div>
        </section>
      )}

      <div
        className="mt-12 text-[11px]"
        style={{ color: "var(--color-text-faint)" }}
      >
        Global status: {globalStatus}
      </div>
    </div>
  );
}
