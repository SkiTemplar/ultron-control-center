// Control Center — Dashboard (fullize 2026-06-01: simplificado).
//
// Layout: full-width, bento grid fluido auto-fit. Sin AlertsCard (duplicaba la
// pestaña Notifications), sin WorkdaysWeekCard ni Mem0Card (Workdays fuera, la
// memoria es backend-only). El To-Do simple se monta aquí en la Ola 5.
//   Row hero : ActiveProjectCard + RecentSessionsCard
//   Row 0    : ResumeSessionCard (self-hides when none) — "recuperar ayer"
//   Bento    : Pending · Backup · RecentProjects · CrashEvents(span-2) · PluginStatus

import type { GlobalStatus } from "../types";
import packageJson from "../../package.json";

import { ResumeSessionCard } from "./dashboard/ResumeSessionCard";
import { PluginStatusCard } from "./dashboard/PluginStatusCard";
import { RecentProjectsCard } from "./dashboard/RecentProjectsCard";
import { PendingKanbanCard } from "./dashboard/PendingKanbanCard";
import { BackupCard } from "./dashboard/BackupCard";
import { CrashEventsCard } from "./dashboard/CrashEventsCard";
import { ActiveProjectCard } from "./dashboard/ActiveProjectCard";
import { RecentSessionsCard } from "./dashboard/RecentSessionsCard";
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
            Claude Code + ECC + Mem0 — Control Center v{APP_VERSION}
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

      {/* Hero row: proyecto activo + sesiones recientes */}
      <div className="mb-4 grid gap-4" style={{ gridTemplateColumns: "minmax(0,2fr) minmax(0,1fr)" }}>
        <ActiveProjectCard onOpenProjects={() => onNavigate?.("projects")} />
        <RecentSessionsCard onOpenSessions={() => onNavigate?.("sessions")} />
      </div>

      {/* Row 0 — Resume last session (self-hides when none) */}
      <div className="mb-4">
        <ResumeSessionCard onOpenSessions={() => onNavigate?.("sessions")} />
      </div>

      {/* Bento grid fluido */}
      <div
        className="grid gap-4"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}
      >
        <TodoCard onOpenNotes={() => onNavigate?.("notes")} />
        <PendingKanbanCard onOpenProjects={() => onNavigate?.("projects")} />
        <BackupCard />
        <RecentProjectsCard onOpenProjects={() => onNavigate?.("projects")} />
        {/* CrashEvents ocupa 2 columnas cuando hay espacio */}
        <div className="dashboard-span-2">
          <CrashEventsCard />
        </div>
        <PluginStatusCard />
      </div>
    </div>
  );
}
