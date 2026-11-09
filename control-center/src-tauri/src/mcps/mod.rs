// mcps/mod.rs — MCP discovery, health, CRUD mutations and AI generation.
//
// Resolves a unified MCP view by joining these sources:
//   1. ~/.claude.json mcpServers (user scope) and projects.<path>.mcpServers
//   2. installed + enabled plugins' .mcp.json / plugin.json
//   3. project .mcp.json files of the projects registered in ULTRON
//   4. ~/.claude/settings.json mcpServers (legacy; Claude Code does not read it)
// plus ~/.ultron/.tmp/mcp-health.json (last probe results) and
// ~/.ultron/config/mcp-fallbacks.yaml (fallback messages, severity,
// expected_offline flag).
//
// CRUD mutations (add/update/delete) write the user scope of ~/.claude.json
// through `claude_json::ClaudeJsonStore` (backup + atomic write + optimistic
// re-read). The "Test" button and the health check share the same source
// union (`discovery::collect_all_sources`) and live in `ping.rs`.

pub(crate) mod accounts;
pub(crate) mod claude_json;
pub(crate) mod commands;
pub(crate) mod confianza;
pub(crate) mod discovery;
pub(crate) mod mutations_gen;
pub(crate) mod ping;
#[cfg(test)]
mod tests;
pub(crate) mod types_io;

pub use accounts::{
    account_add_inner, account_remove_inner, accounts_list_inner, McpAccountRow,
    McpAccountTemplate, TEMPLATES,
};
pub use discovery::list_mcps_inner;
pub use mutations_gen::{
    add_mcp_inner, delete_mcp_inner, set_mcpjson_disabled_inner, update_mcp_inner,
};
pub use ping::mcp_ping_inner;
pub use types_io::{McpInfo, McpMutationResult, McpPingResult};
