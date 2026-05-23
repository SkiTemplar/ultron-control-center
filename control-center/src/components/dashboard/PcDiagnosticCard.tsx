// PC Diagnostic summary — fires the native diagnostic on mount and shows a
// one-line health summary. Clickable to deep-link into System -> Diagnostics.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DiagnosticReport, DiagSeverity } from "../../types";
import { Card, SmallButton, relativeTime } from "./Card";

interface PcDiagnosticCardProps {
  onOpenDiagnostics?: () => void;
}

function severityAccent(s: DiagSeverity): "ok" | "warn" | "danger" {
  if (s === "ok") return "ok";
  if (s === "warn") return "warn";
  return "danger";
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

  const accent = report ? severityAccent(report.max_severity) : "neutral";

  return (
    <Card
      title="PC diagnostic"
      accent={accent}
      loading={loading}
      error={error}
      action={
        <SmallButton onClick={onOpenDiagnostics} title="Open System / Diagnostics">
          open
        </SmallButton>
      }
    >
      {report && (
        <div className="space-y-1">
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
          <div className="grid grid-cols-3 gap-2 pt-1 text-[10.5px]">
            <Metric label="CPU" value={`${Math.round(report.system.cpu_usage_percent)}%`} />
            <Metric
              label="RAM"
              value={`${Math.round(report.system.ram_usage_percent)}%`}
            />
            <Metric
              label="Disk C"
              value={
                report.disks[0]
                  ? `${Math.round(report.disks[0].used_percent)}%`
                  : "-"
              }
            />
          </div>
          <div
            className="pt-1 text-[10.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Network:{" "}
            {report.network.reachable
              ? `online (${report.network.latency_ms ?? "?"}ms)`
              : "offline"}
          </div>
        </div>
      )}
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="rounded px-2 py-1"
      style={{
        background: "var(--color-surface-3)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div
        className="text-[9.5px] uppercase tracking-[0.05em]"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        {label}
      </div>
      <div
        className="text-[12px] font-semibold tabular-nums leading-tight"
        style={{ color: "var(--color-text)" }}
      >
        {value}
      </div>
    </div>
  );
}
