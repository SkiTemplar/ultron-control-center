// ULTRON Control Center 2.0 — Per-project workspace shell
//
// Renders the header (project name + quick actions) and the sub-tab bar
// (Board / Terminal / Agents / Context / Sessions). The active sub-view is
// rendered by ProjectBoard / ProjectTerminal / ProjectAgents / ProjectContext
// / ProjectSessions.

import React, { useEffect, useRef, useState, type ComponentType } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  Bot,
  BookOpen,
  Clock,
  ExternalLink,
  FolderOpen,
  Kanban,
  Terminal as TerminalIcon,
  Notebook,
  History,
  Sparkles,
} from "./icons";
import type { ProjectSubTab } from "../../types";
import ProjectBoard from "./ProjectBoard";
import ProjectTerminal from "./ProjectTerminal";
import ProjectAgents from "./ProjectAgents";
import ProjectContext from "./ProjectContext";
import ProjectSessions from "./ProjectSessions";
import ProjectNotes from "./ProjectNotes";
import ProjectTimeline from "./ProjectTimeline";
import ProjectJarvisLauncher, { type JarvisIntent } from "./ProjectJarvisLauncher";
import { useProjectsTabs } from "../../state/ProjectsTabsContext";
import { type BatchToast } from "./BatchDropdown";

type Props = {
  projectId: string;
};

type ProjectMeta = {
  id: string;
  name: string;
  path: string;
  /** When set, terminals open here instead of `path`. Mirrors fb-016 field. */
  terminalCwd: string;
};

type ProjectListEntry = {
  id: string;
  name: string | null;
  path: string | null;
  /** fb-016: when set, takes precedence over `path` for terminal cwd. */
  parent_folder_override?: string | null;
};

// ---------------------------------------------------------------------------
// Tab badge counts — agents (pinned), sessions (today for this project).
// Context count is skipped (no cheap single-call backend command available).
// ---------------------------------------------------------------------------

type TabCounts = {
  agents: number | null;
  sessions: number | null;
};

type PinnedAgentsWire = { pinned: string[]; roles?: Record<string, string> };
type SessionSummaryWire = { session_id: string; path: string; modified_at: string };

/** Returns counts for the badge-able tabs, silently returning null on error. */
async function fetchTabCounts(
  projectId: string,
  projectPath: string,
): Promise<TabCounts> {
  let agents: number | null = null;
  let sessions: number | null = null;

  try {
    const pa = (await invoke("agents_pinned_load", { projectId })) as PinnedAgentsWire;
    agents = pa.pinned.length;
  } catch {
    // silently ignore
  }

  try {
    if (projectPath) {
      const list = (await invoke("project_sessions_list", {
        projectPath,
      })) as SessionSummaryWire[];
      // Count sessions whose modified_at is today (local date).
      const todayPrefix = new Date().toISOString().slice(0, 10);
      sessions = list.filter((s) => s.modified_at.startsWith(todayPrefix)).length;
    }
  } catch {
    // silently ignore
  }

  return { agents, sessions };
}

// ---------------------------------------------------------------------------
// TabBadge — small pill chip shown next to a tab label.
// Only rendered when count > 0. Errors / null silently hide it.
// ---------------------------------------------------------------------------

function TabBadge({ count }: { count: number | null }) {
  if (!count || count <= 0) return null;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        height: 14,
        padding: "0 4px",
        borderRadius: 9999,
        background: "rgba(255,255,255,0.08)",
        fontSize: 9.5,
        color: "var(--color-text-tertiary)",
        fontVariantNumeric: "tabular-nums",
        lineHeight: 1,
      }}
    >
      {count}
    </span>
  );
}

const TABS: { id: ProjectSubTab; label: string; Icon: ComponentType<{ size?: number }> }[] = [
  // v2.9.8: Ultron is the default landing — pick an intent (fix / new feature /
  // recall / multi-agent team / free / research) and the rest of the workspace
  // becomes contextual. The legacy sub-tabs remain accessible.
  { id: "jarvis", label: "Ultron", Icon: Sparkles },
  { id: "board", label: "Board", Icon: Kanban },
  { id: "terminal", label: "Terminal", Icon: TerminalIcon },
  { id: "agents", label: "Agents", Icon: Bot },
  { id: "context", label: "Context", Icon: Notebook },
  { id: "sessions", label: "Sessions", Icon: History },
  // Notes (freeform markdown editor) and Timeline (read-only chronological
  // feed of kanban moves + sessions + backups).
  { id: "notes", label: "Notes", Icon: BookOpen },
  { id: "timeline", label: "Timeline", Icon: Clock },
];

// Shared visual style for every header action button.
// Defined as a plain string so it stays in one place and all buttons stay
// pixel-identical without Tailwind's purge removing dynamic class fragments.
const HEADER_BTN =
  "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-40";
const HEADER_BTN_STYLE: React.CSSProperties = {
  borderColor: "rgba(255,255,255,0.10)",
  background: "transparent",
  color: "var(--color-text-muted)",
};

export default function ProjectWorkspace({ projectId }: Props) {
  const { consumeInitialSubTab, subTabs, setProjectSubTab } = useProjectsTabs();

  // Sub-tab lives in context so it survives navigating away from the Projects
  // main tab. Deep-link hints (from home-grid shortcuts) override on mount.
  const subTab: ProjectSubTab = subTabs[projectId] ?? "jarvis";
  function setSubTab(t: ProjectSubTab) { setProjectSubTab(projectId, t); }

  useEffect(() => {
    const hint = consumeInitialSubTab(projectId);
    if (hint) setProjectSubTab(projectId, hint);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [meta, setMeta] = useState<ProjectMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [batchToast, setBatchToast] = useState<BatchToast | null>(null);
  const [tabCounts, setTabCounts] = useState<TabCounts>({ agents: null, sessions: null });
  // Ref holds latest meta.path so the interval closure always sees the current value.
  const metaPathRef = useRef<string>("");

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
            // fb-016: respect parent_folder_override for terminal cwd.
            const terminalCwd = found.parent_folder_override ?? found.path;
            setMeta({
              id: found.id,
              name: found.name ?? found.id,
              path: found.path,
              terminalCwd,
            });
            metaPathRef.current = found.path;
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

  // Poll tab counts (agents + sessions) every 30s. Runs once after meta
  // resolves (path available) then repeats. Errors are silently swallowed
  // so a failing command never surfaces as visible UI noise.
  useEffect(() => {
    if (!meta?.path) return;
    let active = true;

    const run = async () => {
      const counts = await fetchTabCounts(projectId, metaPathRef.current);
      if (active) setTabCounts(counts);
    };

    void run();
    const id = window.setInterval(() => { void run(); }, 30_000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [projectId, meta?.path]);

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
      await openPath(meta.path);
    } catch (e) {
      setError(String(e));
    }
  };

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

        {/* Action buttons — all share HEADER_BTN + onMouseEnter/Leave for hover.
            Recall + Run Batch removed from header (duplicated with Terminal toolbar
            where the actual spawn lives). To be fully removed in Projects redesign C10. */}
        <div className="flex shrink-0 items-center gap-1.5">
          {/* IDE */}
          <HeaderBtn
            onClick={openInIde}
            disabled={!meta}
            title="Open project in IDE"
          >
            <ExternalLink size={12} />
            IDE
          </HeaderBtn>

          {/* Folder */}
          <HeaderBtn
            onClick={openFolder}
            disabled={!meta}
            title="Reveal project folder in Explorer"
          >
            <FolderOpen size={12} />
            Folder
          </HeaderBtn>

          {/* Detach */}
          <HeaderBtn
            onClick={detachToWindow}
            disabled={!meta}
            title="Open this project in a standalone window (multi-monitor)"
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

      {/* ------------------------------------------------------------------ */}
      {/* Sub-tab bar — visually separated with a stronger bottom border.     */}
      {/* ------------------------------------------------------------------ */}
      {/* KIRKARDO 25 a11y fix: role=tablist + role=tab + aria-selected
          + aria-controls so screen readers announce these as navigation
          tabs instead of generic buttons. TabBadge contributes to the
          aria-label of the parent button so the count is announced
          alongside the tab name. */}
      <div
        role="tablist"
        aria-label="Project sections"
        className="flex items-center gap-0 border-b px-1"
        style={{
          background: "#000000",
          borderColor: "rgba(255,255,255,0.12)",
        }}
      >
        {TABS.map(({ id, label, Icon }) => {
          const active = subTab === id;
          const badge =
            id === "agents" ? tabCounts.agents :
            id === "sessions" ? tabCounts.sessions :
            null;
          const ariaLabel = badge && badge > 0 ? `${label}, ${badge} items` : label;
          return (
            <button
              key={id}
              role="tab"
              aria-selected={active}
              aria-controls={`project-tabpanel-${id}`}
              id={`project-tab-${id}`}
              tabIndex={active ? 0 : -1}
              aria-label={ariaLabel}
              onClick={() => setSubTab(id)}
              className="flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-[11px] transition-colors"
              style={{
                borderBottomColor: active
                  ? "var(--color-accent)"
                  : "transparent",
                color: active
                  ? "var(--color-text)"
                  : "rgba(255,255,255,0.38)",
              }}
              onMouseEnter={(e) => {
                if (!active) {
                  (e.currentTarget as HTMLButtonElement).style.color =
                    "rgba(255,255,255,0.70)";
                }
              }}
              onMouseLeave={(e) => {
                if (!active) {
                  (e.currentTarget as HTMLButtonElement).style.color =
                    "rgba(255,255,255,0.38)";
                }
              }}
            >
              <Icon size={12} />
              {label}
              <TabBadge count={badge} />
            </button>
          );
        })}
      </div>

      {error && (
        <div className="border-b border-[var(--color-error)] bg-[var(--color-surface-2)] px-3 py-1 text-xs text-[var(--color-error)]">
          {error}
        </div>
      )}

      {/* Body — role=tabpanel completes the WAI-ARIA tabs pattern paired
          with the role=tablist above. The id matches the active tab's
          aria-controls so screen readers can jump back and forth. */}
      <div
        role="tabpanel"
        id={`project-tabpanel-${subTab}`}
        aria-labelledby={`project-tab-${subTab}`}
        className="flex-1 overflow-hidden"
      >
        {subTab === "jarvis" && (
          <ProjectJarvisLauncher
            projectId={projectId}
            projectPath={meta?.terminalCwd ?? null}
            projectName={meta?.name ?? projectId}
            onIntentSelected={(intent: JarvisIntent) => {
              // Para intents PTY, cambia a Terminal — el usuario puede pegar
              // intent.initial_prompt en una sesión Claude embebida. Los intents
              // de tipo workflow se rutearán a un dispatch UI en un sprint futuro.
              setSubTab("terminal");
              // Stash the intent in sessionStorage so ProjectTerminal can pick
              // it up when it spawns a new tab.
              try {
                sessionStorage.setItem(
                  `jarvis-intent-${projectId}`,
                  JSON.stringify(intent),
                );
              } catch {
                // sessionStorage can fail in restricted contexts — non-fatal.
              }
            }}
          />
        )}
        {subTab === "board" && <ProjectBoard projectId={projectId} onOpenTerminal={() => setSubTab("terminal")} />}
        {subTab === "terminal" && <ProjectTerminal projectId={projectId} projectPath={meta?.terminalCwd ?? null} />}
        {subTab === "agents" && (
          <ProjectAgents projectId={projectId} projectPath={meta?.path ?? ""} />
        )}
        {subTab === "context" && (
          <ProjectContext projectId={projectId} projectPath={meta?.path ?? ""} projectName={meta?.name ?? projectId} />
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
