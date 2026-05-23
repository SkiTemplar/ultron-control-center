// Control Center 2.0 Dashboard.
//
// Rewritten for the post-ULTRON stack (Claude Code + ECC + Mem0). The old
// `run_full_diagnostic`, `MaintenancePanel`, and ULTRON-specific auto-fixes
// are gone. The new layout is a grid of focused at-a-glance cards plus a
// reworked "Fix common issues" strip.

import type { AlertEntry, ChangelogEntry, GlobalStatus } from "../types";
import packageJson from "../../package.json";

import { AlertsCard } from "./dashboard/AlertsCard";
import { Mem0Card } from "./dashboard/Mem0Card";
import { PluginStatusCard } from "./dashboard/PluginStatusCard";
import { RecentProjectsCard } from "./dashboard/RecentProjectsCard";
import { RecentSessionsCard } from "./dashboard/RecentSessionsCard";
import { PendingKanbanCard } from "./dashboard/PendingKanbanCard";
import { BackupCard } from "./dashboard/BackupCard";
import { PcDiagnosticCard } from "./dashboard/PcDiagnosticCard";
import { FixCommonIssues } from "./dashboard/FixCommonIssues";
import { relativeTime } from "./dashboard/Card";

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
  | "changelog"
  | "notifications"
  | "sessions"
  | "usage"
  | "system"
  | "settings";

interface DashboardProps {
  alerts: AlertEntry[];
  changelog: ChangelogEntry[];
  globalStatus: GlobalStatus;
  /** Wired by App.tsx as `setTab`. */
  onNavigate?: (tab: NavTarget) => void;
}

export function Dashboard({
  alerts,
  changelog,
  globalStatus,
  onNavigate,
}: DashboardProps) {
  const lastChange = changelog[0];

  return (
    <div className="px-10 py-8">
      <header className="mb-8">
        <h1 className="text-[20px] font-semibold leading-tight">Dashboard</h1>
        <p
          className="mt-1 text-[13px]"
          style={{ color: "var(--color-text-secondary)" }}
        >
          Claude Code + ECC + Mem0 - Control Center v{APP_VERSION}
        </p>
      </header>

      {/* Row 1 - status snapshots */}
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        <AlertsCard
          alerts={alerts}
          onOpenNotifications={() => onNavigate?.("notifications")}
        />
        <Mem0Card onOpenMemory={() => onNavigate?.("memory")} />
        <PluginStatusCard />
      </div>

      {/* Row 2 - what's currently in flight */}
      <div className="mt-3 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        <RecentProjectsCard
          onOpenProjects={() => onNavigate?.("projects")}
        />
        <RecentSessionsCard onOpenSessions={() => onNavigate?.("sessions")} />
        <PendingKanbanCard onOpenProjects={() => onNavigate?.("projects")} />
      </div>

      {/* Row 3 - machine + backup health */}
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <PcDiagnosticCard onOpenDiagnostics={() => onNavigate?.("system")} />
        <BackupCard />
      </div>

      <FixCommonIssues onOpenSettings={() => onNavigate?.("settings")} />

      {/* Latest change strip - preserved from v1 since it's still useful. */}
      {lastChange && (
        <section className="mt-8">
          <h2 className="text-[14px] font-semibold">Latest change</h2>
          <div
            className="mt-2 rounded p-4"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
            }}
          >
            <div className="flex items-baseline gap-2">
              <span
                className="rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-secondary)",
                }}
              >
                {lastChange.type}
              </span>
              <span
                style={{ color: "var(--color-text-tertiary)" }}
                className="text-[11px]"
              >
                {lastChange.scope}
              </span>
              <span
                style={{ color: "var(--color-text-tertiary)" }}
                className="ml-auto text-[11px]"
              >
                {relativeTime(lastChange.ts)}
              </span>
            </div>
            <div className="mt-2 text-[13px] font-medium">
              {lastChange.title}
            </div>
          </div>
        </section>
      )}

      <div
        className="mt-12 text-[11px]"
        style={{ color: "var(--color-text-faint)" }}
      >
        Global status: {globalStatus}
      </div>
    </div>
  );
}
