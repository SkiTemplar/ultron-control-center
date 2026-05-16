import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  QdrantHealth,
  AlertEntry,
  ChangelogEntry,
  DetectedGap,
  GapsReport,
  GlobalStatus,
  MaintenanceCommand,
  MaintenanceResult,
  McpInfo,
  MemoryStatusInfo,
} from "../types";
import { statusColor } from "../lib/status";

// ---------------------------------------------------------------------------
// Pending items — surfaces the detect_gaps.py hook output as a Dashboard
// card. Same script that runs on SessionStart is invoked on demand here
// so the user can see open loops without opening a Claude session.
// ---------------------------------------------------------------------------

function gapColor(sev: string): string {
  if (sev === "critical") return "var(--color-danger)";
  if (sev === "warn") return "#e8a93a";
  return "var(--color-text-tertiary)";
}

function PendingItemsPanel() {
  const [report, setReport] = useState<GapsReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    setBusy(true);
    setErr(null);
    try {
      const r = await invoke<GapsReport>("run_detect_gaps");
      setReport(r);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="mt-8">
      <div className="flex items-baseline justify-between">
        <div>
          <h2 className="text-[14px] font-semibold">Pending items</h2>
          <p
            className="mt-1 text-[12px]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Open loops detected across the cockpit: skills drift, idle plans,
            stale backups, quarantined skills, critical alerts un-acked. Runs
            the same script Claude sees on SessionStart.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy}
          className="rounded px-3 py-1.5 text-[12px] transition-colors disabled:opacity-50"
          style={{
            background: "var(--color-surface-2)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
          }}
        >
          {busy ? "Scanning…" : "Refresh"}
        </button>
      </div>
      {err && (
        <div
          className="mt-3 rounded p-3 text-[12px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {err}
        </div>
      )}
      {!err && report && report.count === 0 && (
        <div
          className="mt-3 rounded p-3 text-[12px]"
          style={{
            background: "rgba(63, 185, 80, 0.06)",
            border: "1px solid rgba(63, 185, 80, 0.22)",
            color: "var(--color-success)",
          }}
        >
          No open loops detected. Cockpit is clean.
        </div>
      )}
      {!err && report && report.count > 0 && (
        <div className="mt-3 space-y-2">
          {report.gaps.map((g: DetectedGap, i: number) => (
            <div
              key={`${g.category}-${i}`}
              className="rounded p-3 text-[12px]"
              style={{
                background: "var(--color-surface-2)",
                border: `1px solid ${gapColor(g.severity)}33`,
                borderLeft: `3px solid ${gapColor(g.severity)}`,
              }}
            >
              <div className="flex items-baseline justify-between gap-3">
                <div className="min-w-0">
                  <span
                    className="text-[10.5px] font-medium uppercase tracking-wide"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    {g.category}
                  </span>
                  <span
                    className="ml-2 text-[12px] font-semibold"
                    style={{ color: "var(--color-text)" }}
                  >
                    {g.title}
                  </span>
                </div>
                <span
                  className="shrink-0 rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide"
                  style={{
                    background: `${gapColor(g.severity)}22`,
                    color: gapColor(g.severity),
                  }}
                >
                  {g.severity}
                </span>
              </div>
              {g.detail && (
                <div
                  className="mt-1 text-[11.5px]"
                  style={{ color: "var(--color-text-secondary)" }}
                >
                  {g.detail}
                </div>
              )}
              {g.suggestion && (
                <div
                  className="mt-1 text-[11px]"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  → {g.suggestion}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Maintenance panel — buttons that fire whitelisted Rust commands (see
// src-tauri/src/maintenance.rs). Each button shows its label, runs the
// command, then dumps stdout/stderr+exit_code in a collapsible result.
// ---------------------------------------------------------------------------

function MaintenancePanel() {
  const [cmds, setCmds] = useState<MaintenanceCommand[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, MaintenanceResult>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    invoke<MaintenanceCommand[]>("list_maintenance_commands")
      .then(setCmds)
      .catch(() => setCmds([]));
  }, []);

  async function run(kind: string) {
    setBusy(kind);
    setErrors((p) => {
      const next = { ...p };
      delete next[kind];
      return next;
    });
    try {
      const r = await invoke<MaintenanceResult>("run_maintenance_command", { kind });
      setResults((p) => ({ ...p, [kind]: r }));
      setExpanded(kind);
    } catch (e) {
      setErrors((p) => ({ ...p, [kind]: String(e) }));
    } finally {
      setBusy(null);
    }
  }

  if (cmds.length === 0) return null;

  const groups = ["skills", "memory", "system"];

  return (
    <section className="mt-8">
      <div>
        <h2 className="text-[14px] font-semibold">Maintenance commands</h2>
        <p
          className="mt-1 text-[12px]"
          style={{ color: "var(--color-text-secondary)" }}
        >
          One-shot cockpit operations. Pick a button to re-run the relevant
          script and see its output here without spawning a terminal.
        </p>
      </div>
      {groups.map((g) => {
        const groupCmds = cmds.filter((c) => c.group === g);
        if (groupCmds.length === 0) return null;
        return (
          <div key={g} className="mt-3">
            <div
              className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.06em]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {g}
            </div>
            <div className="flex flex-wrap gap-2">
              {groupCmds.map((c) => {
                const running = busy === c.kind;
                const result = results[c.kind];
                const err = errors[c.kind];
                const dotColor = err
                  ? "var(--color-danger)"
                  : result
                  ? result.success
                    ? "var(--color-success)"
                    : "var(--color-warn)"
                  : "var(--color-text-faint)";
                return (
                  <button
                    key={c.kind}
                    type="button"
                    onClick={() => run(c.kind)}
                    disabled={running}
                    title={c.description}
                    className="flex items-center gap-2 rounded px-3 py-1.5 text-[12px] transition-colors disabled:opacity-60"
                    style={{
                      background: "var(--color-surface-2)",
                      color: "var(--color-text)",
                      border: "1px solid var(--color-border-strong)",
                    }}
                  >
                    <span
                      className="inline-block h-1.5 w-1.5 rounded-full"
                      style={{ background: dotColor }}
                    />
                    <span>{running ? `${c.label}…` : c.label}</span>
                    {result && (
                      <span
                        className="tabular-nums text-[10.5px]"
                        style={{ color: "var(--color-text-tertiary)" }}
                      >
                        {result.elapsed_ms}ms
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      {expanded && (results[expanded] || errors[expanded]) && (
        <div
          className="mt-3 rounded p-3"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border-strong)",
          }}
        >
          <div className="flex items-baseline justify-between">
            <span
              className="text-[10px] font-medium uppercase tracking-[0.06em]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {cmds.find((c) => c.kind === expanded)?.label ?? expanded}
              {results[expanded] && (
                <>
                  {" · exit "}
                  <code style={{ fontFamily: "var(--font-mono)" }}>
                    {results[expanded].exit_code ?? "?"}
                  </code>
                </>
              )}
            </span>
            <button
              type="button"
              onClick={() => setExpanded(null)}
              className="text-[10.5px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              close
            </button>
          </div>
          {errors[expanded] && (
            <pre
              className="mt-2 max-h-[280px] overflow-auto whitespace-pre-wrap text-[11px]"
              style={{
                fontFamily: "var(--font-mono)",
                color: "var(--color-danger)",
              }}
            >
              {errors[expanded]}
            </pre>
          )}
          {results[expanded] && (
            <>
              {results[expanded].stdout && (
                <pre
                  className="mt-2 max-h-[280px] overflow-auto whitespace-pre-wrap text-[11px]"
                  style={{
                    fontFamily: "var(--font-mono)",
                    color: "var(--color-text-secondary)",
                  }}
                >
                  {results[expanded].stdout}
                </pre>
              )}
              {results[expanded].stderr && (
                <pre
                  className="mt-2 max-h-[200px] overflow-auto whitespace-pre-wrap text-[11px]"
                  style={{
                    fontFamily: "var(--font-mono)",
                    color: "var(--color-warn)",
                  }}
                >
                  {results[expanded].stderr}
                </pre>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

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

// Full diagnostic (Phase 6) shape — must mirror Rust FullDiagnostic.
type DiagItem = {
  key: string;
  label: string;
  color: "green" | "orange" | "red";
  metric: string;
  detail: string | null;
  fix: string | null;
  elapsed_ms: number;
};
type FullDiagnostic = {
  items: DiagItem[];
  generated_at: string;
  elapsed_ms_total: number;
};
type AutoFixResult = {
  name: string;
  success: boolean;
  stdout: string;
  stderr: string;
  exit_code: number | null;
};

// Friendly labels for the auto-fix checklist modal.
const AUTO_FIX_CATALOG: { name: string; title: string; blurb: string; danger?: boolean }[] = [
  {
    name: "clear-minidumps",
    title: "Clear minidumps",
    blurb: "Remove %LOCALAPPDATA%\\CrashDumps\\*.dmp",
  },
  {
    name: "clear-temp-30d",
    title: "Clear temp (> 30 days)",
    blurb: "Delete stale files from %TEMP% and Windows\\Temp",
  },
  {
    name: "empty-recycle-bin",
    title: "Empty Recycle Bin",
    blurb: "Clear-RecycleBin -Force (all drives)",
    danger: true,
  },
  {
    name: "restart-qdrant",
    title: "Restart Qdrant",
    blurb: "Kill stale qdrant.exe, re-run ensure-qdrant.ps1 to relaunch the native binary",
  },
];

function colorToken(color: "green" | "orange" | "red") {
  switch (color) {
    case "green":
      return "var(--color-success)";
    case "orange":
      return "var(--color-warn)";
    case "red":
      return "var(--color-danger)";
  }
}

export function Dashboard({
  qdrant,
  qdrantErr,
  alerts,
  changelog,
  globalStatus,
}: Props) {
  const [diag, setDiag] = useState<FullDiagnostic | null>(null);
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagErr, setDiagErr] = useState<string | null>(null);
  const [mcps, setMcps] = useState<McpInfo[] | null>(null);
  const [memory, setMemory] = useState<MemoryStatusInfo | null>(null);

  // PC diagnostics (existing flow) — kept as-is.
  const [pcReport, setPcReport] = useState<DiagnoseResult | null>(null);
  const [pcLoading, setPcLoading] = useState(false);
  const [pcError, setPcError] = useState<string | null>(null);

  // Auto-fix modal state
  const [fixOpen, setFixOpen] = useState(false);
  const [fixSelected, setFixSelected] = useState<Set<string>>(new Set());
  const [fixRunning, setFixRunning] = useState(false);
  const [fixResults, setFixResults] = useState<AutoFixResult[]>([]);

  async function runFullDiagnostic() {
    setDiagLoading(true);
    setDiagErr(null);
    try {
      const r = (await invoke("run_full_diagnostic")) as FullDiagnostic;
      setDiag(r);
    } catch (e) {
      setDiagErr(String(e));
    } finally {
      setDiagLoading(false);
    }
  }

  async function runPcDiagnose() {
    setPcLoading(true);
    setPcError(null);
    try {
      const r = (await invoke("run_diagnose", { hours: 24 })) as DiagnoseResult;
      setPcReport(r);
      if (!r.success) setPcError(r.stderr || "Diagnose returned no output");
    } catch (e) {
      setPcError(String(e));
    } finally {
      setPcLoading(false);
    }
  }

  function toggleFix(name: string) {
    setFixSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }

  async function applySelectedFixes() {
    if (fixSelected.size === 0) return;
    // Extra confirm for the destructive one.
    if (fixSelected.has("empty-recycle-bin")) {
      const ok = window.confirm(
        "This will permanently empty the Recycle Bin on all drives. Continue?",
      );
      if (!ok) return;
    }
    setFixRunning(true);
    setFixResults([]);
    const out: AutoFixResult[] = [];
    for (const name of Array.from(fixSelected)) {
      try {
        const r = (await invoke("apply_auto_fix", { name })) as AutoFixResult;
        out.push(r);
      } catch (e) {
        out.push({
          name,
          success: false,
          stdout: "",
          stderr: String(e),
          exit_code: null,
        });
      }
    }
    setFixResults(out);
    setFixRunning(false);
    // Refresh the diagnostic so the user sees the impact.
    runFullDiagnostic();
  }

  function parsedPcReport(): {
    appCrashes?: number;
    unexpectedReboots?: number;
    sysErr?: number;
    appErr?: number;
    ramPct?: number;
    uptimeHours?: number;
  } {
    if (!pcReport?.report_json) return {};
    try {
      const r = JSON.parse(pcReport.report_json);
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
          System overview · Control Center v15.2
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

      {/* Full diagnostic — replaces the old "ultron status" quick check */}
      <section className="mt-8">
        <div className="flex items-baseline justify-between">
          <div>
            <h2 className="text-[14px] font-semibold">Full diagnostic</h2>
            <p
              className="mt-1 text-[12px]"
              style={{ color: "var(--color-text-secondary)" }}
            >
              Parallel health check across Qdrant, Brain, Vault, Hooks, MCPs,
              Skills, Cost, Disk, Backups. Each subsystem reports a
              colour and a key metric.
            </p>
          </div>
          <button
            type="button"
            onClick={runFullDiagnostic}
            disabled={diagLoading}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            {diagLoading ? "Probing…" : "Run full diagnostic"}
          </button>
        </div>

        {diagErr && (
          <div
            className="mt-3 rounded p-3 text-[12px]"
            style={{
              background: "rgba(248, 81, 73, 0.06)",
              border: "1px solid rgba(248, 81, 73, 0.22)",
              color: "var(--color-danger)",
            }}
          >
            {diagErr}
          </div>
        )}

        {diag && (
          <>
            <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
              {diag.items.map((item) => (
                <div
                  key={item.key}
                  className="rounded-md px-4 py-3"
                  style={{
                    background: "var(--color-surface-2)",
                    border: `1px solid ${colorToken(item.color)}33`,
                    borderLeft: `3px solid ${colorToken(item.color)}`,
                  }}
                >
                  <div className="flex items-center justify-between">
                    <span
                      className="text-[11px] font-medium uppercase tracking-wide"
                      style={{ color: "var(--color-text-tertiary)" }}
                    >
                      {item.label}
                    </span>
                    <span
                      className="inline-block h-1.5 w-1.5 rounded-full"
                      style={{ background: colorToken(item.color) }}
                    />
                  </div>
                  <div className="mt-1.5 text-[15px] font-semibold tabular-nums leading-tight">
                    {item.metric}
                  </div>
                  {item.detail && (
                    <div
                      className="mt-1 text-[11px]"
                      style={{ color: "var(--color-text-tertiary)" }}
                    >
                      {item.detail}
                    </div>
                  )}
                  {item.fix && (
                    <button
                      type="button"
                      onClick={() => {
                        setFixSelected(new Set([item.fix as string]));
                        setFixOpen(true);
                      }}
                      className="mt-2 text-[11px] underline-offset-2 hover:underline"
                      style={{ color: colorToken(item.color) }}
                    >
                      Fix → {item.fix}
                    </button>
                  )}
                  <div
                    className="mt-1 text-[10px]"
                    style={{ color: "var(--color-text-faint)" }}
                  >
                    {item.elapsed_ms}ms
                  </div>
                </div>
              ))}
            </div>
            <div
              className="mt-2 text-[11px]"
              style={{ color: "var(--color-text-faint)" }}
            >
              Generated {formatRelative(diag.generated_at)} · total{" "}
              {diag.elapsed_ms_total}ms
            </div>
          </>
        )}
      </section>

      <MaintenancePanel />

      <PendingItemsPanel />

      {/* PC Diagnostics (existing) + Auto-fix entry point */}
      <section className="mt-8">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[14px] font-semibold">PC diagnostics</h2>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={runPcDiagnose}
              disabled={pcLoading}
              className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
              style={{
                background: "var(--color-surface-2)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
              }}
            >
              {pcLoading ? "Collecting…" : "Collect 24h"}
            </button>
            <button
              type="button"
              onClick={() => {
                setFixSelected(new Set());
                setFixResults([]);
                setFixOpen(true);
              }}
              disabled={!pcReport}
              className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
              style={{
                background: "var(--color-accent)",
                color: "var(--color-accent-text)",
              }}
              title="Open the auto-fix checklist"
            >
              Auto-fix common issues
            </button>
          </div>
        </div>
        <p
          className="mt-1 text-[12px]"
          style={{ color: "var(--color-text-secondary)" }}
        >
          Collects Event Viewer (System + Application critical/errors), top RAM
          processes, disk usage, crashes and unexpected reboots.
        </p>

        {pcError && (
          <div
            className="mt-3 rounded p-3 text-[12px]"
            style={{
              background: "rgba(248, 81, 73, 0.06)",
              border: "1px solid rgba(248, 81, 73, 0.22)",
              color: "var(--color-danger)",
            }}
          >
            {pcError}
          </div>
        )}

        {pcReport && (() => {
          const s = parsedPcReport();
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

      {/* Auto-fix modal */}
      {fixOpen && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.55)" }}
          onClick={() => {
            if (!fixRunning) setFixOpen(false);
          }}
        >
          <div
            className="max-h-[80vh] w-[560px] overflow-auto rounded-md p-6"
            style={{
              background: "var(--color-surface-1)",
              border: "1px solid var(--color-border-strong)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-baseline justify-between">
              <h3 className="text-[15px] font-semibold">Auto-fix common issues</h3>
              <button
                type="button"
                onClick={() => setFixOpen(false)}
                disabled={fixRunning}
                className="text-[12px]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                Close
              </button>
            </div>
            <p
              className="mt-1 text-[12px]"
              style={{ color: "var(--color-text-secondary)" }}
            >
              Select the fixes to apply. Each one runs as an isolated PowerShell
              script under <span style={{ fontFamily: "var(--font-mono)" }}>scripts/cockpit/auto-fixes/</span>.
            </p>

            <ul className="mt-4 space-y-2">
              {AUTO_FIX_CATALOG.map((f) => (
                <li
                  key={f.name}
                  className="rounded p-3"
                  style={{
                    background: "var(--color-surface-2)",
                    border: "1px solid var(--color-border)",
                  }}
                >
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={fixSelected.has(f.name)}
                      onChange={() => toggleFix(f.name)}
                      disabled={fixRunning}
                      className="mt-0.5"
                    />
                    <div className="flex-1">
                      <div className="text-[12.5px] font-medium">
                        {f.title}
                        {f.danger && (
                          <span
                            className="ml-2 rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide"
                            style={{
                              background: "rgba(248, 81, 73, 0.12)",
                              color: "var(--color-danger)",
                            }}
                          >
                            destructive
                          </span>
                        )}
                      </div>
                      <div
                        className="mt-0.5 text-[11.5px]"
                        style={{ color: "var(--color-text-tertiary)" }}
                      >
                        {f.blurb}
                      </div>
                    </div>
                  </label>
                </li>
              ))}
            </ul>

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setFixOpen(false)}
                disabled={fixRunning}
                className="rounded px-3 py-1.5 text-[12px] font-medium"
                style={{
                  background: "var(--color-surface-2)",
                  border: "1px solid var(--color-border-strong)",
                  color: "var(--color-text)",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={applySelectedFixes}
                disabled={fixRunning || fixSelected.size === 0}
                className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-40"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-accent-text)",
                }}
              >
                {fixRunning ? "Applying…" : `Apply ${fixSelected.size}`}
              </button>
            </div>

            {fixResults.length > 0 && (
              <div className="mt-5 space-y-2">
                <h4 className="text-[12.5px] font-semibold">Results</h4>
                {fixResults.map((r) => (
                  <div
                    key={r.name}
                    className="rounded p-2 text-[11.5px]"
                    style={{
                      background: "var(--color-surface-2)",
                      border: `1px solid ${r.success ? "var(--color-success)33" : "rgba(248,81,73,0.22)"}`,
                    }}
                  >
                    <div className="flex items-center justify-between">
                      <span style={{ fontFamily: "var(--font-mono)" }}>{r.name}</span>
                      <span
                        style={{
                          color: r.success
                            ? "var(--color-success)"
                            : "var(--color-danger)",
                        }}
                      >
                        {r.success ? "ok" : `exit ${r.exit_code ?? "?"}`}
                      </span>
                    </div>
                    {(r.stdout || r.stderr) && (
                      <pre
                        className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap"
                        style={{
                          color: "var(--color-text-tertiary)",
                          fontFamily: "var(--font-mono)",
                          fontSize: "10.5px",
                        }}
                      >
                        {r.stdout || r.stderr}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
