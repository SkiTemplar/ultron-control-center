// Control Center 2.7 Dashboard.
//
// COCKPIT REDESIGN (2026-05-30).
// Layout: full-width sin max-width clamp. Bento grid fluido con auto-fit.
//   Row hero : ActiveProjectCard (col-span ancho) + RecentSessionsCard
//   Row 0    : ResumeSessionCard (self-hides when none)
//   Row 1    : AlertsCard (full width)
//   Bento    : grid auto-fit minmax(320px,1fr) — Mem0 · Pending · Backup
//              WorkdaysWeekCard · RecentProjectsCard · CrashEvents(span-2) · PluginStatus

import type { AlertEntry, GlobalStatus } from "../types";
import packageJson from "../../package.json";

import { AlertsCard } from "./dashboard/AlertsCard";
import { ResumeSessionCard } from "./dashboard/ResumeSessionCard";
import { Mem0Card } from "./dashboard/Mem0Card";
import { PluginStatusCard } from "./dashboard/PluginStatusCard";
import { RecentProjectsCard } from "./dashboard/RecentProjectsCard";
import { WorkdaysWeekCard } from "./dashboard/WorkdaysWeekCard";
import { PendingKanbanCard } from "./dashboard/PendingKanbanCard";
import { BackupCard } from "./dashboard/BackupCard";
import { CrashEventsCard } from "./dashboard/CrashEventsCard";
import { ActiveProjectCard } from "./dashboard/ActiveProjectCard";
import { RecentSessionsCard } from "./dashboard/RecentSessionsCard";

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
  | "memory"
  | "plans"
  | "notifications"
  | "sessions"
  | "usage"
  | "system"
  | "settings";

interface DashboardProps {
  alerts: AlertEntry[];
  globalStatus: GlobalStatus;
  /** Wired by App.tsx as `setTab`. */
  onNavigate?: (tab: NavTarget) => void;
}

export function Dashboard({
  alerts,
  globalStatus,
  onNavigate,
}: DashboardProps) {
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

      {/* Row 1 — Notifications banner (full width) */}
      <div className="mb-4">
        <AlertsCard
          alerts={alerts}
          onOpenNotifications={() => onNavigate?.("notifications")}
        />
      </div>

      {/* Bento grid fluido */}
      <div
        className="grid gap-4"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}
      >
        <Mem0Card onOpenMemory={() => onNavigate?.("memory")} />
        <PendingKanbanCard onOpenProjects={() => onNavigate?.("projects")} />
        <BackupCard />
        <WorkdaysWeekCard />
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
