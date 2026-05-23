import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirmDialog } from "../lib/dialog";
import type {
  AlertEntry,
  ChangelogEntry,
  GlobalStatus,
  MaintenanceCommand,
  MaintenanceResult,
  McpInfo,
} from "../types";
import { statusColor } from "../lib/status";
import packageJson from "../../package.json";

// v15.4.7 — read version from package.json (single source of truth, no
// hardcoded literal). Vite inlines the import at build time so this has
// zero runtime cost.
const APP_VERSION: string = (packageJson as { version?: string }).version ?? "";

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
          One-shot maintenance operations. Pick a button to re-run the relevant
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
  // qdrant / qdrantErr removed in v2.0 (Mem0 replaces Qdrant).
  alerts: AlertEntry[];
  changelog: ChangelogEntry[];
  globalStatus: GlobalStatus;
  // P6: optional callback so the Dashboard can deep-link the user to
  // System -> Diagnostics now that the legacy run_diagnose flow is gone.
  onNavigate?: (tab: "system") => void;
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
  {
    name: "run-weekly-backup",
    title: "Run weekly backup now",
    blurb: "Triggers the ULTRON-Backup-Weekly scheduled task so disk mirrors refresh. Fixes the 'Backup stale' Doctor row.",
  },
  {
    name: "refresh-versions",
    title: "Sync version numbers",
    blurb: "Reads canonical version from CHANGELOG.md and writes it into Cargo.toml, package.json, tauri.conf.json, ULTRON skill frontmatter and SYSTEM-MAP. Fixes the 'Version drift' Doctor row.",
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
  alerts,
  changelog,
  globalStatus,
  onNavigate,
}: Props) {
  const [diag, setDiag] = useState<FullDiagnostic | null>(null);
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagErr, setDiagErr] = useState<string | null>(null);
  const [mcps, setMcps] = useState<McpInfo[] | null>(null);

  // P6: legacy pcReport / runPcDiagnose / diagnoseTitle state removed —
  // the native diagnostic + AI analysis now lives in System → Diagnostics.

  // Auto-fix modal state
  const [fixOpen, setFixOpen] = useState(false);
  const [fixSelected, setFixSelected] = useState<Set<string>>(new Set());
  const [fixRunning, setFixRunning] = useState(false);
  const [fixResults, setFixResults] = useState<AutoFixResult[]>([]);
  // v15.4.21: end-user installs (NSIS / MSI / bootstrap) have no editable
  // Cargo.toml / package.json to keep in sync, so the "Sync version
  // numbers" fix is hidden for them. Developer clones (with .git at
  // ~/.ultron) keep seeing it.
  const [isDevInstall, setIsDevInstall] = useState(false);
  // v15.5.18 review: (Linux parity): only restart-qdrant has a .sh sibling;
  // every other auto-fix is Windows-only (CrashDumps, Recycle Bin, NSIS, MSI,
  // Sync version). On Linux the backend returns "no .sh script for this
  // platform" on click — better to hide the rows entirely.
  const isWindows =
    typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
  useEffect(() => {
    invoke<boolean>("is_developer_install")
      .then((v) => setIsDevInstall(v))
      .catch(() => setIsDevInstall(false));
  }, []);
  // Per-fix Linux availability — extend this set as .sh siblings land.
  const LINUX_OK_AUTO_FIXES = new Set<string>(["restart-qdrant"]);
  const visibleAutoFixes = AUTO_FIX_CATALOG.filter((f) => {
    if (f.name === "refresh-versions" && !isDevInstall) return false;
    if (!isWindows && !LINUX_OK_AUTO_FIXES.has(f.name)) return false;
    return true;
  });

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

  // Full diagnostic auto-runs on mount so the diagnostic cards are populated
  // without a manual click (cards should always be active).
  useEffect(() => {
    void runFullDiagnostic();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      const ok = await confirmDialog(
        "This will permanently empty the Recycle Bin on all drives. Continue?",
        { title: "Empty Recycle Bin", kind: "warning" },
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

  useEffect(() => {
    let cancelled = false;
    async function loadWidgets() {
      try {
        const list = (await invoke("list_mcps")) as McpInfo[];
        if (!cancelled) setMcps(list);
      } catch {
        if (!cancelled) setMcps([]);
      }
    }
    loadWidgets();
    const t = setInterval(loadWidgets, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

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

  const lastChange = changelog[0];

  // The "Close Control Center" action lives in Settings → App lifecycle
  // (LifecyclePanel). It was removed from the Dashboard header so a
  // destructive full-exit isn't one stray click away from the landing tab.

  return (
    <div className="px-10 py-8">
      <header className="mb-8">
        <h1 className="text-[20px] font-semibold leading-tight">Dashboard</h1>
        <p className="mt-1 text-[13px]" style={{ color: "var(--color-text-secondary)" }}>
          System overview · Control Center v{APP_VERSION}
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3">
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
              Skills, Disk, Backups. Each subsystem reports a
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

      {/* P6: legacy run_diagnose flow removed — the native PC diagnostic
          (sysinfo + wmi + AI analysis + history + scheduled run) lives
          under System -> Diagnostics. We keep the Auto-fix checklist
          here because it's an orthogonal maintenance surface. */}
      <section className="mt-8">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[14px] font-semibold">PC diagnostics</h2>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onNavigate?.("system")}
              className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors"
              style={{
                background: "var(--color-surface-2)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
              }}
              title="Open System → Diagnostics for the full report + AI analysis."
            >
              Open Diagnostics
            </button>
            <button
              type="button"
              onClick={() => {
                setFixSelected(new Set());
                setFixResults([]);
                setFixOpen(true);
              }}
              className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors"
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
          Native PC diagnostic, AI analysis, history and daily scheduled run
          moved to System → Diagnostics. This section keeps the one-click
          auto-fix checklist.
        </p>
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
              {visibleAutoFixes.map((f) => (
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
