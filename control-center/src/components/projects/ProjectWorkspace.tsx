// ULTRON Control Center 2.0 — Per-project workspace shell
//
// Renders the header (project name + quick actions) and the sub-tab bar
// (Board / Terminal / Agents / Context / Sessions). The active sub-view is
// rendered by ProjectBoard / ProjectTerminal / ProjectAgents / ProjectContext
// / ProjectSessions.

import { useEffect, useState, type ComponentType } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Bot,
  BookOpen,
  Clock,
  ExternalLink,
  FolderOpen,
  Kanban,
  Layers,
  Terminal as TerminalIcon,
  Notebook,
  History,
} from "./icons";
import type { ProjectSubTab } from "../../types";
import ProjectBoard from "./ProjectBoard";
import ProjectTerminal from "./ProjectTerminal";
import ProjectAgents from "./ProjectAgents";
import ProjectContext from "./ProjectContext";
import ProjectSessions from "./ProjectSessions";
import ProjectNotes from "./ProjectNotes";
import ProjectTimeline from "./ProjectTimeline";
import { useProjectsTabs } from "../../state/ProjectsTabsContext";

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

const TABS: { id: ProjectSubTab; label: string; Icon: ComponentType<{ size?: number }> }[] = [
  { id: "board", label: "Board", Icon: Kanban },
  { id: "terminal", label: "Terminal", Icon: TerminalIcon },
  { id: "agents", label: "Agents", Icon: Bot },
  { id: "context", label: "Context", Icon: Notebook },
  { id: "sessions", label: "Sessions", Icon: History },
  // v2.x: Notes (freeform markdown editor, file: cockpit/projects/<id>/notes.md)
  // and Timeline (read-only chronological feed: kanban moves + sessions + backups).
  { id: "notes", label: "Notes", Icon: BookOpen },
  { id: "timeline", label: "Timeline", Icon: Clock },
];

export default function ProjectWorkspace({ projectId }: Props) {
  const { consumeInitialSubTab } = useProjectsTabs();
  // Read deep-link hint from the home grid's "Open terminal" / "Open AI"
  // shortcuts ONCE on mount. After that, the user drives the sub-tab.
  const [subTab, setSubTab] = useState<ProjectSubTab>(
    () => consumeInitialSubTab(projectId) ?? "board",
  );
  const [meta, setMeta] = useState<ProjectMeta | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const openInIde = async () => {
    if (!meta) return;
    try {
      await invoke("open_project_in_ide", { id: meta.id });
    } catch (e) {
      setError(String(e));
    }
  };

  const openFolder = async () => {
    if (!meta) return;
    try {
      // `open_project` opens the folder via the configured launcher; this is
      // the closest existing handler to a "reveal in file manager" action.
      await invoke("open_project", { id: meta.id });
    } catch (e) {
      setError(String(e));
    }
  };

  const spawnRaw = async (provider: "claude" | "codex" | "gemini") => {
    if (!meta) return;
    try {
      await invoke("pty_spawn", {
        projectId,
        cardId: null,
        provider,
        agent: null,
        cwd: meta.path,
        prompt: null,
      });
      setSubTab("terminal");
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface-1)] px-4 py-2">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">
            {meta?.name ?? projectId}
          </h2>
          {meta && (
            <p className="truncate text-xs text-[var(--color-text-muted)]">
              {meta.path}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={openInIde}
            disabled={!meta}
            className="flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-surface-2)] disabled:opacity-40"
          >
            <ExternalLink size={11} /> IDE
          </button>
          <button
            onClick={openFolder}
            disabled={!meta}
            className="flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-surface-2)] disabled:opacity-40"
          >
            <FolderOpen size={11} /> Folder
          </button>
          <div className="mx-1 h-4 w-px bg-[var(--color-border)]" />
          <button
            onClick={() => spawnRaw("claude")}
            disabled={!meta}
            className="flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-surface-2)] disabled:opacity-40"
          >
            <Layers size={11} /> claude
          </button>
          <button
            onClick={() => spawnRaw("codex")}
            disabled={!meta}
            className="flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-surface-2)] disabled:opacity-40"
          >
            <Layers size={11} /> codex
          </button>
          <button
            onClick={() => spawnRaw("gemini")}
            disabled={!meta}
            className="flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-surface-2)] disabled:opacity-40"
          >
            <Layers size={11} /> gemini
          </button>
        </div>
      </div>

      {/* Sub-tab bar */}
      <div className="flex items-center gap-0.5 border-b border-[var(--color-border)] bg-[var(--color-surface-0)] px-2">
        {TABS.map(({ id, label, Icon }) => {
          const active = subTab === id;
          return (
            <button
              key={id}
              onClick={() => setSubTab(id)}
              className={[
                "flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-xs",
                active
                  ? "border-[var(--color-accent)] text-[var(--color-text)]"
                  : "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]",
              ].join(" ")}
            >
              <Icon size={12} />
              {label}
            </button>
          );
        })}
      </div>

      {error && (
        <div className="border-b border-[var(--color-error)] bg-[var(--color-surface-2)] px-3 py-1 text-xs text-[var(--color-error)]">
          {error}
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-hidden">
        {subTab === "board" && <ProjectBoard projectId={projectId} />}
        {subTab === "terminal" && <ProjectTerminal projectId={projectId} />}
        {subTab === "agents" && <ProjectAgents projectId={projectId} />}
        {subTab === "context" && (
          <ProjectContext projectId={projectId} projectPath={meta?.path ?? ""} />
        )}
        {subTab === "sessions" && (
          <ProjectSessions projectId={projectId} projectPath={meta?.path ?? ""} />
        )}
        {subTab === "notes" && <ProjectNotes projectId={projectId} />}
        {subTab === "timeline" && (
          <ProjectTimeline projectId={projectId} projectPath={meta?.path} />
        )}
      </div>
    </div>
  );
}
