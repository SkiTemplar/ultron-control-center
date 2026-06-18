// ---------------------------------------------------------------------------
// Diagnostics (P6): native checks + AI analysis + history + schedule.
// Mirrors `crate::diagnostics_native::DiagnosticReport` and
// `crate::commands::diagnostics_native::{HistoryEntry, ScheduleConfig}`.
// ---------------------------------------------------------------------------

export type DiagSeverity = "ok" | "warn" | "error";

export type DiagSystemInfo = {
  os: string;
  kernel: string;
  hostname: string;
  uptime_seconds: number;
  cpu_brand: string;
  cpu_cores: number;
  cpu_usage_percent: number;
  ram_total_mb: number;
  ram_used_mb: number;
  ram_usage_percent: number;
  severity: DiagSeverity;
};

export type DiagDiskInfo = {
  mount: string;
  total_gb: number;
  free_gb: number;
  used_percent: number;
  severity: DiagSeverity;
};

export type DiagProcessInfo = {
  pid: number;
  name: string;
  cpu_percent: number;
  mem_mb: number;
};

export type DiagEventLogEntry = {
  log_name: string;
  source: string;
  level: string;
  event_id: number;
  message: string;
  time_generated: string;
};

export type DiagNetworkStatus = {
  reachable: boolean;
  latency_ms: number | null;
  severity: DiagSeverity;
};

export type DiagAppHealth = {
  projects_json_ok: boolean;
  claude_in_path: boolean;
  codex_in_path: boolean;
  gemini_in_path: boolean;
  qdrant_running: boolean;
  severity: DiagSeverity;
};

export type DiagnosticReport = {
  timestamp: string;
  system: DiagSystemInfo;
  disks: DiagDiskInfo[];
  top_processes: DiagProcessInfo[];
  event_log: DiagEventLogEntry[];
  network: DiagNetworkStatus;
  app: DiagAppHealth;
  max_severity: DiagSeverity;
};

export type DiagHistoryEntry = {
  timestamp: string;
  max_severity: DiagSeverity;
  path: string;
};

export type DiagScheduleConfig = {
  enabled: boolean;
  time_hhmm: string;
};

export type MaintenanceCommand = {
  kind: string;
  label: string;
  description: string;
  group: string;
};

export type MaintenanceResult = {
  kind: string;
  success: boolean;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  elapsed_ms: number;
};

export type DetectedGap = {
  severity: "info" | "warn" | "critical" | string;
  category: string;
  title: string;
  detail: string;
  suggestion: string | null;
};

export type GapsReport = {
  generated_at: string;
  count: number;
  gaps: DetectedGap[];
};
