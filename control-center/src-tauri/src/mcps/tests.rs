// mcps/tests.rs — unit tests for mcps module.

use std::collections::BTreeMap;
use std::fs;

use super::discovery::collect_plugin_mcps_from;
use super::types_io::{
    build_mcp_info, is_unknown_mcp, normalize_mcp_name, parse_installed_plugins,
    select_enabled_plugin_paths, FallbackEntry, HealthDoc, InstalledPluginEntry,
    InstalledPluginsDoc, McpInfo, McpServerCfg,
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

// ---------------------------------------------------------------------------
// collect_plugin_mcps_from — installed+enabled plugins only, never
// marketplaces (regression coverage for the "phantom MCPs" bug: Discord,
// Telegram, iMessage etc. showing up despite never being installed).
// ---------------------------------------------------------------------------

/// Build a fake `<home>/.claude/plugins/` tree with:
///   - a `marketplaces/claude-plugins-official/external_plugins/discord/
///     .mcp.json` — present on every real machine's catalogue, never
///     referenced by `installed_plugins.json`, must never leak into results.
///   - `installed_plugins.json` listing exactly the `(plugin_key,
///     install_dir_name)` pairs the caller passes (install dirs are created
///     empty; call `write_plugin_mcp` to drop a `.mcp.json` into one).
///   - `settings.json` with the given `enabledPlugins` map.
fn fake_home_with_plugins(
    installed: &[(&str, &str)],
    enabled: &[(&str, bool)],
) -> tempfile::TempDir {
    let tmp = tempfile::tempdir().expect("tempdir");
    let plugins_root = tmp.path().join(".claude").join("plugins");
    fs::create_dir_all(&plugins_root).expect("mkdir plugins");

    let market_dir = plugins_root
        .join("marketplaces")
        .join("claude-plugins-official")
        .join("external_plugins")
        .join("discord");
    fs::create_dir_all(&market_dir).expect("mkdir marketplace discord");
    fs::write(
        market_dir.join(".mcp.json"),
        r#"{"mcpServers":{"discord":{"command":"bun","args":["run","start"]}}}"#,
    )
    .expect("write marketplace .mcp.json");

    let mut plugins_json = serde_json::Map::new();
    for (key, dir_name) in installed {
        let install_path = plugins_root.join("cache").join(dir_name);
        fs::create_dir_all(&install_path).expect("mkdir install path");
        plugins_json.insert(
            (*key).to_string(),
            serde_json::json!([{
                "scope": "user",
                "installPath": install_path.to_string_lossy(),
                "version": "1.0.0",
            }]),
        );
    }
    fs::write(
        plugins_root.join("installed_plugins.json"),
        serde_json::to_string(&serde_json::json!({ "version": 2, "plugins": plugins_json }))
            .unwrap(),
    )
    .expect("write installed_plugins.json");

    let mut enabled_map = serde_json::Map::new();
    for (key, val) in enabled {
        enabled_map.insert((*key).to_string(), serde_json::json!(val));
    }
    fs::write(
        tmp.path().join(".claude").join("settings.json"),
        serde_json::to_string(&serde_json::json!({ "enabledPlugins": enabled_map })).unwrap(),
    )
    .expect("write settings.json");

    tmp
}

fn write_plugin_mcp(home: &std::path::Path, dir_name: &str, contents: &str) {
    let dir = home
        .join(".claude")
        .join("plugins")
        .join("cache")
        .join(dir_name);
    fs::write(dir.join(".mcp.json"), contents).expect("write .mcp.json");
}

#[test]
fn marketplace_catalogue_entries_never_appear() {
    // (a) A `.mcp.json` sitting in `marketplaces/.../external_plugins/discord`
    // is present on disk but `discord` was never installed — must not surface.
    let tmp = fake_home_with_plugins(&[], &[]);
    let result = collect_plugin_mcps_from(tmp.path());
    assert!(result.is_empty());
    assert!(!result.iter().any(|(_, name, _)| name == "discord"));
}

#[test]
fn installed_and_enabled_plugin_mcp_appears() {
    // (b) Installed + enabled + wrapped `{ "mcpServers": {...} }` shape.
    let tmp = fake_home_with_plugins(
        &[("context7@claude-plugins-official", "context7-022b3c274938")],
        &[("context7@claude-plugins-official", true)],
    );
    write_plugin_mcp(
        tmp.path(),
        "context7-022b3c274938",
        r#"{"mcpServers":{"context7":{"type":"http","url":"https://mcp.context7.com/mcp"}}}"#,
    );

    let result = collect_plugin_mcps_from(tmp.path());
    assert!(result
        .iter()
        .any(|(slug, name, _)| slug == "context7" && name == "context7"));
}

#[test]
fn installed_and_enabled_plugin_flat_mcp_shape_appears() {
    // Same as above but the flat `{ "<name>": {...} }` shape used by
    // `github`/`playwright`/`linear` in the real marketplace catalogue.
    let tmp = fake_home_with_plugins(
        &[("github@claude-plugins-official", "github-022b3c274938")],
        &[("github@claude-plugins-official", true)],
    );
    write_plugin_mcp(
        tmp.path(),
        "github-022b3c274938",
        r#"{"github":{"type":"http","url":"https://api.githubcopilot.com/mcp/"}}"#,
    );

    let result = collect_plugin_mcps_from(tmp.path());
    assert!(result
        .iter()
        .any(|(slug, name, _)| slug == "github" && name == "github"));
}

#[test]
fn installed_but_disabled_plugin_is_excluded() {
    // (c) Installed, but `enabledPlugins` explicitly maps it to `false`.
    let tmp = fake_home_with_plugins(
        &[(
            "playwright@claude-plugins-official",
            "playwright-022b3c274938",
        )],
        &[("playwright@claude-plugins-official", false)],
    );
    write_plugin_mcp(
        tmp.path(),
        "playwright-022b3c274938",
        r#"{"playwright":{"command":"npx","args":["@playwright/mcp@latest"]}}"#,
    );

    let result = collect_plugin_mcps_from(tmp.path());
    assert!(result.is_empty());
}

#[test]
fn missing_installed_plugins_json_yields_empty_without_panic() {
    // (d) No installed_plugins.json at all (fresh install / never used plugins).
    let tmp = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(tmp.path().join(".claude").join("plugins")).expect("mkdir");
    let result = collect_plugin_mcps_from(tmp.path());
    assert!(result.is_empty());
}

#[test]
fn corrupt_installed_plugins_json_yields_empty_without_panic() {
    // (d) installed_plugins.json exists but is not valid JSON.
    let tmp = tempfile::tempdir().expect("tempdir");
    let plugins_root = tmp.path().join(".claude").join("plugins");
    fs::create_dir_all(&plugins_root).expect("mkdir");
    fs::write(
        plugins_root.join("installed_plugins.json"),
        "{ this is not valid json",
    )
    .expect("write corrupt json");

    let result = collect_plugin_mcps_from(tmp.path());
    assert!(result.is_empty());
}

// ---------------------------------------------------------------------------
// Pure selection-logic tests (no filesystem at all)
// ---------------------------------------------------------------------------

#[test]
fn parse_installed_plugins_malformed_json_yields_empty_doc() {
    let doc = parse_installed_plugins("{ not json at all");
    assert!(doc.plugins.is_empty());
}

#[test]
fn parse_installed_plugins_parses_real_shape() {
    let raw = r#"{"version":2,"plugins":{"github@claude-plugins-official":[
        {"scope":"user","installPath":"C:\\x\\github","version":"1"}
    ]}}"#;
    let doc = parse_installed_plugins(raw);
    assert_eq!(doc.plugins.len(), 1);
    assert!(doc.plugins.contains_key("github@claude-plugins-official"));
}

#[test]
fn select_enabled_plugin_paths_defaults_missing_entry_to_enabled() {
    let mut plugins = BTreeMap::new();
    plugins.insert(
        "mystery@marketplace".to_string(),
        vec![InstalledPluginEntry {
            install_path: "C:\\fake\\path".to_string(),
        }],
    );
    let doc = InstalledPluginsDoc { plugins };
    let enabled: BTreeMap<String, bool> = BTreeMap::new();

    let selected = select_enabled_plugin_paths(&doc, &enabled);
    assert_eq!(selected.len(), 1);
    assert_eq!(selected[0].0, "mystery");
}

#[test]
fn select_enabled_plugin_paths_excludes_explicit_false() {
    let mut plugins = BTreeMap::new();
    plugins.insert(
        "frontend-design@claude-plugins-official".to_string(),
        vec![InstalledPluginEntry {
            install_path: "C:\\fake\\path".to_string(),
        }],
    );
    let doc = InstalledPluginsDoc { plugins };
    let mut enabled = BTreeMap::new();
    enabled.insert("frontend-design@claude-plugins-official".to_string(), false);

    assert!(select_enabled_plugin_paths(&doc, &enabled).is_empty());
}

#[test]
#[ignore = "reads this machine's real ~/.claude/plugins — diagnostic only, run explicitly"]
fn print_real_plugin_mcp_count_on_this_machine() {
    let count = super::discovery::collect_plugin_mcps().len();
    println!("REAL collect_plugin_mcps() entries on this machine = {count}");
}
