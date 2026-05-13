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
