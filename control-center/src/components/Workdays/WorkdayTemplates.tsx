// Workdays - Templates lane.
//
// Renderiza las 7 plantillas de workflow como tarjetas clicables. Cuando
// USER hace click en una, primero elige el proyecto destino y luego se
// invoca `workday_start_with_template`, que crea (o devuelve si ya existe)
// el workday "in_progress" del dia para ese proyecto y siembra el prompt
// skeleton en el shared context.
//
// El componente NO crea workdays manuales: cada accion va por una plantilla.

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Workday, WorkflowTemplate } from "./types";

interface ProjectLite {
  id: string;
  name?: string | null;
  path?: string | null;
}

interface WorkdayTemplatesProps {
  // Callback cuando un workday se inicia (o se reutiliza el del dia).
  // Permite al padre saltar a la pestania "Today" automaticamente.
  onStarted: (wd: Workday) => void;
}

export function WorkdayTemplates({ onStarted }: WorkdayTemplatesProps) {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyTemplate, setBusyTemplate] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      invoke<WorkflowTemplate[]>("workday_list_templates"),
      invoke<ProjectLite[]>("list_projects"),
    ])
      .then(([tpls, projs]) => {
        if (cancelled) return;
        setTemplates(tpls);
        setProjects(projs);
        // Auto-pick the first project as a sensible default so the user can
        // click a template right away.
        if (projs.length > 0) setSelectedProject(projs[0].id);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const projectsById = useMemo(() => {
    const m = new Map<string, ProjectLite>();
    for (const p of projects) m.set(p.id, p);
    return m;
  }, [projects]);

  const handleStart = async (tpl: WorkflowTemplate) => {
    if (!selectedProject) {
      setError("Select a project before starting a workflow.");
      return;
    }
    setBusyTemplate(tpl.id);
    setError(null);
    try {
      const wd = await invoke<Workday>("workday_start_with_template", {
        projectId: selectedProject,
        templateId: tpl.id,
      });
      onStarted(wd);
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setBusyTemplate(null);
    }
  };

  if (loading) {
    return (
      <div
        className="flex h-full flex-1 items-center justify-center text-[12px]"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Loading templates...
      </div>
    );
  }

  return (
    <div
      className="flex h-full flex-1 flex-col gap-4 overflow-auto px-6 py-5"
      style={{ background: "var(--color-bg)" }}
    >
      <header className="flex flex-col gap-2">
        <h2
          className="text-[14px] font-semibold"
          style={{ color: "var(--color-text)" }}
        >
          Start a workflow
        </h2>
        <p
          className="text-[12px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Pick a project and click a workflow. The workday opens itself, seeds
          goals from the agent sequence and stores the prompt skeleton in
          shared context for the next session.
        </p>

        <div className="flex items-center gap-2 pt-2">
          <label
            className="text-[11px] font-semibold uppercase tracking-wider"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Project
          </label>
          <select
            value={selectedProject ?? ""}
            onChange={(ev) => setSelectedProject(ev.target.value || null)}
            className="rounded px-2 py-1 text-[12px]"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border)",
              minWidth: 220,
            }}
          >
            {projects.length === 0 && (
              <option value="">No registered projects</option>
            )}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name ?? p.id}
              </option>
            ))}
          </select>
          {selectedProject && projectsById.get(selectedProject)?.path && (
            <span
              className="truncate text-[11px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {projectsById.get(selectedProject)?.path}
            </span>
          )}
        </div>
      </header>

      {error && (
        <div
          className="rounded border px-3 py-2 text-[12px]"
          style={{
            borderColor: "var(--color-danger, #ef4444)",
            color: "var(--color-danger, #ef4444)",
            background: "var(--color-surface-1)",
          }}
        >
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {templates.map((tpl) => (
          <button
            key={tpl.id}
            type="button"
            onClick={() => void handleStart(tpl)}
            disabled={busyTemplate !== null || !selectedProject}
            className="flex flex-col items-start gap-2 rounded-lg border px-4 py-3 text-left transition-colors"
            style={{
              borderColor: "var(--color-border)",
              background: "var(--color-surface-1)",
              cursor:
                busyTemplate !== null || !selectedProject
                  ? "not-allowed"
                  : "pointer",
              opacity: busyTemplate && busyTemplate !== tpl.id ? 0.5 : 1,
            }}
          >
            <div className="flex w-full items-center justify-between">
              <span
                className="text-[14px] font-semibold"
                style={{ color: "var(--color-text)" }}
              >
                {tpl.name}
              </span>
              <span
                className="rounded px-1.5 py-0.5 text-[9px] font-mono uppercase"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-tertiary)",
                }}
              >
                {tpl.id}
              </span>
            </div>
            <span
              className="text-[12px]"
              style={{ color: "var(--color-text-secondary)" }}
            >
              {tpl.description}
            </span>
            <div
              className="flex flex-wrap gap-1 pt-1"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {tpl.agent_slugs.map((slug) => (
                <span
                  key={slug}
                  className="rounded px-1.5 py-0.5 text-[10px]"
                  style={{
                    background: "var(--color-surface-2)",
                    color: "var(--color-text-secondary)",
                    border: "1px solid var(--color-border)",
                  }}
                >
                  {slug}
                </span>
              ))}
            </div>
            {busyTemplate === tpl.id && (
              <span
                className="text-[11px]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                Starting workday...
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
