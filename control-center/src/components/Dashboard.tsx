// Control Center — Dashboard (fullize 2026-06-01: side-panel layout).
//
// Layout: a main column + a right side panel for the To-Do (visual-only).
//   Side panel : TodoCard (dark checkboxes, manage in Notes)
//   Main column:
//     Row hero : RecentSessionsCard
//     Row 0    : ResumeSessionCard (self-hides when none) — "continuar donde lo dejaste"
//     Bento    : Pending · Backup · RecentProjects · CrashEvents(span-2) · MemoryStatus
//
// Removed per user (2026-06-01): ActiveProjectCard (project cartilla) and the
// ECC PluginStatusCard. Added: MemoryStatusCard (backend memory health).

import type { GlobalStatus } from "../types";
import packageJson from "../../package.json";

import { ResumeSessionCard } from "./dashboard/ResumeSessionCard";
import { RecentProjectsCard } from "./dashboard/RecentProjectsCard";
import { PendingKanbanCard } from "./dashboard/PendingKanbanCard";
import { BackupCard } from "./dashboard/BackupCard";
import { CrashEventsCard } from "./dashboard/CrashEventsCard";
import { RecentSessionsCard } from "./dashboard/RecentSessionsCard";
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

      {/* Two-column shell: main content + right To-Do side panel. */}
      <div
        className="grid gap-4"
        style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(300px, 340px)" }}
      >
        {/* Main column */}
        <div className="flex flex-col gap-4">
          <RecentSessionsCard onOpenSessions={() => onNavigate?.("sessions")} />

          {/* Continuar donde lo dejaste (se oculta solo si no hay nada) */}
          <ResumeSessionCard onOpenSessions={() => onNavigate?.("sessions")} />

          {/* Bento grid fluido */}
          <div
            className="grid gap-4"
            style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}
          >
            <PendingKanbanCard onOpenProjects={() => onNavigate?.("projects")} />
            <BackupCard />
            <RecentProjectsCard onOpenProjects={() => onNavigate?.("projects")} />
            <div className="dashboard-span-2">
              <CrashEventsCard />
            </div>
            <MemoryStatusCard onOpenSystem={() => onNavigate?.("system")} />
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
