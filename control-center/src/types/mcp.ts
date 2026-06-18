// MCP server info, mutation results, ping, plugin info, and hook last-fired types.

import type { McpStatus } from "./core";

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
  /** Human-readable description of what this MCP server does. */
  description?: string;
  /** iter-10 — true when the server name is not in the curated known set. */
  unknown?: boolean;
  /** iter-10 — how many config entries collapsed onto this name (>1 = dup). */
  duplicate_count?: number;
  /** iter-10 — origins of every entry that collapsed onto this name. */
  duplicate_origins?: string[];
  /** iter-10 — true when the config carries disabled:true (not spawned). */
  disabled?: boolean;
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
