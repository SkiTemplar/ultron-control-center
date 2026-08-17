// mcps/mod.rs — MCP discovery, health, CRUD mutations and AI generation.
//
// Resolves a unified MCP view by joining three sources:
//   1. ~/.claude/settings.json mcpServers       (configured MCPs)
//   2. ~/.ultron/.tmp/mcp-health.json           (last probe results)
//   3. ~/.ultron/config/mcp-fallbacks.yaml      (fallback messages, severity,
//                                                expected_offline flag)
//
// Frontend uses this for the MCPs tab cards. CRUD mutations (add/update/
// delete) round-trip through settings::settings_save_inner so we get the
// timestamped backup + atomic write for free.

pub(crate) mod accounts;
pub(crate) mod discovery;
pub(crate) mod mutations_gen;
#[cfg(test)]
mod tests;
pub(crate) mod types_io;

pub use accounts::{
    account_add_inner, account_remove_inner, accounts_list_inner, McpAccountRow,
    McpAccountTemplate, TEMPLATES,
};
pub use discovery::list_mcps_inner;
pub use mutations_gen::{
    add_mcp_inner, delete_mcp_inner, generate_mcp_from_prompt_inner, mcp_ping_inner,
    set_mcpjson_disabled_inner, update_mcp_inner,
};
pub use types_io::{McpGenerationResult, McpInfo, McpMutationResult, McpPingResult};
