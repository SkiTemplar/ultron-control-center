// Control Center 2.7 Dashboard.
//
// FULL REDESIGN (2026-05-24). USER's brief: the previous dashboard had
// the right cards, but everything felt tiny relative to the screen. This
// rewrite keeps the same set of cards (alerts, Mem0, pending, recent
// sessions, recent projects, crash events, backup) but makes them visibly
// larger, with a 13-14px content baseline, sentence-case section-style
// titles, and a layout that actually fills the workspace.
//
// Layout outline:
//   Row 1 (banner): Notifications — full width, status snapshot.
//   Row 2 (status trio): Mem0 · Pending · Backup (3 columns, all "lg" size).
//   Row 3 (lists pair): Recent sessions · Recent projects (2 columns).
//   Row 4 (footer card): Crash events — read-only, no event-viewer button.
//
// Cards that were dropped:
//   - PcDiagnosticCard (file deleted — was unused after CrashEvents took over)
//   - FixCommonIssues (those quick actions now live in the System tab)
//   - PluginStatusCard (moved into the status trio so dashboard stays focused)

import type { AlertEntry, GlobalStatus } from "../types";
import packageJson from "../../package.json";

import { AlertsCard } from "./dashboard/AlertsCard";
import { Mem0Card } from "./dashboard/Mem0Card";
import { PluginStatusCard } from "./dashboard/PluginStatusCard";
import { RecentProjectsCard } from "./dashboard/RecentProjectsCard";
import { RecentSessionsCard } from "./dashboard/RecentSessionsCard";
import { PendingKanbanCard } from "./dashboard/PendingKanbanCard";
import { BackupCard } from "./dashboard/BackupCard";
import { CrashEventsCard } from "./dashboard/CrashEventsCard";

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
    <div className="px-10 py-8">
      <header className="mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-[22px] font-semibold leading-tight">Dashboard</h1>
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
          title="Aggregated global status"
        >
          {globalStatus}
        </span>
      </header>

      {/* Row 1 — Notifications banner (full width) */}
      <div className="mb-4">
        <AlertsCard
          alerts={alerts}
          onOpenNotifications={() => onNavigate?.("notifications")}
        />
      </div>

      {/* Row 2 — Status trio: Mem0 · Pending · Backup */}
      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <Mem0Card onOpenMemory={() => onNavigate?.("memory")} />
        <PendingKanbanCard onOpenProjects={() => onNavigate?.("projects")} />
        <BackupCard />
      </div>

      {/* Row 3 — Recent sessions · Recent projects */}
      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <RecentSessionsCard onOpenSessions={() => onNavigate?.("sessions")} />
        <RecentProjectsCard onOpenProjects={() => onNavigate?.("projects")} />
      </div>

      {/* Row 4 — Crash events (full width, read-only) + plugin status */}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <CrashEventsCard />
        </div>
        <PluginStatusCard />
      </div>
    </div>
  );
}
