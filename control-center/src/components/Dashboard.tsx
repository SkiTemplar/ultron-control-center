// Control Center — Dashboard (redesign 2026-06-07).
//
// Layout: main column + right To-Do side panel.
//   Side panel : TodoCard (dark checkboxes, manage in Notes)
//   Main column:
//     Row top  : MemoryStatusCard · CrashEventsCard (span-2 at >=1024px)
//     Row bot  : PendingKanbanCard · BackupCard · RecentProjectsCard
//
// Removed per user feedback: RecentSessionsCard, ResumeSessionCard.

import type { GlobalStatus } from "../types";
import packageJson from "../../package.json";

import { RecentProjectsCard } from "./dashboard/RecentProjectsCard";
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
  return (
    <div className="dashboard-shell">
      <header className="mb-6 flex flex-wrap items-baseline gap-3 justify-between">
        <div>
          <h1 className="text-[22px] font-semibold leading-tight">Cockpit</h1>
          <p
            className="mt-1 text-[13px]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Claude Code · memoria SQLite + Qdrant — Control Center v{APP_VERSION}
          </p>
        </div>
        <span
          className="rounded px-2.5 py-1 text-[11px] uppercase tracking-wide"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text-tertiary)",
          }}
          title="Estado global agregado"
        >
          {globalStatus}
        </span>
      </header>

      {/* El visor EN VIVO de la sesion activa (ultimo turno orquestado + skills
          aceptadas + agentes delegados + previsualizar orquestacion) vive ahora
          en la zona Sessions -> sub-tab "Orquestacion" (movido del Dashboard). */}

      {/* Two-column shell: main content + right To-Do side panel. */}
      <div
        className="grid gap-4"
        style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(300px, 340px)" }}
      >
        {/* Main column — two bento rows */}
        <div className="flex flex-col gap-4">
          {/* Top row: Memory (narrower) + Crash Events (wider, spans 2 cols at ≥1024px) */}
          <div
            className="grid gap-4"
            style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}
          >
            <MemoryStatusCard onOpenSystem={() => onNavigate?.("system")} />
            <div className="dashboard-span-2">
              <CrashEventsCard />
            </div>
          </div>

          {/* Bottom row: Pending · Backup · Recent Projects */}
          <div
            className="grid gap-4"
            style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}
          >
            <PendingKanbanCard onOpenProjects={() => onNavigate?.("projects")} />
            <BackupCard />
            <RecentProjectsCard onOpenProjects={() => onNavigate?.("projects")} />
          </div>
        </div>

        {/* Right side panel — To-Do (visual, manage in Notes). */}
        <aside className="flex flex-col gap-4">
          <TodoCard onOpenNotes={() => onNavigate?.("notes")} />
        </aside>
      </div>
    </div>
  );
}
