// ActiveProjectCard — hero del Dashboard Cockpit.
//
// Muestra el proyecto con last_active más reciente (misma lógica que
// PendingKanbanCard). Incluye nombre, path, estado, ProjectQuickActions
// en density="full" y una fila de intents rápidos (Recall / Fix / Free)
// que lanzan directamente spawn_session con el prompt del intent.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectInfo } from "../../types";
import { ProjectQuickActions } from "../projects/ProjectQuickActions";
import { statusBadge } from "../projects/utils";

interface ActiveProjectCardProps {
  onOpenProjects?: () => void;
}

type IntentConfig = {
  id: string;
  label: string;
  prompt: string;
  accentRgb: string;
};

const INTENTS: IntentConfig[] = [
  {
    id: "recall",
    label: "Recall",
    prompt:
      "Recupera el contexto del último workday. Lee mem0 search query=cwd últimas 24h, git log --since=24h, kanban In Progress. Resume y propón siguiente acción.",
    accentRgb: "245,158,11",
  },
  {
    id: "fix",
    label: "Fix",
    prompt:
      "Analiza errores conocidos del proyecto. Empieza por: leer CLAUDE.md, git log -10, lint/typecheck si aplica. Reporta top 3 issues a priorizar.",
    accentRgb: "239,68,68",
  },
  {
    id: "free",
    label: "Free",
    prompt: "",
    accentRgb: "132,204,22",
  },
];

export function ActiveProjectCard({ onOpenProjects }: ActiveProjectCardProps) {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyIntent, setBusyIntent] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const projects = await invoke<ProjectInfo[]>("list_projects");
        const sorted = projects
          .slice()
          .sort((a, b) => {
            const at = a.last_active ?? "";
            const bt = b.last_active ?? "";
            return at < bt ? 1 : at > bt ? -1 : 0;
          });
        if (!cancelled) setProject(sorted[0] ?? null);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  async function launchIntent(intent: IntentConfig) {
    if (!project || busyIntent) return;
    setBusyIntent(intent.id);
    try {
      await invoke("spawn_session", {
        provider: "claude",
        cwd: project.path ?? null,
        prompt: intent.prompt || null,
        flags: { dangerouslySkipPermissions: false },
      });
    } catch { /* silencioso */ } finally {
      setBusyIntent(null);
    }
  }

  if (loading) {
    return (
      <div
        className="flex items-center rounded-md px-5 py-4"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border)",
          minHeight: 120,
        }}
      >
        <span className="text-[13px]" style={{ color: "var(--color-text-faint)" }}>
          Cargando proyecto activo…
        </span>
      </div>
    );
  }

  if (error || !project) {
    return (
      <div
        className="flex flex-col gap-2 rounded-md px-5 py-4"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border)",
          minHeight: 120,
        }}
      >
        <p className="text-[13px]" style={{ color: "var(--color-text-faint)" }}>
          {error ?? "Sin proyecto activo."}
        </p>
        {onOpenProjects && (
          <button
            type="button"
            onClick={onOpenProjects}
            className="rounded px-3 py-1 text-[12px] font-medium transition-colors"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
              width: "fit-content",
            }}
          >
            Ver proyectos
          </button>
        )}
      </div>
    );
  }

  const b = statusBadge(project.status);

  return (
    <div
      className="flex flex-col gap-4 rounded-md px-5 py-4"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
        borderLeft: "3px solid var(--color-accent)",
      }}
    >
      {/* Cabecera del proyecto */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className="rounded px-1.5 py-px text-[9.5px] font-medium uppercase tracking-wide"
              style={{ background: b.bg, color: b.color }}
            >
              {b.label}
            </span>
            <span className="text-[10px] uppercase tracking-[0.08em]" style={{ color: "var(--color-text-faint)" }}>
              Proyecto activo
            </span>
          </div>
          <h2
            className="mt-1.5 truncate text-[18px] font-semibold leading-tight"
            style={{ color: "var(--color-text)" }}
            title={project.name ?? project.id}
          >
            {project.name ?? project.id}
          </h2>
          {project.path && (
            <p
              className="mt-0.5 truncate text-[11px]"
              style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-tertiary)" }}
              title={project.path}
            >
              {project.path}
            </p>
          )}
        </div>
        {onOpenProjects && (
          <button
            type="button"
            onClick={onOpenProjects}
            className="shrink-0 rounded px-2.5 py-1 text-[11px] font-medium transition-colors"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            Proyectos
          </button>
        )}
      </div>

      {/* Acciones rápidas del proyecto */}
      <ProjectQuickActions project={project} density="full" />

      {/* Fila de intents rápidos */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10.5px] uppercase tracking-[0.07em]" style={{ color: "var(--color-text-faint)" }}>
          Intent:
        </span>
        {INTENTS.map((intent) => (
          <button
            key={intent.id}
            type="button"
            disabled={!!busyIntent}
            onClick={() => void launchIntent(intent)}
            className="rounded px-3 py-1 text-[12px] font-medium transition-colors disabled:opacity-40"
            style={{
              background: `rgba(${intent.accentRgb}, 0.08)`,
              color: `rgb(${intent.accentRgb})`,
              border: `1px solid rgba(${intent.accentRgb}, 0.30)`,
            }}
            title={intent.prompt || `Sesión libre en ${project.name ?? project.id}`}
          >
            {busyIntent === intent.id ? "…" : intent.label}
          </button>
        ))}
      </div>
    </div>
  );
}
