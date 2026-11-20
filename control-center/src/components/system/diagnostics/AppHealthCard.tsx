// Diagnostics — App Health Card (compact)

import type { DiagnosticReport } from "../../../types";

function HealthRow({ k, v, ok }: { k: string; v: string; ok: boolean }) {
  const color = ok ? "var(--color-success)" : "var(--color-warn)";
  // Stacked label over value: with justify-between in a multi-column grid each
  // value ended up glued to the next cell label ("in PATH codex").
  return (
    <div className="flex min-w-0 flex-col gap-0.5 text-[12px]">
      <span style={{ color: "var(--color-text-tertiary)" }}>{k}</span>
      <span className="truncate font-mono" style={{ color }} title={v}>{v}</span>
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
        Salud de la aplicación
      </div>
      <div className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
        <HealthRow k="claude" v={report.app.claude_in_path ? "en el PATH" : "no encontrado"} ok={report.app.claude_in_path} />
        <HealthRow k="codex" v={report.app.codex_in_path ? "en el PATH" : "no encontrado"} ok={report.app.codex_in_path} />
        <HealthRow k="projects.json" v={report.app.projects_json_ok ? "ok" : "falta o está corrupto"} ok={report.app.projects_json_ok} />
      </div>
    </div>
  );
}
