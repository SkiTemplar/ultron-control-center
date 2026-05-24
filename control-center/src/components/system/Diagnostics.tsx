// Control Center 2.0 — Phase 6 PC Diagnostic UI.
//
// Native checks (sysinfo + wmi) rendered as severity-coded cards. Adds
// an in-app AI analysis panel ("claude --print" via tauri-plugin-shell)
// plus side panels for History and the daily Windows Task Scheduler
// schedule.
//
// v2.6: auto-runs the full native diagnostic on mount. The standalone
// `event_log_recent` command surfaces a curated "Event Log" panel with
// human-readable descriptions and suggested actions, keyed off a
// frontend KNOWN_ERRORS map.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DiagnosticReport, DiagSeverity } from "../../types";
import { Markdown } from "../../lib/markdown";
import { DiagnosticHistoryPanel } from "./DiagnosticHistoryPanel";
import { DiagnosticSchedulePanel } from "./DiagnosticSchedulePanel";

const SEV_COLOR: Record<DiagSeverity, string> = {
  ok: "border-emerald-500/30 bg-emerald-500/5",
  warn: "border-amber-500/30 bg-amber-500/5",
  error: "border-red-500/40 bg-red-500/10",
};

const SEV_GLYPH: Record<DiagSeverity, { ch: string; color: string }> = {
  ok: { ch: "✓", color: "text-emerald-400" },
  warn: { ch: "!", color: "text-amber-400" },
  error: { ch: "✕", color: "text-red-400" },
};

// ---------------------------------------------------------------------------
// Standalone Event Log types (mirror src-tauri/src/commands/event_log.rs).
// ---------------------------------------------------------------------------

type EventLogLevel =
  | "critical"
  | "error"
  | "warning"
  | "information"
  | "verbose"
  | "unknown";

interface EventLogEntry {
  event_id: number;
  source: string;
  log_name: string;
  level: EventLogLevel;
  time_created: string;
  message: string;
}

interface KnownError {
  description: string;
  suggestion: string;
  /** Severity hint used to colour-code the badge when the actual event
   *  level isn't enough to convey criticality (e.g. event 41 is just an
   *  "Error" but it means the box hard-crashed). */
  severity: "critical" | "error" | "warning";
}

// Curated list of Windows Event IDs the user actually cares about.
// Source: Microsoft Learn + common SRE playbooks. Keep this list focused —
// the goal is to translate cryptic IDs into actionable language, not to
// duplicate the Microsoft docs.
const KNOWN_ERRORS: Record<number, KnownError> = {
  41: {
    description:
      "Kernel-Power — system rebooted without cleanly shutting down. Usually a hard crash, power loss, or driver hang.",
    suggestion:
      "Check power cables / PSU, run Memory Diagnostic, update GPU/chipset drivers. If frequent, check Reliability Monitor.",
    severity: "critical",
  },
  1001: {
    description:
      "Windows Error Reporting — an application or driver crashed and was logged by WER.",
    suggestion:
      "Open the event in Event Viewer to see which binary faulted. If recurring, reinstall or update the offending app.",
    severity: "error",
  },
  6008: {
    description:
      "Unexpected shutdown — the previous system shutdown was not clean (e.g. forced reboot, BSOD, power loss).",
    suggestion:
      "Cross-reference with Event 41 in the same window. If hardware-related, check disk SMART + RAM stability.",
    severity: "critical",
  },
  7000: {
    description:
      "Service failed to start — a Windows service could not be launched at the expected moment.",
    suggestion:
      "Open services.msc, find the service named in the event message, check its dependencies and account.",
    severity: "error",
  },
  7001: {
    description:
      "Service depends on a service which failed to start — a dependency chain broke.",
    suggestion:
      "Locate the upstream service in the event details and fix that one first (its own Event 7000 will explain why).",
    severity: "error",
  },
  7011: {
    description:
      "Service timeout — Windows gave up waiting for a service to respond (default 30s).",
    suggestion:
      "If consistent, check for I/O contention on the disk hosting the service binary or extend the timeout.",
    severity: "warning",
  },
  7031: {
    description:
      "A service crashed and Service Control Manager is attempting recovery.",
    suggestion:
      "Find the service in services.msc -> Recovery tab. Look for the underlying crash in Application log.",
    severity: "warning",
  },
  4624: {
    description: "Successful logon — informational, NOT an error.",
    suggestion:
      "Only worth investigating if the logon type / source IP looks unfamiliar (possible compromise).",
    severity: "warning",
  },
  4625: {
    description: "Failed logon attempt — wrong password, expired account, locked out.",
    suggestion:
      "If repeated from one source IP / account, treat as brute-force probe and block at the firewall.",
    severity: "warning",
  },
  4634: {
    description: "Account logged off — informational.",
    suggestion: "No action required unless paired with a suspicious 4624.",
    severity: "warning",
  },
  1000: {
    description: "Application Error — a user-mode process crashed (AppCrash bucket).",
    suggestion:
      "Inspect the Faulting application name / module in the event detail. Update or reinstall the app.",
    severity: "error",
  },
  10010: {
    description:
      "DCOM server did not register with DCOM within the required timeout.",
    suggestion:
      "Usually benign during boot. If recurring, re-register the GUID's COM component.",
    severity: "warning",
  },
};

function levelBadge(level: EventLogLevel): { bg: string; fg: string; label: string } {
  switch (level) {
    case "critical":
      return { bg: "rgba(248, 81, 73, 0.18)", fg: "var(--color-danger)", label: "Critical" };
    case "error":
      return { bg: "rgba(248, 81, 73, 0.10)", fg: "var(--color-danger)", label: "Error" };
    case "warning":
      return { bg: "rgba(210, 153, 34, 0.14)", fg: "var(--color-warn)", label: "Warning" };
    case "information":
      return { bg: "rgba(88, 166, 255, 0.10)", fg: "var(--color-accent, #58a6ff)", label: "Info" };
    default:
      return { bg: "rgba(187, 187, 187, 0.10)", fg: "var(--color-text-tertiary)", label: level };
  }
}

export function Diagnostics() {
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  // Standalone event log feed — independent of the full diagnostic so the
  // user can refresh it without triggering a heavy re-scan of sysinfo etc.
  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsErr, setEventsErr] = useState<string | null>(null);

  // v2.6: diagnostic now auto-runs on mount. The header CTA becomes "Refresh".
  const run = useCallback(async () => {
    setLoading(true);
    setErr(null);
    setAnalysis(null);
    try {
      const r = (await invoke("run_diagnostic_native")) as DiagnosticReport;
      setReport(r);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadEvents = useCallback(async () => {
    setEventsLoading(true);
    setEventsErr(null);
    try {
      const r = (await invoke("event_log_recent", {
        limit: 50,
        scope: "critical_and_error",
      })) as EventLogEntry[];
      setEvents(r);
    } catch (e) {
      setEventsErr(String(e));
    } finally {
      setEventsLoading(false);
    }
  }, []);

  useEffect(() => {
    void run();
    void loadEvents();
  }, [run, loadEvents]);

  async function analyze() {
    if (!report) return;
    setAnalyzing(true);
    try {
      const md = (await invoke("analyze_diagnostic_with_ai", {
        reportJson: JSON.stringify(report, null, 2),
      })) as string;
      setAnalysis(md);
    } catch (e) {
      setAnalysis(`**Error:** ${String(e)}`);
    } finally {
      setAnalyzing(false);
    }
  }

  async function openEventViewer() {
    try {
      await invoke("open_event_viewer");
    } catch (e) {
      setEventsErr(`Could not launch Event Viewer: ${String(e)}`);
    }
  }

  const [scheduleOpen, setScheduleOpen] = useState(false);

  return (
    <div className="space-y-3">
      <div
        className="rounded p-3"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border)",
        }}
      >
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div
              className="text-[12px] font-semibold"
              style={{ color: "var(--color-text)" }}
            >
              PC Diagnostic
            </div>
            <div
              className="mt-0.5 text-[11.5px] leading-snug"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Auto-runs when this tab opens. Snapshots CPU/RAM/disks, recent
              event-log entries, and CLI health. Use Refresh after a system
              change; nothing runs in the background unless you enable a
              daily schedule.
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              className="rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
              }}
              onClick={() => setHistoryOpen((v) => !v)}
            >
              {historyOpen ? "Hide history" : "History"}
            </button>
            <button
              type="button"
              className="rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
              }}
              onClick={() => setScheduleOpen((v) => !v)}
            >
              {scheduleOpen ? "Hide schedule" : "Schedule"}
            </button>
            <button
              type="button"
              className="rounded px-3 py-1 text-[11.5px] font-medium transition-colors disabled:opacity-50"
              style={{
                background: "var(--color-accent)",
                color: "var(--color-accent-text)",
              }}
              onClick={() => {
                void run();
                void loadEvents();
              }}
              disabled={loading || eventsLoading}
            >
              {loading || eventsLoading ? "Running..." : "Refresh"}
            </button>
          </div>
        </div>
      </div>

      {err && (
        <div className="rounded border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-200">
          {err}
        </div>
      )}

      {historyOpen && (
        <DiagnosticHistoryPanel
          onSelect={(r) => {
            setReport(r);
            setHistoryOpen(false);
          }}
        />
      )}

      {scheduleOpen && <DiagnosticSchedulePanel />}

      {report && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <SectionCard title="System" severity={report.system.severity}>
            <Kv k="OS" v={report.system.os} />
            <Kv k="Kernel" v={report.system.kernel} />
            <Kv k="Hostname" v={report.system.hostname} />
            <Kv
              k="CPU"
              v={`${report.system.cpu_brand} (${report.system.cpu_cores} cores)`}
            />
            <Kv k="CPU usage" v={`${report.system.cpu_usage_percent.toFixed(1)}%`} />
            <Kv
              k="RAM"
              v={`${report.system.ram_used_mb} / ${report.system.ram_total_mb} MB (${report.system.ram_usage_percent.toFixed(1)}%)`}
            />
            <Kv
              k="Uptime"
              v={`${(report.system.uptime_seconds / 3600).toFixed(1)} h`}
            />
          </SectionCard>

          <SectionCard title="Network" severity={report.network.severity}>
            <Kv k="Reachable" v={report.network.reachable ? "yes" : "no"} />
            <Kv
              k="Latency"
              v={
                report.network.latency_ms != null
                  ? `${report.network.latency_ms} ms`
                  : "—"
              }
            />
          </SectionCard>

          <SectionCard
            title="Disks"
            severity={report.disks
              .map((d) => d.severity)
              .reduce(maxSev, "ok" as DiagSeverity)}
          >
            {report.disks.map((d) => (
              <div key={d.mount} className="text-xs font-mono">
                {d.mount} — {d.free_gb.toFixed(1)} / {d.total_gb.toFixed(1)} GB
                free ({d.used_percent.toFixed(1)}% used)
              </div>
            ))}
          </SectionCard>

          <SectionCard title="App health" severity={report.app.severity}>
            <Kv
              k="projects.json"
              v={report.app.projects_json_ok ? "ok" : "missing/corrupt"}
            />
            <Kv k="claude in PATH" v={report.app.claude_in_path ? "yes" : "no"} />
            <Kv k="codex in PATH" v={report.app.codex_in_path ? "yes" : "no"} />
            <Kv k="gemini in PATH" v={report.app.gemini_in_path ? "yes" : "no"} />
            <Kv
              k="mem0 configured"
              v={report.app.mem0_configured ? "yes" : "no"}
            />
          </SectionCard>

          <SectionCard title="Top processes (by CPU)" severity="ok">
            {report.top_processes.map((p) => (
              <div key={p.pid} className="text-xs font-mono">
                {String(p.pid).padStart(6)} — {p.name} —{" "}
                {p.cpu_percent.toFixed(1)}% CPU — {p.mem_mb} MB
              </div>
            ))}
          </SectionCard>
        </div>
      )}

      <EventLogPanel
        events={events}
        loading={eventsLoading}
        error={eventsErr}
        onRefresh={() => void loadEvents()}
        onOpenViewer={() => void openEventViewer()}
      />

      {report && (
        <div className="flex justify-end">
          <button
            type="button"
            className="flex items-center gap-1 rounded border border-white/10 px-3 py-1 text-xs hover:bg-white/5 disabled:opacity-50"
            onClick={analyze}
            disabled={analyzing}
          >
            {analyzing ? "Analyzing..." : "Analyze with AI"}
          </button>
        </div>
      )}

      {analysis && (
        <div className="rounded border border-white/10 bg-[var(--color-surface-1)] p-3">
          <div className="mb-2 text-xs text-white/50">AI analysis</div>
          <div className="prose prose-invert prose-sm max-w-none">
            <Markdown source={analysis} />
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Event Log panel — renders the standalone event_log_recent feed with
// KNOWN_ERRORS annotations.
// ---------------------------------------------------------------------------

function EventLogPanel({
  events,
  loading,
  error,
  onRefresh,
  onOpenViewer,
}: {
  events: EventLogEntry[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onOpenViewer: () => void;
}) {
  const visible = events.slice(0, 25);
  const hasMore = events.length > visible.length;

  return (
    <section
      className="rounded"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <header
        className="flex items-center justify-between px-3 py-2"
        style={{
          background: "var(--color-surface-1)",
          borderBottom: "1px solid var(--color-border)",
        }}
      >
        <div>
          <div
            className="text-[12px] font-semibold"
            style={{ color: "var(--color-text)" }}
          >
            Event Log — recent critical / error events
          </div>
          <div
            className="mt-0.5 text-[11.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Pulled live from the Windows System log via wevtutil. Annotated
            descriptions come from a curated map of common Event IDs.
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={onOpenViewer}
            className="rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
            }}
            title="Open the native Event Viewer (eventvwr.msc) for deeper inspection"
          >
            Open Event Viewer
          </button>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>
      </header>

      {error && (
        <div
          className="m-3 rounded p-2 text-[11.5px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
            fontFamily: "var(--font-mono, ui-monospace)",
          }}
        >
          {error}
        </div>
      )}

      {!loading && !error && events.length === 0 && (
        <div
          className="px-3 py-6 text-center text-[12px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          No critical or error events found.
        </div>
      )}

      {visible.length > 0 && (
        <ul className="divide-y" style={{ borderColor: "var(--color-border)" }}>
          {visible.map((evt, idx) => (
            <EventLogRow key={`${evt.time_created}-${idx}`} evt={evt} />
          ))}
        </ul>
      )}

      {hasMore && (
        <div
          className="px-3 py-2 text-[10.5px]"
          style={{ color: "var(--color-text-faint)" }}
        >
          ... {events.length - visible.length} more — open Event Viewer for the
          full list.
        </div>
      )}
    </section>
  );
}

function EventLogRow({ evt }: { evt: EventLogEntry }) {
  const known = KNOWN_ERRORS[evt.event_id];
  const badge = levelBadge(evt.level);

  return (
    <li className="flex items-start gap-3 px-3 py-2.5">
      <span
        className="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide"
        style={{ background: badge.bg, color: badge.fg }}
      >
        {badge.label}
      </span>
      <div className="min-w-0 flex-1">
        <div
          className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px]"
          style={{ color: "var(--color-text)" }}
        >
          <span className="font-semibold tabular-nums">id {evt.event_id}</span>
          <span
            className="truncate"
            style={{ color: "var(--color-text-secondary)" }}
            title={evt.source}
          >
            {evt.source || "—"}
          </span>
          <span
            className="ml-auto shrink-0 tabular-nums text-[10.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {evt.time_created}
          </span>
        </div>

        {known ? (
          <div className="mt-0.5 space-y-0.5">
            <div
              className="text-[11.5px] leading-snug"
              style={{ color: "var(--color-text-secondary)" }}
            >
              {known.description}
            </div>
            <div
              className="text-[11.5px] leading-snug"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Suggested: {known.suggestion}
            </div>
          </div>
        ) : (
          evt.message && (
            <div
              className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug"
              style={{
                color: "var(--color-text-tertiary)",
                fontFamily: "var(--font-mono, ui-monospace)",
              }}
              title={evt.message}
            >
              {evt.message}
            </div>
          )
        )}
      </div>
    </li>
  );
}

function SectionCard({
  title,
  severity,
  children,
}: {
  title: string;
  severity: DiagSeverity;
  children: React.ReactNode;
}) {
  const glyph = SEV_GLYPH[severity];
  return (
    <div className={`rounded border p-3 ${SEV_COLOR[severity]}`}>
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <span className={`font-mono ${glyph.color}`}>{glyph.ch}</span>
        {title}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between text-xs">
      <span className="text-white/50">{k}</span>
      <span className="font-mono">{v}</span>
    </div>
  );
}

function maxSev(a: DiagSeverity, b: DiagSeverity): DiagSeverity {
  const order: DiagSeverity[] = ["ok", "warn", "error"];
  return order[Math.max(order.indexOf(a), order.indexOf(b))];
}

export default Diagnostics;
