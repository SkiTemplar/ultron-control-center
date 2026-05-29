// ProjectDashboard — project view v2 (card-ux-projects-dashboard-minimalista).
//
// IDE-like layout that RECOMPOSES the existing per-project panels (ProjectBoard,
// ProjectAgents, ProjectSessions, ProjectContext, ProjectNotes, ProjectTerminal)
// into a 3-column grid of collapsible panels — replacing the old sub-tab bar.
// Rendered behind the `projects_dashboard_v2` feature flag (OFF by default); the
// legacy sub-tab workspace stays intact until USER validates this visually.
//
// MVP scope (wireframe steps 2-3): fixed 3-column grid + per-panel collapse with
// localStorage persistence. Resize handles (step 4) and a dedicated Git panel
// are deferred. Run Batch / Open IDE contextual placement (step 6) handled by the
// header actions passed in from ProjectWorkspace.

import { useCallback, useState, type ReactNode } from "react";
import ProjectBoard from "./ProjectBoard";
import ProjectAgents from "./ProjectAgents";
import ProjectSessions from "./ProjectSessions";
import ProjectContext from "./ProjectContext";
import ProjectNotes from "./ProjectNotes";
import ProjectTerminal from "./ProjectTerminal";
import { DashboardPanel } from "./DashboardPanel";

interface ProjectDashboardProps {
  projectId: string;
  /** Project root path — for panels that show project files (agents/sessions/context). */
  projectPath: string;
  /** cwd the terminal must spawn in — respects parent_folder_override (fb-016).
   *  Distinct from projectPath; only the terminal uses it. */
  terminalCwd: string;
  projectName: string;
  /** Contextual action for the terminal/sessions area (e.g. Run Batch). */
  sessionsActions?: ReactNode;
}

type PanelKey = "terminal" | "kanban" | "agents" | "sessions" | "context" | "notes";

function loadCollapsed(projectId: string): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(`ultron:projdash:${projectId}:collapsed`);
    if (raw) return JSON.parse(raw) as Record<string, boolean>;
  } catch {
    /* ignore corrupt/blocked storage */
  }
  return {};
}

export default function ProjectDashboard({
  projectId,
  projectPath,
  terminalCwd,
  projectName,
  sessionsActions,
}: ProjectDashboardProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() =>
    loadCollapsed(projectId),
  );

  const toggle = useCallback(
    (key: PanelKey) => {
      setCollapsed((prev) => {
        const next = { ...prev, [key]: !prev[key] };
        try {
          localStorage.setItem(
            `ultron:projdash:${projectId}:collapsed`,
            JSON.stringify(next),
          );
        } catch {
          /* ignore */
        }
        return next;
      });
    },
    [projectId],
  );

  // Wrapper: expanded panels share column height (flex-1); collapsed shrink to
  // their header. min-h-0 lets inner scroll areas work inside the flex column.
  const wrap = (key: PanelKey, node: ReactNode) => (
    <div className={collapsed[key] ? "shrink-0" : "flex min-h-0 flex-1"}>{node}</div>
  );

  const panelProps = (key: PanelKey, title: string, body: ReactNode, opts?: { actions?: ReactNode; scrollBody?: boolean }) =>
    wrap(
      key,
      <DashboardPanel
        title={title}
        collapsed={!!collapsed[key]}
        onToggleCollapsed={() => toggle(key)}
        actions={opts?.actions}
        scrollBody={opts?.scrollBody ?? true}
      >
        {body}
      </DashboardPanel>,
    );

  return (
    <div
      className="grid h-full min-h-0 w-full gap-2 p-2"
      style={{ gridTemplateColumns: "minmax(220px, 1fr) minmax(0, 2fr) minmax(260px, 1.2fr)" }}
    >
      {/* Left column: roster + sessions */}
      <div className="flex min-h-0 min-w-0 flex-col gap-2">
        {panelProps("agents", "Agentes", <ProjectAgents projectId={projectId} projectPath={projectPath} />)}
        {panelProps(
          "sessions",
          "Sesiones",
          <ProjectSessions projectId={projectId} projectPath={projectPath} />,
          { actions: sessionsActions },
        )}
      </div>

      {/* Center column: terminal (primary) + notes */}
      <div className="flex min-h-0 min-w-0 flex-col gap-2">
        {panelProps(
          "terminal",
          "Terminal IA",
          <ProjectTerminal projectId={projectId} projectPath={terminalCwd} />,
          { scrollBody: false },
        )}
        {panelProps("notes", "Notas", <ProjectNotes projectId={projectId} />)}
      </div>

      {/* Right column: kanban + context */}
      <div className="flex min-h-0 min-w-0 flex-col gap-2">
        {panelProps("kanban", "Kanban", <ProjectBoard projectId={projectId} />)}
        {panelProps(
          "context",
          "Contexto",
          <ProjectContext projectId={projectId} projectPath={projectPath} projectName={projectName} />,
        )}
      </div>
    </div>
  );
}
