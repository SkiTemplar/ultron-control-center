// Control Center — Dashboard (redesign 2026-06-07).
//
// Layout: explicit grid (see the grid comment in the JSX).
//   Row top  : MemoryStatusCard · CrashEventsCard · TodoCard (xl); below xl
//              TodoCard stacks under MemoryStatusCard
//   Row bot  : PendingKanbanCard · BackupCard · RecentProjectsCard
//
// Removed per user feedback: RecentSessionsCard, ResumeSessionCard.

import { invoke } from "@tauri-apps/api/core";
import type { GlobalStatus } from "../types";
import packageJson from "../../package.json";
import { statusColor, statusLabel } from "../lib/status";

import { RecentProjectsCard } from "./dashboard/RecentProjectsCard";
import { useProjectsTabs } from "../state/ProjectsTabsContext";
import { PendingKanbanCard } from "./dashboard/PendingKanbanCard";
import { BackupCard } from "./dashboard/BackupCard";
import { CrashEventsCard } from "./dashboard/CrashEventsCard";
import { MemoryStatusCard } from "./dashboard/MemoryStatusCard";
import { TodoCard } from "./dashboard/TodoCard";

const APP_VERSION: string = (packageJson as { version?: string }).version ?? "";

// The Dashboard navigates the user to other tabs. We type the navigation
// target loosely so we don't have to import the App-owned `Tab` union.
type NavTarget =
  | "dashboard"
  | "mcps"
  | "library"
  | "skills"
  | "agents"
  | "rules"
  | "projects"
  | "notes"
  | "plans"
  | "notifications"
  | "sessions"
  | "usage"
  | "ai-router"
  | "system"
  | "settings";

interface DashboardProps {
  globalStatus: GlobalStatus;
  /** Wired by App.tsx as `setTab`. */
  onNavigate?: (tab: NavTarget) => void;
}

export function Dashboard({ globalStatus, onNavigate }: DashboardProps) {
  const projectsTabs = useProjectsTabs();
  // Una fila de «Proyectos recientes» abre ese proyecto, como un clic en la
  // pestaña Projects (pestaña de proyecto + last_active actualizado).
  function openRecentProject(p: { id: string; name: string }) {
    void invoke("touch_project", { id: p.id }).catch(() => {
      /* no fatal: solo afecta al orden de «Most recent» */
    });
    projectsTabs.open({ id: p.id, title: p.name });
    onNavigate?.("projects");
  }
  return (
    <div className="dashboard-shell">
      <header className="mb-6 flex flex-wrap items-baseline gap-3 justify-between">
        <div>
          <h1 className="text-[22px] font-semibold leading-tight">Panel</h1>
          <p
            className="mt-1 text-[13px]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Claude Code · memoria SQLite FTS5 (denso opcional) · Control Center v{APP_VERSION}
          </p>
        </div>
        {/* Same label and colour as the Sidebar footer (lib/status.ts). */}
        <button
          type="button"
          onClick={() => onNavigate?.("notifications")}
          className="inline-flex items-center gap-2 rounded px-2.5 py-1 text-[12px] transition-colors hover:brightness-125 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          style={{
            background: "var(--color-surface-2)",
            border: `1px solid ${statusColor(globalStatus)}`,
            color: "var(--color-text)",
          }}
          title="Estado agregado · abrir Notificaciones"
        >
          <span
            className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: statusColor(globalStatus) }}
            aria-hidden
          />
          {statusLabel(globalStatus)}
        </button>
      </header>

      {/* El visor EN VIVO de la sesion activa (ultimo turno orquestado + skills
          aceptadas + agentes delegados + previsualizar orquestacion) vive ahora
          en la zona Sessions -> sub-tab "Orquestacion" (movido del Dashboard). */}

      {/* Explicit grid (2026-10-17). The old auto-fit top row only fit two
          280px columns in the ~800px main column, so the span-2 Crash events
          card wrapped and left half a row empty.
            <lg : one column (Memory, To-Do, Crash events, bottom row).
            lg  : [Memory + To-Do stacked | Crash events], bottom row below.
            xl  : [Memory | Crash events | To-Do], bottom row across all three
                  columns (in the 2-column main area it only fit two cards
                  and left a hole next to the third). The left wrapper turns
                  into `display: contents` so its two cards are placed
                  directly in the grid. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(280px,1fr)_minmax(0,2fr)] xl:grid-cols-[minmax(280px,1fr)_minmax(0,2fr)_minmax(300px,340px)]">
        <div className="flex min-w-0 flex-col gap-4 xl:contents">
          <div className="min-w-0 xl:col-start-1 xl:row-start-1">
            <MemoryStatusCard onOpenSystem={() => onNavigate?.("system")} />
          </div>
          {/* To-Do (visual, manage in Notes). */}
          <aside className="min-w-0 xl:col-start-3 xl:row-start-1 xl:self-start">
            <TodoCard onOpenNotes={() => onNavigate?.("notes")} />
          </aside>
        </div>

        <div className="min-w-0 lg:col-start-2 lg:row-start-1">
          <CrashEventsCard onOpenSystem={() => onNavigate?.("system")} />
        </div>

        {/* Bottom row: Pending · Backup · Recent Projects */}
        <div
          className="grid min-w-0 gap-4 lg:col-span-2 lg:col-start-1 xl:col-span-3"
          style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}
        >
          <PendingKanbanCard onOpenProjects={() => onNavigate?.("projects")} />
          <BackupCard />
          <RecentProjectsCard
            onOpenProjects={() => onNavigate?.("projects")}
            onOpenProject={openRecentProject}
          />
        </div>
      </div>
    </div>
  );
}
