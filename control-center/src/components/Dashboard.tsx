import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  CmdResult,
  QdrantHealth,
  AlertEntry,
  ChangelogEntry,
  GlobalStatus,
  McpInfo,
  MemoryStatusInfo,
} from "../types";
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

function MiniStat({
  label,
  value,
  emphasis = "normal",
}: {
  label: string;
  value: string;
  emphasis?: "normal" | "warn" | "critical";
}) {
  const color =
    emphasis === "critical"
      ? "var(--color-danger)"
      : emphasis === "warn"
        ? "var(--color-warn)"
        : "var(--color-text)";
  return (
    <div
      className="rounded px-3 py-2"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div
        className="text-[10px] font-medium uppercase tracking-wide"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        {label}
      </div>
      <div
        className="mt-0.5 text-[14px] font-semibold tabular-nums leading-tight"
        style={{ color }}
      >
        {value}
      </div>
    </div>
  );
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

type DiagnoseResult = {
  success: boolean;
  report_json: string;
  stderr: string;
};

type AiDiagnoseResult = {
  success: boolean;
  analysis: string;
  stderr: string;
};

export function Dashboard({
  qdrant,
  qdrantErr,
  alerts,
  changelog,
  globalStatus,
}: Props) {
  const [statusOutput, setStatusOutput] = useState<CmdResult | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [mcps, setMcps] = useState<McpInfo[] | null>(null);
  const [memory, setMemory] = useState<MemoryStatusInfo | null>(null);
  const [diagReport, setDiagReport] = useState<DiagnoseResult | null>(null);
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagAi, setDiagAi] = useState<AiDiagnoseResult | null>(null);
  const [diagAiLoading, setDiagAiLoading] = useState(false);
  const [diagError, setDiagError] = useState<string | null>(null);

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

  async function runDiagnose() {
    setDiagLoading(true);
    setDiagError(null);
    setDiagAi(null);
    try {
      const r = (await invoke("run_diagnose", { hours: 24 })) as DiagnoseResult;
      setDiagReport(r);
      if (!r.success) setDiagError(r.stderr || "Diagnose returned no output");
    } catch (e) {
      setDiagError(String(e));
    } finally {
      setDiagLoading(false);
    }
  }

  async function askAi(provider: "claude" | "codex") {
    if (!diagReport?.report_json) return;
    setDiagAiLoading(true);
    setDiagError(null);
    try {
      const r = (await invoke("diagnose_with_ai", {
        reportJson: diagReport.report_json,
        provider,
      })) as AiDiagnoseResult;
      setDiagAi(r);
      if (!r.success) setDiagError(r.stderr);
    } catch (e) {
      setDiagError(String(e));
    } finally {
      setDiagAiLoading(false);
    }
  }

  function parsedReport(): {
    appCrashes?: number;
    unexpectedReboots?: number;
    sysErr?: number;
    appErr?: number;
    ramPct?: number;
    uptimeHours?: number;
  } {
    if (!diagReport?.report_json) return {};
    try {
      const r = JSON.parse(diagReport.report_json);
      return {
        appCrashes: r.appCrashes?.length ?? 0,
        unexpectedReboots: r.unexpectedReboots?.length ?? 0,
        sysErr: (r.systemEvents ?? []).filter(
          (e: { levelNum?: number }) => (e.levelNum ?? 9) <= 2,
        ).length,
        appErr: (r.appEvents ?? []).filter(
          (e: { levelNum?: number }) => (e.levelNum ?? 9) <= 2,
        ).length,
        ramPct: r.memory?.usedPct,
        uptimeHours: r.host?.uptimeHours,
      };
    } catch {
      return {};
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function loadWidgets() {
      try {
        const list = (await invoke("list_mcps")) as McpInfo[];
        if (!cancelled) setMcps(list);
      } catch {
        if (!cancelled) setMcps([]);
      }
      try {
        const mem = (await invoke("memory_status")) as MemoryStatusInfo;
        if (!cancelled) setMemory(mem);
      } catch {
        if (!cancelled) setMemory(null);
      }
    }
    loadWidgets();
    const t = setInterval(loadWidgets, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const qdrantDot: GlobalStatus = !qdrant && !qdrantErr ? "loading" : qdrant?.status === "up" ? "ok" : "down";
  const alertsCritical = alerts.filter((a) => a.severity === "critical" || a.severity === "blocking").length;
  const alertsWarn = alerts.filter((a) => a.severity === "warn").length;
  const alertsActionable = alertsCritical + alertsWarn;
  const alertsEmphasis: "normal" | "warn" | "critical" =
    alertsCritical > 0 ? "critical" : alertsWarn > 0 ? "warn" : "normal";
  const alertsDot: GlobalStatus = alertsCritical > 0 ? "down" : alertsWarn > 0 ? "warn" : "ok";

  // MCPs widget — connected / issues
  const mcpOk = mcps?.filter((m) => m.status === "ok").length ?? 0;
  const mcpTotal = mcps?.length ?? 0;
  const mcpIssues =
    mcps?.filter(
      (m) => (m.status === "degraded" || m.status === "missing") && !m.expected_offline,
    ).length ?? 0;
  const mcpsDot: GlobalStatus =
    mcps === null ? "loading" : mcpIssues > 0 ? "warn" : "ok";
  const mcpsEmphasis: "normal" | "warn" | "critical" =
    mcpIssues > 0 ? "warn" : "normal";

  // Brain index widget — points + age
  const brainPoints = memory?.qdrant.collections.reduce(
    (acc, c) => acc + (c.points_count ?? 0),
    0,
  );
  const brainAge = memory?.brain.age_hours ?? null;
  const brainDot: GlobalStatus =
    memory === null
      ? "loading"
      : !memory.brain.exists
        ? "down"
        : brainAge !== null && brainAge > 24
          ? "warn"
          : "ok";
  const brainLabel =
    memory === null
      ? "—"
      : memory.brain.exists
        ? `${brainPoints?.toLocaleString() ?? 0}`
        : "missing";
  const brainDetail =
    memory === null
      ? "loading…"
      : memory.brain.exists
        ? brainAge !== null
          ? `${memory.vault.note_count} notes · ${Math.floor(brainAge)}h old`
          : `${memory.vault.note_count} notes`
        : "brain_index.db not found";

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
          value={mcps === null ? "—" : `${mcpOk}/${mcpTotal}`}
          detail={
            mcps === null
              ? "loading…"
              : mcpIssues === 0
                ? "all connected"
                : `${mcpIssues} need attention`
          }
          statusDot={mcpsDot}
          emphasis={mcpsEmphasis}
        />
        <MetricCard
          label="Brain · Qdrant"
          value={brainLabel}
          detail={brainDetail}
          statusDot={brainDot}
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

      {/* Diagnose PC */}
      <section className="mt-8">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[14px] font-semibold">Diagnose PC</h2>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={runDiagnose}
              disabled={diagLoading}
              className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
              style={{
                background: "var(--color-surface-2)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
              }}
            >
              {diagLoading ? "Recolectando…" : "Recolectar 24h"}
            </button>
            <button
              type="button"
              onClick={() => askAi("claude")}
              disabled={!diagReport || diagAiLoading}
              className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
              style={{
                background: "var(--color-accent)",
                color: "var(--color-accent-text)",
              }}
              title="Manda el report a Claude y pide diagnóstico en español"
            >
              {diagAiLoading ? "Claude pensando…" : "Diagnosticar con Claude"}
            </button>
          </div>
        </div>
        <p
          className="mt-1 text-[12px]"
          style={{ color: "var(--color-text-secondary)" }}
        >
          Recoge Event Viewer (System + Application críticos/errores), top
          procesos por RAM, disco, crashes y reboots inesperados. Luego se
          puede pedir a una IA un análisis de qué pasó.
        </p>

        {diagError && (
          <div
            className="mt-3 rounded p-3 text-[12px]"
            style={{
              background: "rgba(248, 81, 73, 0.06)",
              border: "1px solid rgba(248, 81, 73, 0.22)",
              color: "var(--color-danger)",
            }}
          >
            {diagError}
          </div>
        )}

        {diagReport && (() => {
          const s = parsedReport();
          return (
            <div className="mt-3 grid grid-cols-3 gap-2 md:grid-cols-6">
              <MiniStat
                label="Sys err"
                value={String(s.sysErr ?? "—")}
                emphasis={(s.sysErr ?? 0) > 5 ? "warn" : "normal"}
              />
              <MiniStat
                label="App err"
                value={String(s.appErr ?? "—")}
                emphasis={(s.appErr ?? 0) > 5 ? "warn" : "normal"}
              />
              <MiniStat
                label="Crashes"
                value={String(s.appCrashes ?? "—")}
                emphasis={(s.appCrashes ?? 0) > 0 ? "critical" : "normal"}
              />
              <MiniStat
                label="Hard reboots"
                value={String(s.unexpectedReboots ?? "—")}
                emphasis={(s.unexpectedReboots ?? 0) > 0 ? "critical" : "normal"}
              />
              <MiniStat
                label="RAM %"
                value={s.ramPct != null ? `${s.ramPct}%` : "—"}
                emphasis={(s.ramPct ?? 0) > 85 ? "warn" : "normal"}
              />
              <MiniStat
                label="Uptime"
                value={s.uptimeHours != null ? `${s.uptimeHours}h` : "—"}
              />
            </div>
          );
        })()}

        {diagAi && diagAi.success && (
          <div
            className="mt-4 rounded p-4 text-[12.5px] leading-relaxed"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
              color: "var(--color-text-secondary)",
              whiteSpace: "pre-wrap",
            }}
          >
            {diagAi.analysis}
          </div>
        )}

        {diagReport && !diagAi && (
          <details className="mt-3">
            <summary
              className="cursor-pointer text-[11px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Ver report JSON crudo ({diagReport.report_json.length} chars)
            </summary>
            <pre
              className="mt-2 max-h-80 overflow-auto rounded p-3 text-[10.5px] leading-relaxed"
              style={{
                background: "var(--color-surface-1)",
                border: "1px solid var(--color-border)",
                fontFamily: "var(--font-mono)",
                color: "var(--color-text-tertiary)",
                whiteSpace: "pre-wrap",
              }}
            >
              {diagReport.report_json}
            </pre>
          </details>
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
