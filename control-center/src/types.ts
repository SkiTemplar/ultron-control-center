// Shared types between Tauri Rust commands and React frontend.

export type CmdResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  exit_code: number | null;
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

export type GlobalStatus = "ok" | "warn" | "down" | "loading";

export type McpStatus = "ok" | "degraded" | "missing" | "unknown" | string;

// Mem0 (Memory panel — v2.0)

export type Mem0Status = {
  connected: boolean;
  api_key_masked: string | null;
  latency_ms: number | null;
  error: string | null;
};

export type Mem0Memory = {
  id: string;
  memory: string;
  user_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  metadata: Record<string, unknown> | null;
};

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

/** Aggregated view of one workspace folder under `~/.claude/projects/`.
 *  Mirrors `claude_sessions::WorkspaceSummary` on the Rust side. The
 *  Sessions tab uses this for the "Recent workspaces" grid: each card
 *  resumes `latest_session_id` or spawns a new session in `cwd`. */
export type WorkspaceSummary = {
  cwd: string;
  project_id: string | null;
  project_name: string | null;
  last_activity: string | null;
  session_count: number;
  latest_session_id: string | null;
  /** Nearest ancestor that contains `.git/`, when distinct from `cwd`.
   *  When non-null, the workspace card surfaces a "Use git root" chip so the
   *  user can spawn the next session at the repo root instead of in the
   *  subfolder Claude originally recorded. Fixes the .ultron/control-center
   *  vs .ultron friction. */
  git_root: string | null;
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

// ---------------------------------------------------------------------------
// AI Router usage summary (v2.9.3)
// Mirrors `ai_router::ProviderUsageRow` and `ai_router::UsageSummary` in Rust.
// ---------------------------------------------------------------------------

/** How a provider authenticates. CLI providers use "cli-installed" or
 *  "cli-missing" instead of the API-key sources "env" / "none" / "local". */
export type ProviderKeySource =
  | "env"
  | "local"
  | "none"
  | "cli-installed"
  | "cli-missing";

export type ProviderUsageRow = {
  provider_id: string;
  provider_label: string;
  key_env_var: string;
  key_present: boolean;
  key_masked: string | null;
  call_count: number;
  /** Successful calls — para el success-rate del rediseno. */
  success_count: number;
  /** Output tokens acumulados servidos por este proveedor. */
  total_tokens: number;
  latency_ms_avg: number;
  primary_for_zones: string[];
  fallback_for_zones: string[];
  /** Published free-tier daily request limit (RPD). null = no free tier. */
  free_tier_limit: number | null;
  /** Requests routed to this provider today (UTC). */
  free_tier_used_today: number;
  /** % of the daily free tier consumed today. null when no known limit. */
  free_tier_pct: number | null;
};

export type RouterUsageSummary = {
  providers: ProviderUsageRow[];
  /** Global EMA fallback rate across all routes (0.0–1.0). */
  fallback_rate: number;
  /** Per-zone chain: zone_id → [primary_id, fallback1_id, ...] */
  zone_chains: Record<string, string[]>;
};

export type SkillState = "active" | "plugin" | "vaulted" | "quarantined" | string;

// ---------------------------------------------------------------------------
// Control Center 2.0 (P2): origin-aware Skills/Agents + Rules viewer.
// ---------------------------------------------------------------------------

export type SkillOrigin = "global" | "project" | "plugin";

export type SkillEntry = {
  name: string;
  path: string;
  description: string;
  origin: SkillOrigin;
  enabled: boolean;
};

export type AgentEntry = {
  name: string;
  path: string;
  description: string;
  origin: SkillOrigin;
  /** `false` when the agent file is `<name>.md.disabled` instead of
   * `<name>.md`. Only meaningful for global agents — plugin/project agents
   * always read as enabled here. */
  enabled: boolean;
};

export type RuleFile = {
  name: string;
  path: string;
  relative: string;
  preview: string;
};

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
  /** fb-016 — preferred shell for non-AI terminals spawned in this
   *  project's workspace. One of "powershell" | "powershell-admin" |
   *  "cmd" | "bash". `null`/missing = use the global default. */
  default_shell?: ProjectShell | null;
  /** fb-016 — override the cwd terminals open in. When set, takes
   *  precedence over the project's `path`. Useful when work happens in a
   *  sub-directory of the repo. */
  parent_folder_override?: string | null;
  /** fb-016 — free-form project notes (markdown / plain text). Distinct
   *  from the standalone Notes tab — these live next to the project
   *  registry entry. */
  notes?: string | null;
  /** v2.6.2 — list of bound executables surfaced as Quick Launch buttons in
   *  the Project Home. Distinct from `items[]` launcher chips: these are
   *  edited via the Project Edit modal and rendered with a separate UI. */
  executables?: ProjectExecutable[] | null;
};

/** fb-016 — allowed values for `Project.default_shell`. Mirrors the Rust
 *  `VALID_SHELLS` allowlist. */
export type ProjectShell =
  | "powershell"
  | "powershell-admin"
  | "cmd"
  | "bash";

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

// v2.6.2 — kanban archive types. Done cards can be moved into named archive
// groups under ~/.ultron/cockpit/projects/<project_id>/archives/<name>.json.
// The list summary keeps the body slim (no cards) so the toolbar grid renders
// quickly; the full payload is fetched on box click.
export type KanbanArchiveSummary = {
  name: string;
  archived_at: string;
  card_count: number;
};

export type KanbanArchive = {
  name: string;
  archived_at: string;
  cards: Array<{
    id: string;
    title: string;
    description: string;
    tags: string[];
    column_name: string;
    archived_from_column_id: string;
  }>;
};

// v2.6.2 — per-project executables for Quick Launch in Project Home.
// Persisted on the project registry entry as an `executables[]` array.
export type ProjectExecutable = {
  name: string;
  path: string;
  args?: string[] | null;
  icon?: string | null;
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
  /** v2.2 — origin tag: "user" | "project:<slug>" | "plugin:<slug>". */
  origin?: string;
  /** v2.2 — plugin or project slug when origin starts with plugin:/project:. */
  plugin?: string | null;
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

// ---------------------------------------------------------------------------
// Control Center 2.0 (P3): embedded PTY (portable-pty + xterm.js).
// ---------------------------------------------------------------------------

export type PtyStatus =
  | { kind: "running" }
  | { kind: "exited"; value: number }
  | { kind: "killed" };

export type PtySessionSummary = {
  id: string;
  project_id: string;
  card_id: string | null;
  provider: string;
  started_at: string;
  status: PtyStatus;
};

export type PtyDataEvent = { data: string };
export type PtyExitEvent = { exit_code: number };

// ---- P4: Kanban + tabs ----

export type RunStatus =
  | { kind: "running" }
  | { kind: "completed" }
  | { kind: "killed" }
  | { kind: "failed" };

export type CardRun = {
  session_id: string;
  started_at: string;
  ended_at: string | null;
  status: RunStatus;
  exit_code: number | null;
};

export type Card = {
  id: string;
  column_id: string;
  title: string;
  description: string;
  agent: string | null;
  prompt_template: string | null;
  cwd: string | null;
  tags: string[];
  order: number;
  created_at: string;
  updated_at: string;
  runs: CardRun[];
};

export type ColumnRole = "todo" | "doing" | "blocked" | "done" | "other";

export type Column = {
  id: string;
  name: string;
  order: number;
  role: ColumnRole;
};

export type KanbanBoard = {
  project_id: string;
  columns: Column[];
  cards: Card[];
  default_agent: string | null;
  default_prompt_template: string | null;
  schema_version: number;
};

export type CardPartial = {
  title: string;
  description?: string;
  agent?: string | null;
  prompt_template?: string | null;
  cwd?: string | null;
  tags?: string[];
};

export type CardPatch = {
  title?: string;
  description?: string;
  agent?: string | null;
  prompt_template?: string | null;
  cwd?: string | null;
  tags?: string[];
};

export type OpenTab = {
  id: string;        // "home" | project_id
  kind: "home" | "project";
  title: string;
  order: number;
};

export type ProjectSubTab =
  | "jarvis"
  | "board"
  | "terminal"
  | "agents"
  | "context"
  | "sessions"
  | "notes"
  | "timeline"
  | "decisions";

// ---------------------------------------------------------------------------
// Project Timeline (per-project derived event feed)
// ---------------------------------------------------------------------------

export type TimelineEventKind =
  | "session"        // claude code session opened in the project dir
  | "card_created"   // kanban card created
  | "card_moved"     // kanban card moved between columns
  | "card_run"       // kanban card spawned a PTY run
  | "backup";        // last backup snapshot covering the project root

export type TimelineEvent = {
  kind: TimelineEventKind;
  /** ISO-8601 or "epoch:<secs>" timestamp; sorted as a string desc. */
  at: string;
  /** Short label rendered in the event card title. */
  title: string;
  /** Optional secondary line (column transition, agent name, etc). */
  detail: string | null;
  /** Optional reference id for click-through (card_id, session_id, ...). */
  ref_id: string | null;
};

// ---------------------------------------------------------------------------
// Decision Registry (KIRKARDO 24)
// ---------------------------------------------------------------------------

export type DecisionStatus = "proposed" | "accepted" | "superseded" | "rejected";

export type DecisionRecord = {
  id: string;
  project_id: string;
  /** Short title — the "what was decided" */
  decision: string;
  /** The reasoning */
  rationale: string;
  alternatives_considered: string[];
  /** "epoch:<secs>" */
  date: string;
  status: DecisionStatus;
  supersedes_id: string | null;
  context_urls: string[];
  author: string | null;
  tags: string[];
};

export type DecisionPayload = {
  decision: string;
  rationale: string;
  alternatives_considered?: string[];
  status?: DecisionStatus;
  supersedes_id?: string | null;
  context_urls?: string[];
  author?: string | null;
  tags?: string[];
};

export type DecisionPatch = Partial<DecisionPayload> & {
  supersedes_id?: string | null;
  author?: string | null;
};

export type DecisionSearchResult = {
  record: DecisionRecord;
  score: number;
};

// ---------------------------------------------------------------------------
// Library (P5): agent/skill discovery + install + pinning.
// ---------------------------------------------------------------------------

export type LibraryKind = "agent" | "skill";

export type TargetScope = "global" | "project";

export type RemoteItem = {
  owner: string;
  repo: string;
  path: string;
  name: string;
  html_url: string | null;
  preview: string | null;
};

export type PinnedAgents = {
  pinned: string[];
};

export type AgentCreateInput = {
  name: string;
  description: string;
  tools: string[];
  model: string | null;
  body: string;
  target_scope: TargetScope;
  target_project_id: string | null;
};

export type SkillCreateInput = {
  name: string;
  description: string;
  body: string;
  target_scope: TargetScope;
  target_project_id: string | null;
};

export type InstallInput = {
  owner: string;
  repo: string;
  path: string;
  kind: LibraryKind;
  target_scope: TargetScope;
  target_project_id: string | null;
  target_name: string | null;
  overwrite: boolean;
};

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
  mem0_configured: boolean;
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

// ---------------------------------------------------------------------------
// Settings (P7): plugin info + MCP ping + hooks last fired.
// ---------------------------------------------------------------------------

export type PluginInfo = {
  installed: boolean;
  version: string | null;
  root: string | null;
  last_update_iso: string | null;
  skills_count: number;
  agents_count: number;
  hooks_count: number;
  mcp_servers_count: number;
};

export type McpPingResult = {
  name: string;
  ok: boolean;
  latency_ms: number | null;
  error: string | null;
};

export type HookLastFired = {
  id: string;
  timestamp: string | null;
  project: string | null;
  exit_code: number | null;
};

// ---------------------------------------------------------------------------
// Slash command registry (v2.3 — Library → Commands sub-tab).
// ---------------------------------------------------------------------------

export type SlashCommand = {
  /** Bare command name (file stem). */
  name: string;
  /** Plugin slug — `ecc`, `superpowers`, `commit-commands`, …
   *  Special value `user` for `~/.claude/commands/*`. */
  plugin: string;
  /** Marketplace folder — `ecc`, `claude-plugins-official`,
   *  `superpowers-marketplace`, `openai-codex`, …
   *  Special value `user` for the user-local namespace. */
  marketplace: string;
  /** Summary — frontmatter `description:` when present, else first prose paragraph. */
  description: string;
  /** Optional `argument-hint:` from frontmatter. */
  argument_hint: string | null;
  /** Optional `model:` override from frontmatter. */
  model: string | null;
  /** Absolute on-disk path to the .md source. */
  path: string;
};

// ---------------------------------------------------------------------------
// Qdrant semantic recall (v2.9.5 — KIRKARDO Round 7 #2)
// Mirrors `qdrant::QdrantHit` on the Rust side.
// payload keys: text, kind, importance, project, date, sha_head, session_id
// ---------------------------------------------------------------------------

/** Known `kind` values stored in Qdrant payloads. */
export type QdrantHitKind =
  | "decision"
  | "bug"
  | "feature"
  | "todo"
  | "file"
  | string;

/** A single result from `invoke("recall_semantic", { query, k })`. */
export type QdrantHit = {
  /** Qdrant point id (normalised to string). */
  id: string;
  /** Cosine similarity score in [0, 1]. */
  score: number;
  /** Arbitrary JSON payload stored alongside the vector.
   *  Known keys: text, kind, importance, project, date, sha_head, session_id */
  payload: {
    text?: string;
    kind?: QdrantHitKind;
    importance?: string | number;
    project?: string;
    date?: string;
    sha_head?: string;
    session_id?: string;
    [key: string]: unknown;
  };
};

/** Return type of `invoke("recall_semantic", ...)`. */
export type RecallSemanticResult = QdrantHit[];

/**
 * Result of `recall_last_session` / `recall_last_session_global`. Built from
 * the most recent Claude Code JSONL transcript for the chosen project (or
 * globally), with a mem0 fallback when no local JSONL matches.
 *
 * Backend: `src-tauri/src/recall.rs::RecallResult`.
 */
export type RecallResult = {
  /** True when either a JSONL transcript or mem0 returned content. */
  found: boolean;
  /** UUID of the matched session (file stem). Null when falling back to mem0
   *  or when nothing was found. */
  session_id: string | null;
  /** ISO 8601 mtime of the matched JSONL. */
  last_active_iso: string | null;
  /** Markdown summary the dialog renders verbatim. */
  summary_md: string;
  /** Paste-ready first prompt for a fresh session. */
  suggested_prompt: string;
  /** "jsonl" | "mem0" | "none". */
  source: string;
};

// ---------------------------------------------------------------------------
// Workdays (v2.8) — mirrors workdays::Workday on the Rust side.
// ---------------------------------------------------------------------------

export type WorkdayStatus =
  | "planned"
  | "in_progress"
  | "paused"
  | "completed"
  | "archived";

export type GoalStatus = "pending" | "done" | "skipped";

export type WorkdayGoal = {
  id: string;
  text: string;
  status: GoalStatus;
};

export type WorkdayContextEntry = {
  id: string;
  kind: string;
  text: string;
  source: string | null;
  created_at: string;
};

export type WorkdayContext = {
  notes: WorkdayContextEntry[];
  decisions: WorkdayContextEntry[];
  file_changes: WorkdayContextEntry[];
  agent_messages: WorkdayContextEntry[];
};

export type Workday = {
  id: string;
  template_id: string | null;
  workflow_template: string | null;
  project_id: string | null;
  project_cwd: string | null;
  title: string;
  status: WorkdayStatus;
  planned_date: string;
  start_ts: string | null;
  end_ts: string | null;
  focus_seconds: number;
  break_seconds: number;
  energy_before: number | null;
  energy_after: number | null;
  mood_note: string | null;
  retro_good: string | null;
  retro_bad: string | null;
  retro_learned: string | null;
  summary_md: string | null;
  goals: WorkdayGoal[];
  linked_sessions: string[];
  linked_tasks: string[];
  context: WorkdayContext;
  created_at: string;
};
