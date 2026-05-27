// Local type mirrors of crate::memory_status::* and related backend types.
// Extracted from Memory.tsx (1151 L) as part of the P1 split refactor.
// Named memoryTypes.ts (not types.ts) to avoid collision with existing files
// in this directory if any are added later.

export type Mem0CardStatus = {
  healthy: boolean;
  api_key_present: boolean;
  api_key_masked: string | null;
  memory_count: number | null;
  last_write_ts: string | null;
  last_op: string | null;
  log_path: string;
  error: string | null;
};

export type EccCardStatus = {
  healthy: boolean;
  source_path: string | null;
  entity_count: number;
  relation_count: number;
  bytes: number;
  error: string | null;
};

export type GraphifyCardStatus = {
  healthy: boolean;
  installed: boolean;
  version: string | null;
  project_count: number | null;
  projects: string[];
  error: string | null;
};

export type MemoryFilesCardStatus = {
  healthy: boolean;
  file_count: number;
  total_bytes: number;
  root: string;
  error: string | null;
};

export type SyncResult = {
  ok: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
};

export type IndexResult = {
  ok: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
};

export type EccEntity = {
  name: string;
  entity_type: string;
  observations: string[];
};

export type EccRelation = { from: string; to: string; relation_type: string };

export type EccMemorySnapshot = {
  source_path: string | null;
  searched_paths: string[];
  entities: EccEntity[];
  relations: EccRelation[];
  generated_at: string;
};

export type KgEntity = {
  name: string;
  entity_type: string;
  observations: string[];
};

export type KgRelation = { from: string; to: string; relation_type: string };

export type KgGraph = { entities: KgEntity[]; relations: KgRelation[] };

export type Mem0LogEntry = {
  timestamp: string;
  op: string;
  ok: boolean;
  status_code: number | null;
  latency_ms: number | null;
  error: string | null;
  body_excerpt: string | null;
  query: string | null;
};

export type Mem0DiagnosticsData = {
  api_key_present: boolean;
  api_key_masked: string | null;
  api_key_error: string | null;
  endpoint: string;
  log_path: string;
  last_success: Mem0LogEntry | null;
  last_error: Mem0LogEntry | null;
  recent: Mem0LogEntry[];
};

export type Mem0Status = {
  connected: boolean;
  api_key_masked: string | null;
  latency_ms: number | null;
  error: string | null;
};

export const DEBOUNCE_MS = 300;
export const DEFAULT_LIMIT = 30;
export const STATUS_REFRESH_MS = 30_000;

export type MemoryViewMode = "tree" | "status" | "brain" | "mem0" | "ecc" | "kg";
