import type { WorkspaceSummary } from "../../types";
import { WorkspaceCard } from "./WorkspaceCard";

type CollapsibleGroup = {
  key: string;
  label: string;
  items: WorkspaceSummary[];
};

type WorkspacesSectionProps = {
  workspacesLoading: boolean;
  workspaces: WorkspaceSummary[];
  filteredWorkspaces: WorkspaceSummary[];
  search: string;
  ungrouped: WorkspaceSummary[];
  collapsible: CollapsibleGroup[];
  openGroups: Set<string>;
  busyCwd: string | null;
  creatingProjectCwd: string | null;
  onToggleGroup: (key: string) => void;
  onNew: (ws: WorkspaceSummary) => void;
  onCustom: (ws: WorkspaceSummary) => void;
  onSendContext: (ws: WorkspaceSummary) => void;
  onCreateProject: (ws: WorkspaceSummary) => void;
};

export function WorkspacesSection({
  workspacesLoading,
  workspaces,
  filteredWorkspaces,
  search,
  ungrouped,
  collapsible,
  openGroups,
  busyCwd,
  creatingProjectCwd,
  onToggleGroup,
  onNew,
  onCustom,
  onSendContext,
  onCreateProject,
}: WorkspacesSectionProps) {
  return (
    <section className="mb-6">
      {/* Section header row: title + count + Create Project button */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[14px] font-semibold leading-tight">
            Recent workspaces
          </h2>
          <span
            className="text-[11.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {workspacesLoading
              ? "Loading…"
              : `${filteredWorkspaces.length} of ${workspaces.length}`}
          </span>
        </div>
        {/* El botón de crear proyecto ya no vive aquí: cada session card sin
            proyecto tiene su propio "+" en la esquina (onCreateProject). */}
      </div>

      {!workspacesLoading && workspaces.length === 0 && (
        <div
          className="rounded p-6 text-center text-[12.5px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-tertiary)",
          }}
        >
          No Claude workspaces yet. Open a Claude session in any folder and
          it will appear here automatically.
        </div>
      )}

      {!workspacesLoading &&
        workspaces.length > 0 &&
        filteredWorkspaces.length === 0 && (
          <div
            className="rounded p-6 text-center text-[12.5px]"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
              color: "var(--color-text-tertiary)",
            }}
          >
            No workspace matches "{search}".
          </div>
        )}

      {/* Ungrouped cards */}
      {ungrouped.length > 0 && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {ungrouped.map((ws) => (
            <WorkspaceCard
              key={ws.cwd}
              ws={ws}
              busy={busyCwd === ws.cwd}
              onNew={onNew}
              onCustom={onCustom}
              onSendContext={onSendContext}
              onCreateProject={onCreateProject}
              creatingProject={creatingProjectCwd === ws.cwd}
            />
          ))}
        </div>
      )}

      {/* Collapsible groups */}
      {collapsible.map((g) => {
        const isOpen = openGroups.has(g.key);
        return (
          <div key={g.key} className="mt-4">
            <button
              type="button"
              onClick={() => onToggleGroup(g.key)}
              aria-expanded={isOpen}
              aria-label={`${isOpen ? "Collapse" : "Expand"} ${g.label} workspaces group`}
              className="flex w-full items-center gap-2 rounded px-3 py-2 text-left transition-colors"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border)",
              }}
            >
              <span
                className="inline-block text-[12px]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {isOpen ? "▾" : "▸"}
              </span>
              <span className="text-[12.5px] font-semibold">{g.label}</span>
              <span
                className="text-[11.5px]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {g.items.length} workspaces
              </span>
              <span
                className="ml-auto text-[11.5px]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {isOpen ? "hide" : "show"}
              </span>
            </button>
            {isOpen && (
              <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {g.items.map((ws) => (
                  <WorkspaceCard
                    key={ws.cwd}
                    ws={ws}
                    busy={busyCwd === ws.cwd}
                    onNew={onNew}
                    onCustom={onCustom}
                    onSendContext={(w) => onSendContext(w)}
                    onCreateProject={onCreateProject}
                    creatingProject={creatingProjectCwd === ws.cwd}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
