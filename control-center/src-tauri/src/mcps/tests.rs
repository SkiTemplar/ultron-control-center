// mcps/tests.rs — unit tests for mcps module.

use std::collections::BTreeMap;

use super::types_io::{
    build_mcp_info, is_unknown_mcp, normalize_mcp_name, FallbackEntry, HealthDoc, McpInfo,
    McpServerCfg,
};

/// Parse a top-level + project-scoped `~/.claude.json` blob the same way
/// `collect_claude_json_mcps` does, but from an in-memory string so the
/// test is hermetic (no dependency on the real home file).
fn collect_from_value(value: &serde_json::Value) -> Vec<(String, String, McpServerCfg)> {
    let mut out: Vec<(String, String, McpServerCfg)> = Vec::new();
    if let Some(obj) = value.get("mcpServers").and_then(|v| v.as_object()) {
        for (name, cfg_val) in obj.iter() {
            if let Ok(cfg) = serde_json::from_value::<McpServerCfg>(cfg_val.clone()) {
                out.push(("user-claudejson".to_string(), name.clone(), cfg));
            }
        }
    }
    if let Some(projects) = value.get("projects").and_then(|v| v.as_object()) {
        for (proj_path, proj_val) in projects.iter() {
            let Some(servers) = proj_val.get("mcpServers").and_then(|v| v.as_object()) else {
                continue;
            };
            let basename = std::path::Path::new(proj_path)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(proj_path.as_str());
            let origin = format!("project:{}", basename);
            for (name, cfg_val) in servers.iter() {
                if let Ok(cfg) = serde_json::from_value::<McpServerCfg>(cfg_val.clone()) {
                    out.push((origin.clone(), name.clone(), cfg));
                }
            }
        }
    }
    out
}

fn sample_claude_json() -> serde_json::Value {
    serde_json::json!({
        "mcpServers": {
            "railway-mcp-server": { "type": "stdio", "command": "npx", "args": ["-y", "railway"], "env": {} },
            "github-pat": { "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": {} },
            "qdrant": { "type": "stdio", "command": "uvx", "args": ["mcp-server-qdrant"], "env": {} }
        },
        "projects": {
            "C:\\Users\\Dev": {
                "mcpServers": {
                    "gemini": { "type": "stdio", "command": "npx", "args": ["-y", "gemini-mcp"], "env": {} }
                }
            },
            "C:\\Windows\\System32": {
                "mcpServers": {
                    "memory": { "type": "stdio", "command": "node", "args": ["mem.js"] },
                    "playwright": { "type": "stdio", "command": "npx", "args": ["-y", "@playwright/mcp"] },
                    "context7": { "type": "stdio", "command": "npx", "args": ["-y", "context7"] },
                    "sequential-thinking": { "type": "stdio", "command": "npx", "args": ["-y", "seq"] },
                    "discord": { "type": "stdio", "command": "npx", "args": ["-y", "discord-mcp"], "disabled": true }
                }
            },
            "C:\\Users\\Dev\\skills": {
                "mcpServers": {
                    "sequential-thinking": { "type": "stdio", "command": "npx", "args": ["-y", "seq"] }
                }
            }
        }
    })
}

#[test]
fn parses_top_level_and_project_scoped_servers() {
    let v = sample_claude_json();
    let collected = collect_from_value(&v);

    // 3 top-level + 1 (Dev) + 5 (System32) + 1 (skills) = 10 entries.
    assert_eq!(collected.len(), 10);

    // Top-level entries carry the user-claudejson origin.
    let top: Vec<&String> = collected
        .iter()
        .filter(|(o, _, _)| o == "user-claudejson")
        .map(|(_, n, _)| n)
        .collect();
    assert_eq!(top.len(), 3);
    assert!(top.iter().any(|n| n.as_str() == "qdrant"));

    // Project basename (not full path) is used in the origin.
    assert!(collected
        .iter()
        .any(|(o, n, _)| o == "project:System32" && n == "memory"));
    assert!(collected
        .iter()
        .any(|(o, n, _)| o == "project:Dev" && n == "gemini"));

    // disabled flag is parsed through McpServerCfg.
    let discord = collected
        .iter()
        .find(|(_, n, _)| n == "discord")
        .expect("discord present");
    assert!(discord.2.disabled);
}

#[test]
fn dedup_collapses_duplicate_normalised_names() {
    // Build McpInfos the way the aggregator does, then run the same
    // dedup-by-normalised-name pass.
    let health = HealthDoc {
        checked_at: None,
        results: BTreeMap::new(),
    };
    let fallbacks: BTreeMap<String, FallbackEntry> = BTreeMap::new();
    let v = sample_claude_json();
    let collected = collect_from_value(&v);

    let raw: Vec<McpInfo> = collected
        .iter()
        .map(|(origin, name, cfg)| {
            let plugin = origin.strip_prefix("project:").map(|p| p.to_string());
            build_mcp_info(name, cfg, origin.clone(), plugin, &health, &fallbacks)
        })
        .collect();

    // Run the collapse pass.
    let mut deduped: Vec<McpInfo> = Vec::new();
    let mut idx_by_norm: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    for info in raw.into_iter() {
        let norm = normalize_mcp_name(&info.name);
        if let Some(&i) = idx_by_norm.get(&norm) {
            let canonical = &mut deduped[i];
            canonical.duplicate_count += 1;
            if !canonical.duplicate_origins.contains(&info.origin) {
                canonical.duplicate_origins.push(info.origin.clone());
            }
        } else {
            idx_by_norm.insert(norm, deduped.len());
            deduped.push(info);
        }
    }

    // sequential-thinking appears in two projects -> collapses to 1 row,
    // count 2, two distinct origins.
    let seq = deduped
        .iter()
        .find(|m| normalize_mcp_name(&m.name) == "sequential-thinking")
        .expect("sequential-thinking row present");
    assert_eq!(seq.duplicate_count, 2);
    assert_eq!(seq.duplicate_origins.len(), 2);

    // 10 raw entries, one duplicate pair -> 9 unique rows.
    assert_eq!(deduped.len(), 9);
}

#[test]
fn unknown_flag_marks_unrecognised_servers() {
    // Known (after normalisation): railway-mcp-server -> railway,
    // github-pat is NOT in the known set (normalises to "github-pat").
    assert!(!is_unknown_mcp("railway-mcp-server"));
    assert!(!is_unknown_mcp("qdrant"));
    assert!(!is_unknown_mcp("sequential-thinking"));
    assert!(!is_unknown_mcp("superpowers-mcp"));
    assert!(!is_unknown_mcp("github"));

    // exa + discord are now recognised (added to KNOWN_MCP_NAMES — both
    // ship a well-known description, so flagging them as unknown was wrong).
    assert!(!is_unknown_mcp("exa"));
    assert!(!is_unknown_mcp("discord"));
    // Genuinely unknown servers are still flagged.
    assert!(is_unknown_mcp("fakechat"));
    assert!(is_unknown_mcp("imessage"));
    // github-pat is a user-specific alias, not the canonical "github".
    assert!(is_unknown_mcp("github-pat"));
}

#[test]
fn normalize_strips_scaffolding_affixes() {
    assert_eq!(normalize_mcp_name("railway-mcp-server"), "railway");
    assert_eq!(normalize_mcp_name("superpowers-mcp"), "superpowers");
    assert_eq!(normalize_mcp_name("mcp-server-github"), "github");
    assert_eq!(
        normalize_mcp_name("Sequential-Thinking"),
        "sequential-thinking"
    );
}
