// PC Diagnostic summary — fires the native diagnostic on mount and shows a
// one-line health summary. Clickable to deep-link into System -> Diagnostics.
//
// v2.5: when `max_severity === "error"`, the card now leads with the failing
// subsystems (red dots first) and surfaces a "View errors" CTA that jumps
// into System / Diagnostics with the severity filter pre-applied.

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DiagnosticReport, DiagSeverity } from "../../types";
import { Card, SmallButton, relativeTime } from "./Card";

interface PcDiagnosticCardProps {
  onOpenDiagnostics?: (opts?: { severityFilter?: DiagSeverity }) => void;
}

function severityAccent(s: DiagSeverity): "ok" | "warn" | "danger" {
  if (s === "ok") return "ok";
  if (s === "warn") return "warn";
  return "danger";
}

function sevWeight(s: DiagSeverity): number {
  if (s === "error") return 2;
  if (s === "warn") return 1;
  return 0;
}

function dotColor(s: DiagSeverity): string {
  if (s === "error") return "var(--color-danger)";
  if (s === "warn") return "var(--color-warn)";
  return "var(--color-success)";
}

interface SubsystemRow {
  label: string;
  severity: DiagSeverity;
  detail: string;
}

export function PcDiagnosticCard({ onOpenDiagnostics }: PcDiagnosticCardProps) {
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const r = await invoke<DiagnosticReport>("run_diagnostic_native");
        if (!cancelled) setReport(r);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Collect every subsystem with its severity. Sorted error -> warn -> ok so
  // failing subsystems jump to the top of the rolled summary regardless of
  // their declared order in the DiagnosticReport struct.
  const rows = useMemo<SubsystemRow[]>(() => {
    if (!report) return [];
    const out: SubsystemRow[] = [
      {
        label: "System",
        severity: report.system.severity,
        detail: `CPU ${Math.round(report.system.cpu_usage_percent)}% · RAM ${Math.round(
          report.system.ram_usage_percent,
        )}%`,
      },
      {
        label: "Network",
        severity: report.network.severity,
        detail: report.network.reachable
          ? `online (${report.network.latency_ms ?? "?"}ms)`
          : "offline",
      },
      {
        label: "App",
        severity: report.app.severity,
        detail: report.app.claude_in_path ? "Claude OK" : "Claude missing",
      },
    ];
    for (const d of report.disks) {
      out.push({
        label: `Disk ${d.mount}`,
        severity: d.severity,
        detail: `${Math.round(d.used_percent)}% used`,
      });
    }
    out.sort((a, b) => sevWeight(b.severity) - sevWeight(a.severity));
    return out;
  }, [report]);

  const accent = report ? severityAccent(report.max_severity) : "neutral";
  const isError = report?.max_severity === "error";

  return (
    <Card
      title="PC diagnostic"
      accent={accent}
      loading={loading}
      error={error}
      action={
        isError ? (
          <SmallButton
            onClick={() => onOpenDiagnostics?.({ severityFilter: "error" })}
            variant="accent"
            title="Open System / Diagnostics filtered to errors"
          >
            View errors
          </SmallButton>
        ) : (
          <SmallButton
            onClick={() => onOpenDiagnostics?.()}
            title="Open System / Diagnostics"
          >
            open
          </SmallButton>
        )
      }
    >
      {report && (
        <div className="space-y-1.5">
          <div className="flex items-baseline gap-2">
            <span
              className="text-[12.5px] font-semibold"
              style={{ color: "var(--color-text)" }}
            >
              {report.max_severity === "ok"
                ? "Healthy"
                : report.max_severity === "warn"
                  ? "Warnings"
                  : "Errors"}
            </span>
            <span
              className="ml-auto tabular-nums text-[10.5px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {relativeTime(report.timestamp)}
            </span>
          </div>

          {/* Rolled subsystem summary — errors first. The list is intentionally
              capped at 4 rows so the card stays the same height as before; if
              there are more issues we surface them by jumping to Diagnostics
              via the "View errors" CTA above. */}
          <ul className="space-y-0.5">
            {rows.slice(0, 4).map((r) => (
              <li
                key={r.label}
                className="flex items-baseline gap-2 text-[11px]"
                style={{ color: "var(--color-text-secondary)" }}
              >
                <span
                  className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: dotColor(r.severity) }}
                />
                <span style={{ color: "var(--color-text)" }}>{r.label}</span>
                <span
                  className="ml-auto truncate tabular-nums text-[10.5px]"
                  style={{ color: "var(--color-text-tertiary)" }}
                  title={r.detail}
                >
                  {r.detail}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
