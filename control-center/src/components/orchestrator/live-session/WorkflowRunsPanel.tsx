// ULTRON Control Center — sección "Historial de workflows" del LiveSessionMonitor.
//
// Wiring 2026-08-11 (audit 08-09 #32): workflow-runs.db se inicializaba en cada
// boot pero sus comandos jamás se registraron y NADA escribía — tabla vacía
// para siempre. Ahora el escritor es la delegación síncrona (delegate.rs abre
// un run "delegate:<agent>" y lo cierra con status/summary), y esta sección es
// el punto de consumo: últimos runs + workflows disponibles (built-in + YAML de
// ~/.ultron/cockpit/workflows/ vía workflow_load_user_defined).
//
// Backend: workflow_get_runs / workflow_load_user_defined (registrados hoy).

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SectionLabel, fmtTime } from "../../sessions/orchShared";

interface WorkflowRun {
  id: number;
  workflow_id: string;
  project_id: string | null;
  started_at: string;
  ended_at: string | null;
  status: "running" | "success" | "failed" | "cancelled";
  steps_completed: number;
  steps_total: number;
  output_summary: string;
  error: string | null;
}

interface WorkflowDefinition {
  id: string;
  label?: string;
  description?: string;
}

const STATUS_TINT: Record<WorkflowRun["status"], string> = {
  running: "#3b82f6",
  success: "var(--color-success, #3fb950)",
  failed: "var(--color-danger, #ef4444)",
  cancelled: "var(--color-text-faint)",
};

function durationLabel(run: WorkflowRun): string {
  if (!run.ended_at) return "en curso";
  const ms = new Date(run.ended_at).getTime() - new Date(run.started_at).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

export function WorkflowRunsPanel() {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [workflowCount, setWorkflowCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = (await invoke("workflow_get_runs", { limit: 12 })) as WorkflowRun[];
      setRuns(r ?? []);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
    try {
      const defs = (await invoke("workflow_load_user_defined")) as WorkflowDefinition[];
      setWorkflowCount(defs?.length ?? null);
    } catch {
      setWorkflowCount(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>Historial de workflows</SectionLabel>
        <button
          type="button"
          onClick={() => void load()}
          className="text-[9.5px] underline-offset-2 hover:underline"
          style={{ color: "var(--color-text-faint)", background: "transparent", border: "none" }}
        >
          refrescar
        </button>
      </div>
      <p className="mb-1 text-[9px]" style={{ color: "var(--color-text-faint)" }}>
        Runs persistidos en workflow-runs.db (escritor: delegación síncrona)
        {workflowCount !== null ? ` · ${workflowCount} workflows disponibles (built-in + YAML)` : ""}.
      </p>

      {error && (
        <p className="text-[10px]" style={{ color: "var(--color-danger, #ef4444)" }}>
          {error}
        </p>
      )}

      {!error && runs.length === 0 && (
        <p className="text-[10px]" style={{ color: "var(--color-text-tertiary)" }}>
          Sin runs todavía — se registran cuando la app delega tareas a agentes.
        </p>
      )}

      <div className="flex flex-col gap-1">
        {runs.map((r) => (
          <div key={r.id} className="flex flex-col gap-0.5">
            <div className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5">
                <span
                  className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: STATUS_TINT[r.status] }}
                  title={r.status}
                  aria-hidden
                />
                <span
                  className="truncate text-[11px]"
                  style={{ color: "var(--color-text)", fontFamily: "var(--font-mono)" }}
                >
                  {r.workflow_id}
                </span>
                {r.project_id && (
                  <span className="truncate text-[9px]" style={{ color: "var(--color-text-faint)" }}>
                    {r.project_id}
                  </span>
                )}
              </span>
              <span
                className="shrink-0 text-[9.5px] tabular-nums"
                style={{ color: "var(--color-text-faint)", fontFamily: "var(--font-mono)" }}
              >
                {r.steps_total > 0 ? `${r.steps_completed}/${r.steps_total} · ` : ""}
                {durationLabel(r)} · {fmtTime(r.started_at)}
              </span>
            </div>
            {(r.error || r.output_summary) && (
              <p
                className="truncate text-[10px]"
                style={{
                  color: r.error ? "var(--color-danger, #ef4444)" : "var(--color-text-tertiary)",
                }}
                title={r.error ?? r.output_summary}
              >
                {r.error ?? r.output_summary}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
