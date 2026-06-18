// Diagnostics — shared types

export type EventLogLevel =
  | "critical"
  | "error"
  | "warning"
  | "information"
  | "verbose"
  | "unknown";

export interface EventLogEntry {
  event_id: number;
  source: string;
  log_name: string;
  level: EventLogLevel;
  time_created: string;
  message: string;
}

export interface MaintenanceResult {
  kind: string;
  success: boolean;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  elapsed_ms: number;
}

export interface CommonErrorCheckResult {
  status: "ok" | "fail" | "warn";
  details: string;
  suggested_fix: string | null;
}

export type CommonErrorCategory =
  | "AI / Claude"
  | "Network"
  | "Storage"
  | "Plugins"
  | "System"
  | "Git";

export type CommonErrorSeverity = "critical" | "warning" | "info";

export interface CommonError {
  id: string;
  category: CommonErrorCategory;
  severity: CommonErrorSeverity;
  title: string;
  symptom: string;
  /** Backend `diagnostics_run(error_id)` */
  checkId: string;
  /** Primary fix: `run_maintenance_command(kind)` — null means open modal/navigate */
  primaryFixKind: string | null;
  primaryFixLabel: string;
  /** Optional extra fix kinds shown in "More" dropdown */
  extraFixes?: Array<{ kind: string; label: string }>;
}

export type FixCategory =
  | "network"
  | "services"
  | "update"
  | "storage"
  | "shell"
  | "diagnostic"
  | "system";

export interface Fix {
  kind: string;
  label: string;
  detail: string;
  category: FixCategory;
  confirm?: { title: string; message: string };
}

export interface KnownError {
  description: string;
  fixes: string[];
  severity: "critical" | "error" | "warning";
}

export interface FixHistoryEntry {
  ts: string;
  kind: string;
  label: string;
  success: boolean;
  source: "common_error" | "toolbox" | "event_log";
  error_id?: string;
}
