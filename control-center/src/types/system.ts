// System info, scheduled tasks, installed apps, and bloatware types.

export type ScheduledTaskInfo = {
  name: string;
  state: string;
  last_run: string;
  next_run: string;
  last_result: number;
  description: string | null;
  /** Phase 8: Settings.StartWhenAvailable — run on next boot if missed. */
  catch_up?: boolean;
};

export type RunTaskResult = {
  success: boolean;
  name: string;
  stderr: string;
};

export type EditTaskResult = {
  success: boolean;
  name: string;
  trigger_type: string;
  trigger_at: string;
  error: string;
  /** Phase 8: whether StartWhenAvailable is on after the edit. */
  catch_up?: boolean;
};

export type DeleteTaskResult = {
  success: boolean;
  name: string;
  error: string;
};

export type ScheduledTriggerType = "Daily" | "Weekly" | "AtLogon";

export type SystemInfo = {
  hostname: string;
  user: string;
  os_name: string;
  os_version: string;
  uptime_seconds: number;
  disk_c_total_gb: number;
  disk_c_free_gb: number;
  disk_c_pct_used: number;
};

export type TaskTrigger = {
  kind: string;
  start: string;
  enabled: boolean;
  extra: string;
};

export type TaskAction = {
  execute: string;
  arguments: string;
  working: string;
};

export type TaskEvent = {
  time: string;
  event_id: number;
  message: string;
};

export type TaskDetail = {
  name: string;
  description: string | null;
  author: string | null;
  state: string;
  last_run: string;
  next_run: string;
  last_result: number;
  missed_runs: number;
  principal_user: string;
  principal_logon: string;
  run_level: string;
  triggers: TaskTrigger[];
  actions: TaskAction[];
  history: TaskEvent[];
  /** Phase 8: see ScheduledTaskInfo.catch_up. */
  catch_up?: boolean;
};

export type GpuInfo = {
  name: string;
  util_pct: number | null;
  mem_used_mb: number | null;
  mem_total_mb: number | null;
  temp_c: number | null;
  vendor: string;
};

export type BatteryInfo = {
  percent: number;
  status: number;
  plugged_in: boolean;
};

export type NetworkInfo = {
  interface: string;
  ipv4: string;
  gateway: string;
  dns: string;
};

export type ProcInfo = {
  name: string;
  pid: number;
  ram_mb: number;
};

export type RichSystemInfo = {
  hostname: string;
  user: string;
  os_name: string;
  os_version: string;
  uptime_seconds: number;
  cpu_name: string;
  cpu_cores: number;
  cpu_threads: number;
  cpu_load_pct: number | null;
  ram_total_gb: number;
  ram_free_gb: number;
  ram_used_gb: number;
  ram_pct_used: number;
  disk_c_total_gb: number;
  disk_c_free_gb: number;
  disk_c_pct_used: number;
  gpus: GpuInfo[];
  battery: BatteryInfo | null;
  network: NetworkInfo | null;
  top_procs: ProcInfo[];
};

// ---------------------------------------------------------------------------
// Installed apps (System → Apps sub-tab)
// ---------------------------------------------------------------------------

export type InstalledAppProvider = "winget" | "store" | "msi" | "manual";

export type InstalledApp = {
  name: string;
  version: string | null;
  publisher: string | null;
  install_location: string | null;
  provider: InstalledAppProvider | string;
  package_id: string | null;
  uninstall_hint: string | null;
};

export type InstalledAppsReport = {
  apps: InstalledApp[];
  source_errors: string[];
  generated_at: string;
  cached: boolean;
};

export type UninstallAppResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  command: string;
};

// Bloatware sub-tab (System → Bloatware). Pre-curated list of Windows Appx
// packages most users want to remove. The backend exposes:
//   - appx_query(pattern)              → is the package installed?
//   - uninstall_bloatware_app(pattern) → Remove-AppxPackage
export type AppxQueryResult = {
  installed: boolean;
  matches: string[];
};

export type BloatwareUninstallResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  command: string;
  removed: string[];
};
