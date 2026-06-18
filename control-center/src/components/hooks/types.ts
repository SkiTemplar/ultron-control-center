// Types for Hooks viewer — mirrors src-tauri/src/hooks_admin.rs

export type HookRecord = {
  id: string;
  event: string;
  matcher: string | null;
  command: string;
  enabled: boolean;
  source: string;
  /** Human-readable description from settings.json group entry (populated by Rust backend). */
  description: string | null;
  extra: Record<string, unknown>;
};

export type HooksList = {
  hooks: HookRecord[];
  settings_path: string;
  settings_exists: boolean;
};

export type HookMutationResult = {
  success: boolean;
  hook: HookRecord | null;
  backup_path: string | null;
};

export type HookTestResult = {
  success: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  elapsed_ms: number;
  timed_out: boolean;
};

export type HookFire = {
  timestamp: string | null;
  event: string | null;
  hook_id: string | null;
  matcher: string | null;
  exit_code: number | null;
  raw: Record<string, unknown>;
};

export type HookFiresReport = {
  fires: HookFire[];
  log_path: string;
  instrumented: boolean;
};

export type HookNameResult = {
  id: string;
  name: string;
  strategy: string;
  cached: boolean;
};

/** Readable title + one-line summary per hook (from get_hook_descriptions). */
export type HookDescription = {
  id: string;
  title: string;
  summary: string;
  source: string;
};
