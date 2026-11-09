import type { McpInfo } from "../../types";

// Origin chip. The backend merges: the user scope of ~/.claude.json
// ("user", editable here), project scopes (~/.claude.json projects and
// .mcp.json), installed plugins, and the legacy mcpServers of
// ~/.claude/settings.json ("settings": Claude Code does not read it, so it
// can only be deleted from here).
export type McpOriginKind = "user" | "project" | "plugin" | "settings" | "unknown";

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

