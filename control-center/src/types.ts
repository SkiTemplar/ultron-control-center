// Shared types between Tauri Rust commands and React frontend.

export type CmdResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  exit_code: number | null;
};

export type QdrantHealth = {
  status: string;
  message: string;
  elapsed_sec: number;
  timestamp: string;
};

export type AlertEntry = {
  id?: string;
  ts?: string;
  timestamp?: string;
  severity: "info" | "warn" | "blocking" | "critical" | string;
  source: string;
  message: string;
  tags?: string[];
  ack?: boolean;
};

export type ChangelogEntry = {
  id: string;
  ts: string;
  type: "feat" | "fix" | "chore" | "refactor" | "docs" | string;
  scope: string;
  title: string;
  body: string;
  related_ids?: string[];
  applied_by?: string;
};

export type Health = {
  qdrant: QdrantHealth | null;
  qdrant_error: string | null;
  alerts_count: number;
  alerts_critical: number;
};

export type GlobalStatus = "ok" | "warn" | "down" | "loading";

export type McpStatus = "ok" | "degraded" | "missing" | "unknown" | string;

export type VaultStatus = {
  exists: boolean;
  path: string | null;
  note_count: number;
  size_bytes: number;
  last_modified: string | null;
};

export type BrainStatus = {
  exists: boolean;
  path: string | null;
  size_bytes: number;
  last_modified: string | null;
  age_hours: number | null;
};

export type QdrantCollection = {
  name: string;
  points_count: number | null;
  vectors_count: number | null;
  status: string | null;
};

export type QdrantMemoryStatus = {
  up: boolean;
  error: string | null;
  collections: QdrantCollection[];
};

export type MemoryStatusInfo = {
  vault: VaultStatus;
  brain: BrainStatus;
  qdrant: QdrantMemoryStatus;
};

export type BrainResult = {
  id: number;
  path: string;
  layer: string;
  category: string;
  domain: string;
  title: string;
  snippet: string;
  rank: number;
};

export type MemoryActionResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  action: string;
};

export type MemoryActionKey =
  | "vault-sync"
  | "brain-update"
  | "qdrant-reembed"
  | "skills-reembed";

// Usage (Claude Code stats-cache.json)

export type WindowStats = {
  days: number;
  messages: number;
  sessions: number;
  tool_calls: number;
  tokens_total: number;
  tokens_by_model: Record<string, number>;
};

export type ModelStat = {
  name: string;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_create: number;
  total: number;
};

export type DailyPoint = {
  date: string;
  messages: number;
  sessions: number;
  tool_calls: number;
  tokens: number;
};

export type SettingsSnapshot = {
  path: string;
  content: Record<string, unknown>;
  modified: string | null;
  size_bytes: number;
  backup_dir: string;
  recent_backups: string[];
};

export type SettingsSaveResult = {
  success: boolean;
  backup_path: string | null;
  new_size_bytes: number;
};

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

export type SpawnFlags = {
  dangerouslySkipPermissions?: boolean;
  continueLast?: boolean;
  forkSession?: boolean;
  model?: string | null;
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | null;
  name?: string | null;
  resumeId?: string | null;
  /** Optional subagent slug (filename stem under `~/.claude/agents/`).
   *  When set, the Rust backend prepends `[USE AGENT: <slug>]` to the
   *  prompt before the Claude session starts. v2.0: pass it explicitly
   *  per call-site (no AI Router). */
  agent?: string | null;
  /** When true, the wrapper script copies the prompt to the clipboard
   *  and opens the CLI without auto-submitting. Mirrors the Rust
   *  `paste_only` flag. */
  pasteOnly?: boolean;
  /** When true, the wrapper script will NOT overwrite the clipboard.
   *  Used by callers that primed the clipboard themselves (news pipeline). */
  respectClipboard?: boolean;
};

export type ClaudeSession = {
  id: string;
  project_slug: string;
  project_label: string;
  preview: string | null;
  size_bytes: number;
  last_activity: string | null;
  line_count: number;
};

export type GameProcessInfo = {
  pid: number;
  name: string;
  ram_mb: number;
  category: string;
  suggested: boolean;
  keep_default: boolean;
};

export type KillFailure = {
  pid: number;
  reason: string;
};

export type KillResult = {
  killed: number[];
  failed: KillFailure[];
  freed_mb_estimate: number;
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

export type UsageReport = {
  last_computed_date: string | null;
  cache_age_days: number | null;
  first_session_date: string | null;
  total_sessions: number;
  total_messages: number;
  today: WindowStats;
  last_7_days: WindowStats;
  last_30_days: WindowStats;
  model_totals: ModelStat[];
  daily_recent: DailyPoint[];
  hour_counts: number[];
};

export type SkillState = "active" | "plugin" | "vaulted" | "quarantined" | string;

export type SecurityDecision = "allow" | "warn" | "quarantine" | "block";

export type SecurityInfo = {
  decision: SecurityDecision | string;
  findings_count?: number;
  high_severity_rules?: string[];
  sha1?: string | null;
  scanned_at?: string | null;
};

export type SkillFinding = {
  rule_id: string;
  severity: string;
  pattern_name: string;
  excerpt: string;
  line_number: number | null;
  waived: boolean;
};

export type SkillSecurityReport = {
  name: string;
  decision: string;
  sha1: string | null;
  findings: SkillFinding[];
  stderr: string;
};

export type AllowSkillResult = {
  success: boolean;
  name: string;
  sha1: string;
  waiver_path: string;
};

export type AgentInfo = {
  name: string;
  description: string | null;
  model: string | null;
  tools: string[];
  path: string | null;
  size_bytes: number;
  last_modified: number | null;
  /** Optional security verdict — populated when an agent registry / scan
   *  pre-computed this. The Agents tab also fetches a fresh report on
   *  demand via `get_agent_findings`, so this field is best-effort and
   *  may be absent even when findings exist. */
  security?: SecurityInfo | null;
};

export type AgentMutationResult = {
  success: boolean;
  name: string;
  path: string;
  backup_path: string | null;
};

/** Symmetric with SkillFinding — agents go through the same scanner. */
export type AgentFinding = {
  rule_id: string;
  severity: string;
  pattern_name: string;
  excerpt: string;
  line_number: number | null;
  waived: boolean;
};

export type AgentSecurityReport = {
  name: string;
  decision: string;
  sha1: string | null;
  findings: AgentFinding[];
  stderr: string;
};

export type AllowAgentResult = {
  success: boolean;
  name: string;
  sha1: string;
  waiver_path: string;
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

export type SpawnResult = {
  launched: boolean;
  provider: string;
};

export type InlineResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  exit_code: number | null;
};

export type SessionProvider = "claude" | "gemini" | "codex";

/** Kind of a launcher item inside a project's `items[]`.
 *
 * v15.4.11 — el dropdown del UI expone 3 kinds principales (folder /
 * ide / session) más `exe` como avanzado. Los kinds legacy
 * `claude` / `codex` / `gemini` siguen siendo válidos en el backend
 * (proyectos existentes los usan) y se renderizan como built-in chips
 * exactamente como antes. Internamente: `session` = consolidación de
 * los 3, distinguidos por el campo `provider`. `ide` = abrir el path
 * en el IDE preferido del proyecto.
 */
export type LauncherItemKind =
  | "exe"
  | "folder"
  | "claude"
  | "codex"
  | "gemini"
  | "ide"
  | "session";

/** A single thing to launch from a project. The Rust side dispatches on
 *  `kind`; the other fields are payload-shaped:
 *   - exe     → `path` (absolute) + optional `args[]`
 *   - folder  → `path` (absolute directory)
 *   - claude/codex/gemini → `cwd` (absolute directory)  [legacy kinds]
 *   - session → `cwd` (absolute) + `provider` field elige el binario.
 *   - ide     → resuelve el path del proyecto y abre el preferred_ide.
 *  `label` is free text shown in the row chip (falls back to a derived
 *  string built from the path tail). */
export type LauncherItem = {
  kind: LauncherItemKind | string;
  path?: string | null;
  cwd?: string | null;
  args?: string[] | null;
  label?: string | null;
  /** v15.4.11 — solo aplica cuando kind === "session". Uno de
   *  claude/codex/gemini. */
  provider?: SessionProvider | null;
};

export type ProjectInfo = {
  id: string;
  name: string | null;
  path: string | null;
  ide: string | null;
  language: string | null;
  type_: string | null;
  status: string | null;
  last_active: string | null;
  tags: string[];
  /** Launch group items. When the registry omits this array but supplies a
   *  `path`, the backend synthesises a default
   *  `[folder(path), claude(path)]` pair so old-style entries keep working
   *  without an on-disk migration. */
  items?: LauncherItem[] | null;
  /** Preferred session provider for this project. Always one of
   *  "claude" | "codex" | "gemini" — the Rust loader normalises legacy
   *  entries (missing field / typos) to "claude" before returning, so the
   *  UI can safely read it without a null check. */
  default_provider?: SessionProvider | null;
};

export type ProjectActionResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  exit_code: number | null;
};

export type CreateProjectResult = {
  success: boolean;
  id: string;
  message: string;
};

export type SkillInfo = {
  name: string;
  state: SkillState;
  source: string | null;
  description: string | null;
  tags: string[];
  path: string | null;
  usage_count: number;
  security?: SecurityInfo | null;
};

export type SkillCreateResult = {
  success: boolean;
  name: string;
  path: string;
  layer: string;
};

export type SkillUpdateResult = {
  success: boolean;
  name: string;
  path: string;
  backup_path: string;
};

export type SkillDeleteResult = {
  success: boolean;
  name: string;
  from_path: string;
  to_path: string;
  soft: boolean;
};

export type McpInfo = {
  name: string;
  transport: string; // "stdio" | "http" | "sse"
  command: string | null;
  args_preview: string | null;
  url: string | null;
  status: McpStatus;
  last_checked: string | null;
  fallback_message: string | null;
  alert_severity: string | null;
  expected_offline: boolean;
};

export type McpMutationResult = {
  success: boolean;
  name: string;
  backup_path: string | null;
};

export type McpGenerationResult = {
  success: boolean;
  name: string;
  config: Record<string, unknown>;
  raw_output: string;
};

// Auth / Mode types.

export type AuthStatusEntry = {
  provider: string;
  logged_in: boolean;
  credential_path: string;
  last_modified: string | null;
  age_days: number | null;
  binary_present: boolean;
  binary_path: string | null;
  note: string | null;
};

export type AuthStatusReport = {
  entries: AuthStatusEntry[];
};

export type UltronMode = "LOW" | "MEDIUM" | "HIGH" | "ULTRA";

export type ModeInfo = {
  mode: string | null;
  raw: Record<string, unknown>;
};

export type ModeSetResult = {
  success: boolean;
  mode: string;
  path: string;
};

export type ReviewResult = {
  success: boolean;
  stdout: string;
  stderr: string;
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
