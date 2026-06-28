// Diagnostics — App Health Card (compact)

import type { DiagnosticReport } from "../../../types";

function HealthRow({ k, v, ok }: { k: string; v: string; ok: boolean }) {
  return (
    <div className="flex justify-between text-[12px]">
      <span style={{ color: "var(--color-text-tertiary)" }}>{k}</span>
      <span className="font-mono" style={{ color: ok ? "var(--color-success)" : "var(--color-warn)" }}>{v}</span>
    </div>
  );
}

export function AppHealthCard({ report }: { report: DiagnosticReport }) {
  const sev = report.app.severity;
  const border =
    sev === "error"
      ? "border-red-500/40 bg-red-500/10"
      : sev === "warn"
      ? "border-amber-500/30 bg-amber-500/5"
      : "border-emerald-500/30 bg-emerald-500/5";
  const glyph =
    sev === "error"
      ? { ch: "✕", color: "text-red-400" }
      : sev === "warn"
      ? { ch: "!", color: "text-amber-400" }
      : { ch: "✓", color: "text-emerald-400" };

  return (
    <div className={`rounded border p-3 ${border}`}>
      <div className="mb-1.5 flex items-center gap-2 text-[13px] font-semibold">
        <span className={`font-mono ${glyph.color}`}>{glyph.ch}</span>
        App health
      </div>
      <div className="grid gap-1 sm:grid-cols-3">
        <HealthRow k="claude" v={report.app.claude_in_path ? "in PATH" : "missing"} ok={report.app.claude_in_path} />
        <HealthRow k="codex" v={report.app.codex_in_path ? "in PATH" : "missing"} ok={report.app.codex_in_path} />
        <HealthRow k="qdrant" v={report.app.qdrant_running ? "running (:6333)" : "not reachable"} ok={report.app.qdrant_running} />
        <HealthRow k="projects.json" v={report.app.projects_json_ok ? "ok" : "missing/corrupt"} ok={report.app.projects_json_ok} />
      </div>
    </div>
  );
}
