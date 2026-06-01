// ULTRON Control Center 2.0 — Per-project workspace shell (V1)
//
// Renders the identity header (project name + path), the V1 quick-action row
// (ProjectQuickActions: Folder / IDE / AI session / Run Batch / Launch all),
// a Detach-to-window button, and the project Kanban board. Everything else
// (sub-tabs, embedded terminal, agents/context/sessions/notes/timeline/
// decisions panels, the dashboard-v2 path) was removed in the V1 redesign.

import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ExternalLink } from "./icons";
import ProjectBoard from "./ProjectBoard";
import { type BatchToast } from "./BatchDropdown";
import { ProjectQuickActions } from "./ProjectQuickActions";
import type { ProjectInfo } from "../../types";

type Props = {
  projectId: string;
};

type ProjectMeta = {
  id: string;
  name: string;
  path: string;
};

type ProjectListEntry = {
  id: string;
  name: string | null;
  path: string | null;
};

// Shared visual style for every header action button.
const HEADER_BTN =
  "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-40";
const HEADER_BTN_STYLE: React.CSSProperties = {
  borderColor: "rgba(255,255,255,0.10)",
  background: "transparent",
  color: "var(--color-text-muted)",
};

export default function ProjectWorkspace({ projectId }: Props) {
  const [meta, setMeta] = useState<ProjectMeta | null>(null);
  const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [batchToast, setBatchToast] = useState<BatchToast | null>(null);

  // Auto-fade batch toast after 6s.
  useEffect(() => {
    if (!batchToast) return;
    const t = window.setTimeout(() => setBatchToast(null), 6000);
    return () => window.clearTimeout(t);
  }, [batchToast]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // No dedicated `projects_get` exists in the backend; fetch the list
        // and filter locally. Cheap enough for the typical project count.
        const list = (await invoke("list_projects")) as ProjectListEntry[];
        const found = list.find((p) => p.id === projectId);
        if (!cancelled) {
          if (found && found.path) {
            setMeta({
              id: found.id,
              name: found.name ?? found.id,
              path: found.path,
            });
            setProjectInfo(found as unknown as ProjectInfo);
          } else {
            setError(`project ${projectId} not found`);
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

  const detachToWindow = async () => {
    if (!meta) return;
    try {
      // Backend reuses an existing detached window when present, otherwise
      // spawns a new 1000x700 window pointed at /detached/project?id=...
      // Closing the standalone window emits `project:reattached` back to
      // the main window so the tab strip can re-add the project tab.
      await invoke("detach_project_window", { projectId: meta.id });
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* ------------------------------------------------------------------ */}
      {/* Header — pure black, all action buttons at the same visual level.   */}
      {/* ------------------------------------------------------------------ */}
      <div
        className="flex items-center justify-between border-b px-4 py-2"
        style={{
          background: "#000000",
          borderColor: "rgba(255,255,255,0.08)",
        }}
      >
        {/* Project identity */}
        <div className="min-w-0 flex-1 pr-4">
          <h2
            className="truncate text-[13px] font-semibold leading-tight tracking-tight"
            style={{ color: "var(--color-text)" }}
          >
            {meta?.name ?? projectId}
          </h2>
          {meta && (
            <p
              className="mt-0.5 truncate text-[10px] font-mono leading-none"
              style={{ color: "rgba(255,255,255,0.30)" }}
            >
              {meta.path}
            </p>
          )}
        </div>

        {/* Quick actions — fuente única ProjectQuickActions + Detach */}
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {projectInfo && (
            <ProjectQuickActions
              project={projectInfo}
              density="compact"
              onBatchResult={setBatchToast}
            />
          )}
          <HeaderBtn
            onClick={detachToWindow}
            disabled={!meta}
            title="Abrir este proyecto en ventana independiente (multi-monitor)"
          >
            <ExternalLink size={12} />
            Detach
          </HeaderBtn>
        </div>
      </div>

      {/* Batch toast — rendered just below the header so it doesn't overlap content */}
      {batchToast && (
        <div
          className="flex items-center gap-2 border-b px-4 py-1.5 text-[11px]"
          style={{
            background: "#000000",
            borderColor: batchToast.kind === "ok"
              ? "rgba(34,197,94,0.30)"
              : "rgba(239,68,68,0.30)",
            color: batchToast.kind === "ok"
              ? "var(--color-success, #22c55e)"
              : "var(--color-danger, #ef4444)",
          }}
          title={batchToast.body}
        >
          <strong>{batchToast.title}</strong>
          {batchToast.body && (
            <span style={{ color: "rgba(255,255,255,0.45)" }}>
              {batchToast.body.slice(0, 200)}
              {batchToast.body.length > 200 ? "…" : ""}
            </span>
          )}
          <button
            onClick={() => setBatchToast(null)}
            className="ml-auto rounded p-0.5 opacity-60 hover:opacity-100"
            style={{ color: "inherit" }}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {error && (
        <div className="border-b border-[var(--color-error)] bg-[var(--color-surface-2)] px-3 py-1 text-xs text-[var(--color-error)]">
          {error}
        </div>
      )}

      {/* Body — the project Kanban board fills the workspace. */}
      <div className="flex-1 overflow-hidden">
        <ProjectBoard projectId={projectId} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HeaderBtn — shared visual primitive for all header action buttons.
// Keeps every button pixel-identical without repeating class strings.
// ---------------------------------------------------------------------------

type HeaderBtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  children: React.ReactNode;
};

function HeaderBtn({ children, style: _style, ...rest }: HeaderBtnProps) {
  return (
    <button
      type="button"
      {...rest}
      className={HEADER_BTN}
      style={HEADER_BTN_STYLE}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background =
          "rgba(255,255,255,0.05)";
        (e.currentTarget as HTMLButtonElement).style.color =
          "var(--color-text)";
        (e.currentTarget as HTMLButtonElement).style.borderColor =
          "rgba(255,255,255,0.20)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = "transparent";
        (e.currentTarget as HTMLButtonElement).style.color =
          "var(--color-text-muted)";
        (e.currentTarget as HTMLButtonElement).style.borderColor =
          "rgba(255,255,255,0.10)";
      }}
    >
      {children}
    </button>
  );
}
