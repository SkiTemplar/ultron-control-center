// ULTRON Control Center 2.0 — Per-project workspace (Dashboard V2)
//
// Layout:
//   1. Identity bar — back button + project name/path + detach
//   2. Dashboard — "Acciones rapidas": 2 primary cards + secondary tiles
//   3. Kanban board — fills all remaining space (flex-1 min-h-0)
//
// Design: no emojis, SVG icons from ./icons, semantic color tokens.

import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { Bot, Folder, Play, ExternalLink } from "./icons";
import ProjectBoard from "./ProjectBoard";
import BatchDropdown, { type BatchToast } from "./BatchDropdown";
import { useProjectsTabs } from "../../state/ProjectsTabsContext";
import type { ProjectInfo, SessionProvider } from "../../types";
import { providerBadge } from "./utils";

// ---------------------------------------------------------------------------
// Inline icons not yet in icons.tsx
// ---------------------------------------------------------------------------

function ChevronLeft({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function CodeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Props = { projectId: string };

type ProjectMeta = { id: string; name: string; path: string };

type ProjectListEntry = {
  id: string;
  name: string | null;
  path: string | null;
};

// ---------------------------------------------------------------------------
// PrimaryCard — Claude/AI + Kanban (large, 2-column)
// ---------------------------------------------------------------------------

interface PrimaryCardProps {
  icon: React.ReactNode;
  label: string;
  sub: string;
  tint: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}

function PrimaryCard({
  icon,
  label,
  sub,
  tint,
  onClick,
  disabled = false,
  title,
}: PrimaryCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex flex-1 flex-col gap-3 rounded-lg p-4 text-left transition-colors disabled:opacity-40"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
        minHeight: 88,
        minWidth: 0,
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = "var(--color-surface-3)";
        e.currentTarget.style.borderColor = "var(--color-border-strong)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "var(--color-surface-2)";
        e.currentTarget.style.borderColor = "var(--color-border)";
      }}
    >
      {/* Icon pill */}
      <div
        className="flex h-8 w-8 items-center justify-center rounded-md"
        style={{
          background: "var(--color-surface-1)",
          border: "1px solid var(--color-border)",
          color: tint,
        }}
      >
        {icon}
      </div>

      {/* Text */}
      <div>
        <div
          className="text-[13px] font-semibold leading-tight"
          style={{ color: "var(--color-text)" }}
        >
          {label}
        </div>
        <div
          className="mt-0.5 text-[11px] leading-snug"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {sub}
        </div>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// SecTile — IDE, Folder, Executables (secondary row, compact)
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// ProjectWorkspace
// ---------------------------------------------------------------------------

export default function ProjectWorkspace({ projectId }: Props) {
  const [meta, setMeta] = useState<ProjectMeta | null>(null);
  const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [batchToast, setBatchToast] = useState<BatchToast | null>(null);

  const tabsCtx = useProjectsTabs();

  // Auto-fade toast after 6s
  useEffect(() => {
    if (!batchToast) return;
    const t = window.setTimeout(() => setBatchToast(null), 6000);
    return () => window.clearTimeout(t);
  }, [batchToast]);

  // Load project meta from registry
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = (await invoke("list_projects")) as ProjectListEntry[];
        const found = list.find((p) => p.id === projectId);
        if (!cancelled) {
          if (found && found.path) {
            setMeta({ id: found.id, name: found.name ?? found.id, path: found.path });
            setProjectInfo(found as unknown as ProjectInfo);
          } else {
            setError(`Proyecto ${projectId} no encontrado`);
          }
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Provider badge for the AI session button
  const provider: SessionProvider =
    (projectInfo?.default_provider as SessionProvider | null | undefined) ??
    "claude";
  const badge = providerBadge(provider);
  const executables = projectInfo?.executables ?? [];

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleBack = () => tabsCtx.close(projectId);

  const handleAi = async () => {
    if (!meta) return;
    try {
      await invoke("spawn_session", {
        provider,
        cwd: meta.path,
        prompt: null,
        flags: { dangerouslySkipPermissions: false },
      });
    } catch {
      /* silencioso */
    }
  };


  const handleIde = async () => {
    if (!meta) return;
    try {
      await invoke("open_project_in_ide", {
        path: meta.path,
        preferredIde: projectInfo?.ide ?? null,
      });
    } catch {
      /* silencioso */
    }
  };

  const handleFolder = async () => {
    if (!meta) return;
    try {
      await openPath(meta.path);
    } catch {
      /* silencioso */
    }
  };

  const handleDetach = async () => {
    if (!meta) return;
    try {
      await invoke("detach_project_window", { projectId: meta.id });
    } catch (e) {
      setError(String(e));
    }
  };

  const handleExe = async (path: string) => {
    try {
      await openPath(path);
    } catch {
      /* silencioso */
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      className="flex h-full flex-col"
      style={{ background: "var(--color-surface-1)" }}
    >
      {/* ── 1. Identity bar ─────────────────────────────────────────────── */}
      <div
        className="flex shrink-0 items-center gap-2 border-b px-4 py-2"
        style={{
          borderColor: "var(--color-border)",
          background: "var(--color-surface-2)",
        }}
      >
        {/* Back to projects */}
        <button
          type="button"
          onClick={handleBack}
          className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors"
          style={{ color: "var(--color-text-tertiary)", background: "transparent" }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--color-text)";
            e.currentTarget.style.background = "var(--color-surface-3)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "var(--color-text-tertiary)";
            e.currentTarget.style.background = "transparent";
          }}
          title="Volver a la lista de proyectos"
        >
          <ChevronLeft size={12} />
          Projects
        </button>

        <span
          aria-hidden
          className="select-none text-[13px]"
          style={{ color: "var(--color-border-strong)" }}
        >
          /
        </span>

        {/* Project name */}
        <div className="min-w-0 flex-1">
          <span
            className="text-[13px] font-semibold"
            style={{ color: "var(--color-text)" }}
          >
            {meta?.name ?? projectId}
          </span>
          {meta?.path && (
            <span
              className="ml-2 truncate text-[10.5px]"
              style={{
                fontFamily: "var(--font-mono)",
                color: "var(--color-text-tertiary)",
              }}
              title={meta.path}
            >
              {meta.path}
            </span>
          )}
        </div>

        {/* Detach */}
        <button
          type="button"
          onClick={handleDetach}
          disabled={!meta}
          className="flex shrink-0 items-center gap-1.5 rounded px-2 py-1 text-[11px] transition-colors disabled:opacity-40"
          style={{
            color: "var(--color-text-tertiary)",
            border: "1px solid var(--color-border)",
            background: "transparent",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--color-text)";
            e.currentTarget.style.borderColor = "var(--color-border-strong)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "var(--color-text-tertiary)";
            e.currentTarget.style.borderColor = "var(--color-border)";
          }}
          title="Abrir en ventana independiente"
        >
          <ExternalLink size={11} />
          Detach
        </button>
      </div>

      {/* ── 2. Dashboard — Acciones rapidas ─────────────────────────────── */}
      <div
        className="shrink-0 border-b px-5 py-4"
        style={{ borderColor: "var(--color-border)" }}
      >
        {/* Section label */}
        <p
          className="mb-3 text-[10px] font-semibold uppercase tracking-[0.08em]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Acciones rapidas
        </p>

        {/* Todos los botones como cards iguales */}
        <div className="flex flex-wrap gap-3">
          <PrimaryCard
            icon={<Bot size={16} />}
            label={badge.label}
            sub="Iniciar sesion de IA"
            tint={badge.tint}
            onClick={handleAi}
            disabled={!meta}
            title={`Lanzar sesion ${badge.label} en este proyecto`}
          />
          <PrimaryCard
            icon={<CodeIcon size={16} />}
            label="IDE"
            sub={projectInfo?.ide ?? "Editor preferido"}
            tint="var(--color-text-secondary)"
            onClick={handleIde}
            disabled={!meta}
            title="Abrir en IDE preferido"
          />
          <PrimaryCard
            icon={<Folder size={16} />}
            label="Folder"
            sub="Abrir en Explorer"
            tint="var(--color-text-secondary)"
            onClick={handleFolder}
            disabled={!meta}
            title="Abrir carpeta del proyecto"
          />
          <BatchDropdown onResult={setBatchToast} cardStyle />
          {executables.map((exe, i) => (
            <PrimaryCard
              key={i}
              icon={<Play size={16} />}
              label={exe.name || "Launch"}
              sub={exe.path.split(/[/\\]/).pop() ?? exe.path}
              tint="var(--color-success, #3fb950)"
              onClick={() => void handleExe(exe.path)}
              title={exe.path}
            />
          ))}
        </div>
      </div>

      {/* Batch result toast */}
      {batchToast && (
        <div
          className="flex shrink-0 items-center gap-2 border-b px-4 py-1.5 text-[11px]"
          style={{
            borderColor:
              batchToast.kind === "ok"
                ? "rgba(63,185,80,0.30)"
                : "rgba(239,68,68,0.30)",
            color:
              batchToast.kind === "ok"
                ? "var(--color-success, #3fb950)"
                : "var(--color-danger, #ef4444)",
          }}
        >
          <strong className="shrink-0">{batchToast.title}</strong>
          {batchToast.body && (
            <span
              className="min-w-0 truncate"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {batchToast.body.slice(0, 200)}
              {batchToast.body.length > 200 ? "…" : ""}
            </span>
          )}
          <button
            onClick={() => setBatchToast(null)}
            className="ml-auto flex h-4 w-4 shrink-0 items-center justify-center rounded opacity-60 transition-opacity hover:opacity-100"
            aria-label="Cerrar notificacion"
            style={{ color: "inherit" }}
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              aria-hidden
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}

      {error && (
        <div
          className="shrink-0 border-b px-4 py-2 text-[11.5px]"
          style={{
            borderColor: "rgba(239,68,68,0.30)",
            color: "var(--color-danger, #ef4444)",
          }}
        >
          {error}
        </div>
      )}

      {/* ── 3. Kanban board — fills all remaining space ──────────────────── */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <ProjectBoard projectId={projectId} />
      </div>
    </div>
  );
}
