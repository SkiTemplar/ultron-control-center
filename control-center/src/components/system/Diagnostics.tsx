// Control Center 2.0 — Phase 6 PC Diagnostic UI.
//
// Native checks (sysinfo + wmi) rendered as severity-coded cards. Adds
// an in-app AI analysis panel ("claude --print" via tauri-plugin-shell)
// plus side panels for History and the daily Windows Task Scheduler
// schedule.

import { useState } from "react";
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

export function Diagnostics() {
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  async function run() {
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
  }

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

  // v2.0 redesign: diagnostic is on-demand — present a compact intro
  // banner explaining that and stash the (rarely-used) schedule + history
  // behind disclosures, so the panel doesn't fight the rest of System for
  // visual weight when no report is loaded.
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
              On-demand only. Run this when the PC misbehaves: it snapshots
              CPU/RAM/disks, recent event-log entries, and CLI health. Nothing
              runs automatically unless you enable a schedule below.
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              className="rounded px-2.5 py-1 text-[11px] font-medium transition-colors"
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
              className="rounded px-2.5 py-1 text-[11px] font-medium transition-colors"
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
              onClick={run}
              disabled={loading}
            >
              {loading ? "Running..." : "Run diagnostic"}
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

          <SectionCard
            title={`Event log (last 24h, >= Warning) — ${report.event_log.length}`}
            severity={
              report.event_log.some(
                (e) => e.level === "Error" || e.level === "Critical",
              )
                ? "warn"
                : "ok"
            }
          >
            {report.event_log.slice(0, 10).map((e, idx) => (
              <div key={idx} className="text-xs">
                <span className="font-mono text-white/50">
                  [{e.time_generated}]
                </span>{" "}
                <span className="font-mono">
                  {e.log_name}/{e.source}
                </span>{" "}
                — {e.level} — id {e.event_id}
              </div>
            ))}
            {report.event_log.length > 10 && (
              <div className="text-xs text-white/40">
                ... {report.event_log.length - 10} more
              </div>
            )}
          </SectionCard>
        </div>
      )}

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
