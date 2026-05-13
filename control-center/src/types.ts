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

export type SkillState = "active" | "plugin" | "vaulted" | string;

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
};

export type ProjectActionResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  exit_code: number | null;
};

export type SkillInfo = {
  name: string;
  state: SkillState;
  source: string | null;
  description: string | null;
  tags: string[];
  path: string | null;
  usage_count: number;
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
