import type { McpInfo } from "../../types";

// v2.0 origin chip — Claudia-compatible provenance tagging. The backend
// now merges three sources: user settings.json, plugin .mcp.json files,
// and project-level .mcp.json files. The chip lets the user see at a
// glance where a given MCP came from (and why it can't be edited from
// here when it's plugin-owned).
export type McpOriginKind = "user" | "project" | "plugin" | "unknown";

// Extended view of McpInfo that includes the v2.0 origin/plugin fields,
// the v2.7 description field, and the iter-10 detection fields.
export type McpInfoExt = McpInfo & {
  origin?: string;
  plugin?: string | null;
  description?: string;
  unknown?: boolean;
  duplicate_count?: number;
  duplicate_origins?: string[];
  disabled?: boolean;
};

export type Transport = "stdio" | "http" | "sse";

export type EditableMcp = {
  name: string;
  transport: Transport;
  command: string;
  argsText: string; // one arg per line
  envRows: { key: string; value: string }[];
  url: string;
};

export type Action = "hide" | "edit" | "delete" | "test";

export type EnableDisableMcp = {
  name: string;
  cfg: Record<string, unknown> & { disabled?: boolean };
};
