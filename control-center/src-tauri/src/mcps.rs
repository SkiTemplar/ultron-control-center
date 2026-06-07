// ULTRON Control Center — MCP discovery & health module.
//
// Resolves a unified MCP view by joining three sources:
//   1. ~/.claude/settings.json mcpServers       (configured MCPs)
//   2. ~/.ultron/.tmp/mcp-health.json           (last probe results)
//   3. ~/.ultron/config/mcp-fallbacks.yaml      (fallback messages, severity,
//                                                expected_offline flag)
//
// Frontend uses this for the MCPs tab cards. CRUD mutations (add/update/
// delete) round-trip through settings::settings_save_inner so we get the
// timestamped backup + atomic write for free. A Claude Code restart is
// still required for the new MCP to actually be spawned — the UI calls
// this out in the confirmation copy.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::settings;

// ---------------------------------------------------------------------------
// Shape returned to the frontend
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
pub struct McpInfo {
    pub name: String,
    pub transport: String,
    pub command: Option<String>,
    pub args_preview: Option<String>,
    pub url: Option<String>,
    /// "ok" | "degraded" | "missing" | "unknown"
    pub status: String,
    pub last_checked: Option<String>,
    pub fallback_message: Option<String>,
    pub alert_severity: Option<String>,
    pub expected_offline: bool,
    /// Provenance of the entry — Claudia-compatible. One of:
    ///   "user"         — declared in ~/.claude/settings.json mcpServers
    ///   "project"      — declared in <cwd>/.mcp.json (project-scope)
    ///   "plugin:<slug>" — provided by an installed plugin's .mcp.json
    /// The frontend uses this to render an origin chip and to gate
    /// destructive mutations (only user-scope entries are editable).
    #[serde(default)]
    pub origin: String,
    /// Plugin slug when origin starts with "plugin:". Convenience field
    /// so the UI doesn't have to split the origin string.
    #[serde(default)]
    pub plugin: Option<String>,
    /// Human-readable description of what this MCP server does.
    /// Sourced from a well-known catalog keyed by server name, with a
    /// generic fallback derived from the command/url when unknown.
    #[serde(default)]
    pub description: String,
    /// True when the (normalised) server name is not in the curated set of
    /// well-known MCPs. The UI surfaces an amber "desconocido" badge so the
    /// user can review unfamiliar servers (e.g. discord/exa/fakechat).
    #[serde(default)]
    pub unknown: bool,
    /// How many config entries collapsed onto this normalised name. 1 means
    /// no duplicates. >1 means the same logical server is declared in
    /// multiple scopes/files (e.g. sequential-thinking in two projects).
    #[serde(default)]
    pub duplicate_count: u32,
    /// Origins of every entry that collapsed onto this normalised name,
    /// in discovery order. Lets the UI show "xN (origenes: ...)".
    #[serde(default)]
    pub duplicate_origins: Vec<String>,
    /// True when the server config carries `disabled: true`. Such servers
    /// are configured but not spawned by Claude Code.
    #[serde(default)]
    pub disabled: bool,
}

// ---------------------------------------------------------------------------
// settings.json parsing
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct SettingsRoot {
    #[serde(rename = "mcpServers", default)]
    mcp_servers: BTreeMap<String, McpServerCfg>,
    /// Claude Code's own disable list for `.mcp.json` / project-scoped servers
    /// (settings.json `disabledMcpjsonServers`). A raw server name in here is
    /// genuinely disabled by Claude Code, so the UI must reflect it.
    #[serde(rename = "disabledMcpjsonServers", default)]
    disabled_mcpjson_servers: Vec<String>,
}

#[derive(Debug, Deserialize, Clone, Default)]
struct McpServerCfg {
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default, rename = "type")]
    transport: Option<String>,
    #[serde(default)]
    disabled: bool,
}

fn settings_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude/settings.json"))
}

fn parse_settings() -> Result<SettingsRoot, String> {
    let path = settings_path().ok_or_else(|| "no HOME".to_string())?;
    let raw = fs::read_to_string(&path).map_err(|e| format!("read settings: {}", e))?;
    serde_json::from_str::<SettingsRoot>(&raw).map_err(|e| format!("parse settings: {}", e))
}

// ---------------------------------------------------------------------------
// mcp-health.json
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct HealthDoc {
    checked_at: Option<String>,
    #[serde(default)]
    results: BTreeMap<String, String>,
}

fn read_health() -> HealthDoc {
    let Some(home) = dirs::home_dir() else {
        return HealthDoc {
            checked_at: None,
            results: BTreeMap::new(),
        };
    };
    let path = home.join(".ultron/.tmp/mcp-health.json");
    match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str::<HealthDoc>(&raw).unwrap_or(HealthDoc {
            checked_at: None,
            results: BTreeMap::new(),
        }),
        Err(_) => HealthDoc {
            checked_at: None,
            results: BTreeMap::new(),
        },
    }
}

// ---------------------------------------------------------------------------
// mcp-fallbacks.yaml — handwritten parser (no yaml crate dep)
//
// The schema is shallow and stable. Parsing rule:
//   - Each entry starts with "- mcp_name: <name>"
//   - Following indented lines are scalar key/value until next "- mcp_name"
//   - fallback_message may be multi-line — we capture the line as-is.
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Clone)]
struct FallbackEntry {
    fallback_message: Option<String>,
    alert_severity: Option<String>,
    expected_offline: bool,
}

fn parse_fallbacks() -> BTreeMap<String, FallbackEntry> {
    let mut out: BTreeMap<String, FallbackEntry> = BTreeMap::new();
    let Some(home) = dirs::home_dir() else {
        return out;
    };
    let path = home.join(".ultron/config/mcp-fallbacks.yaml");
    let Ok(raw) = fs::read_to_string(&path) else {
        return out;
    };

    let mut current_name: Option<String> = None;
    let mut current_entry = FallbackEntry::default();

    for line in raw.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('#') || trimmed.is_empty() {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("- mcp_name:") {
            // Flush previous
            if let Some(name) = current_name.take() {
                out.insert(name, std::mem::take(&mut current_entry));
            }
            current_name = Some(rest.trim().trim_matches('"').to_string());
            continue;
        }
        let (key, value) = match trimmed.split_once(':') {
            Some(kv) => kv,
            None => continue,
        };
        let key = key.trim();
        let value = value.trim().trim_matches('"').trim_matches('\'');
        match key {
            "fallback_message" => {
                current_entry.fallback_message = Some(value.to_string());
            }
            "alert_severity" => {
                // Strip trailing inline comment
                let v = value.split('#').next().unwrap_or(value).trim();
                current_entry.alert_severity = Some(v.to_string());
            }
            "expected_offline" => {
                current_entry.expected_offline = value.eq_ignore_ascii_case("true");
            }
            _ => {}
        }
    }
    if let Some(name) = current_name.take() {
        out.insert(name, current_entry);
    }
    out
}

// ---------------------------------------------------------------------------
// Public command
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Well-known MCP description catalog.
// Keyed by the canonical mcpServers entry name (lowercase). Entries for
// common MCPs that users encounter but may not recognise (discord, exa, etc.)
// are included so the panel can show a tooltip/description without any
// network round-trip.
// ---------------------------------------------------------------------------

fn well_known_description(name: &str) -> Option<&'static str> {
    // Normalise: strip common prefixes (server-, mcp-) and lowercase.
    let n = name.to_lowercase();
    let key = n
        .strip_prefix("mcp-")
        .or_else(|| n.strip_prefix("server-"))
        .unwrap_or(&n);

    match key {
        // Anthropic / Claude ecosystem
        "sequential-thinking" | "sequentialthinking" =>
            Some("Enables multi-step reasoning by breaking problems into sequential thoughts before answering."),
        "context7" | "context-7" =>
            Some("Fetches up-to-date library documentation and code examples from the web (Context7 service)."),
        "github" =>
            Some("Reads and writes GitHub repos, issues, PRs, and actions via the GitHub API."),
        "gitlab" =>
            Some("Reads and writes GitLab repos, issues, and MRs via the GitLab API."),
        "filesystem" =>
            Some("Exposes read/write access to local files and directories inside a configurable root path."),
        "postgres" =>
            Some("Connects to a PostgreSQL database and lets the model query, inspect schema, and run SQL."),
        "sqlite" =>
            Some("Connects to a local SQLite database for schema inspection and SQL queries."),
        "puppeteer" =>
            Some("Controls a headless Chromium browser for web scraping, screenshots, and automation."),
        "playwright" =>
            Some("Cross-browser automation via Playwright: click, fill forms, screenshot, PDF."),
        "fetch" =>
            Some("Fetches arbitrary HTTP URLs and returns the response body as text or JSON."),
        "brave-search" | "brave_search" | "bravesearch" =>
            Some("Runs web searches via the Brave Search API and returns ranked results."),
        "exa" =>
            Some("Performs neural web search and content extraction via the Exa API (formerly Metaphor)."),
        "discord" =>
            Some("Reads and sends messages in Discord servers/channels via the Discord API."),
        "slack" =>
            Some("Reads and posts messages to Slack workspaces and channels."),
        "imessage" | "i-message" =>
            Some("Reads iMessage conversations from a local macOS Messages database (read-only)."),
        "fakechat" | "fake-chat" =>
            Some("Generates synthetic chat conversation data for testing and prototyping."),
        "memory" =>
            Some("Persistent key-value memory store that survives across Claude Code sessions."),
        "qdrant" =>
            Some("Stores and queries vector embeddings in a local or remote Qdrant collection."),
        "linear" =>
            Some("Reads and creates Linear issues, projects, and cycles via the Linear API."),
        "jira" =>
            Some("Reads and creates Jira issues and projects via the Atlassian API."),
        "notion" =>
            Some("Reads and writes Notion pages and databases via the Notion API."),
        "gdrive" | "google-drive" | "googledrive" =>
            Some("Lists, reads, and uploads files in Google Drive."),
        "gmail" =>
            Some("Reads and sends Gmail messages via the Google API."),
        "google-maps" | "googlemaps" =>
            Some("Geocodes addresses and searches for places via the Google Maps API."),
        "aws-kb-retrieval" | "aws_kb_retrieval" =>
            Some("Queries AWS Bedrock Knowledge Bases for document retrieval."),
        "everything" =>
            Some("Demonstration MCP that exposes all protocol features (prompts, resources, tools, sampling)."),
        "time" =>
            Some("Returns the current UTC time and converts between time zones."),
        "sentry" =>
            Some("Queries Sentry for error events, issues, and stack traces."),
        "datadog" =>
            Some("Queries Datadog metrics, logs, and monitors."),
        "redis" =>
            Some("Reads and writes keys in a Redis instance."),
        "mongodb" =>
            Some("Queries and updates a MongoDB collection."),
        "figma" =>
            Some("Inspects Figma files, frames, and components via the Figma API."),
        "openapi" | "swagger" =>
            Some("Loads an OpenAPI/Swagger spec and exposes each endpoint as a tool."),
        "stripe" =>
            Some("Creates and retrieves Stripe customers, charges, and subscriptions."),
        "shopify" =>
            Some("Reads and updates Shopify products, orders, and customers."),
        "hubspot" =>
            Some("Reads and creates HubSpot contacts, deals, and companies."),
        "supabase" =>
            Some("Queries Supabase tables and runs SQL via the Supabase REST API."),
        "vercel" =>
            Some("Lists and deploys Vercel projects, reads deployment logs."),
        "cloudflare" =>
            Some("Manages Cloudflare zones, DNS records, and Workers via the API."),
        "docker" =>
            Some("Lists, starts, stops, and inspects Docker containers and images."),
        "kubernetes" | "k8s" =>
            Some("Inspects and manages Kubernetes pods, deployments, and services."),
        "terraform" =>
            Some("Plans and applies Terraform configurations."),
        _ => None,
    }
}

/// Derive a generic description from a server config when the name is not in
/// the well-known catalog.
fn generic_description(name: &str, cfg: &McpServerCfg) -> String {
    if let Some(url) = &cfg.url {
        return format!("Remote MCP server at {}.", url);
    }
    if let Some(cmd) = &cfg.command {
        if cfg.args.is_empty() {
            return format!("Local stdio server started with `{}`.", cmd);
        }
        // Show first meaningful arg (skip flags like -y).
        let first_pkg = cfg
            .args
            .iter()
            .find(|a| !a.starts_with('-'))
            .map(|s| s.as_str())
            .unwrap_or("");
        if first_pkg.is_empty() {
            return format!("Local stdio server started with `{}`.", cmd);
        }
        return format!("Local stdio server — `{} {}`.", cmd, first_pkg);
    }
    format!("MCP server '{}'.", name)
}

/// Build an `McpInfo` for a single (name, cfg, origin) tuple, joining in
/// the global health + fallback metadata. Shared by all sources so the
/// frontend gets consistent shapes regardless of provenance.
fn build_mcp_info(
    name: &str,
    cfg: &McpServerCfg,
    origin: String,
    plugin: Option<String>,
    health: &HealthDoc,
    fallbacks: &BTreeMap<String, FallbackEntry>,
) -> McpInfo {
    let transport = if cfg.transport.as_deref() == Some("sse") {
        "sse".to_string()
    } else if cfg.url.is_some() {
        "http".to_string()
    } else {
        "stdio".to_string()
    };
    let args_preview = if cfg.args.is_empty() {
        None
    } else {
        Some(cfg.args.join(" "))
    };
    let status = health
        .results
        .get(name)
        .cloned()
        .unwrap_or_else(|| "unknown".to_string());
    let fb = fallbacks.get(name).cloned().unwrap_or_default();

    let description = well_known_description(name)
        .map(|s| s.to_string())
        .unwrap_or_else(|| generic_description(name, cfg));

    McpInfo {
        name: name.to_string(),
        transport,
        command: cfg.command.clone(),
        args_preview,
        url: cfg.url.clone(),
        status,
        last_checked: health.checked_at.clone(),
        fallback_message: fb.fallback_message,
        alert_severity: fb.alert_severity,
        expected_offline: fb.expected_offline,
        origin: origin.clone(),
        plugin,
        description,
        unknown: is_unknown_mcp(name),
        // Dedup metadata is filled in by the aggregator after all sources
        // are collected; a single entry defaults to count 1 / [its origin].
        duplicate_count: 1,
        duplicate_origins: vec![origin],
        disabled: cfg.disabled,
    }
}

/// Parse a generic `{ "mcpServers": { ... } }` JSON file. Returns an
/// empty map when the file is missing, unreadable, or doesn't carry the
/// expected top-level key — plugin authors are inconsistent and we don't
/// want one bad file to wipe out the whole list.
fn parse_mcp_file(path: &std::path::Path) -> BTreeMap<String, McpServerCfg> {
    let raw = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return BTreeMap::new(),
    };
    let value: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return BTreeMap::new(),
    };
    let Some(obj) = value.get("mcpServers").and_then(|v| v.as_object()) else {
        return BTreeMap::new();
    };
    let mut out: BTreeMap<String, McpServerCfg> = BTreeMap::new();
    for (k, v) in obj.iter() {
        if let Ok(cfg) = serde_json::from_value::<McpServerCfg>(v.clone()) {
            out.insert(k.clone(), cfg);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Name normalisation + known-server set (for dedup + unknown flagging)
// ---------------------------------------------------------------------------

/// Curated set of MCP server names we recognise. Anything outside this set is
/// flagged `unknown: true` so the UI can prompt the user to review it. Keep
/// this aligned with the well-known description catalog above.
const KNOWN_MCP_NAMES: &[&str] = &[
    "github",
    "gitlab",
    "qdrant",
    "memory",
    "playwright",
    "puppeteer",
    "context7",
    "sequential-thinking",
    "gemini",
    "supabase",
    "figma",
    "gmail",
    "calendar",
    "drive",
    "gdrive",
    "notion",
    "spotify",
    "vercel",
    "railway",
    "filesystem",
    "postgres",
    "sqlite",
    "fetch",
    "brave-search",
    "exa",
    "discord",
    "slack",
    "linear",
    "jira",
    "stripe",
    "shopify",
    "hubspot",
    "cloudflare",
    "docker",
    "kubernetes",
    "terraform",
    "redis",
    "mongodb",
    "sentry",
    "datadog",
    "time",
    "everything",
    "openapi",
    "superpowers",
    "unity",
];

/// Normalise an MCP server name for dedup + recognition. Lowercases, strips
/// common scaffolding prefixes (`mcp-`, `server-`) and suffixes (`-mcp`,
/// `-server`, `-mcp-server`) so e.g. `railway-mcp-server` and `railway`, or
/// `superpowers-mcp` and `superpowers`, collapse to the same canonical name.
fn normalize_mcp_name(name: &str) -> String {
    let mut n = name.to_lowercase();
    // Strip leading scaffolding repeatedly so `mcp-server-github` peels off in
    // two passes (mcp- then server-).
    loop {
        let before = n.clone();
        for pre in ["mcp-", "server-", "mcp_", "server_"] {
            if let Some(rest) = n.strip_prefix(pre) {
                n = rest.to_string();
                break;
            }
        }
        if n == before {
            break;
        }
    }
    // Strip trailing scaffolding repeatedly so `-mcp-server` peels off
    // regardless of order.
    loop {
        let before = n.clone();
        for suf in ["-mcp-server", "-mcp", "-server", "_mcp", "_server"] {
            if let Some(rest) = n.strip_suffix(suf) {
                n = rest.to_string();
                break;
            }
        }
        if n == before {
            break;
        }
    }
    n
}

/// True when the server's normalised name is not in the curated known set.
fn is_unknown_mcp(name: &str) -> bool {
    !KNOWN_MCP_NAMES.contains(&normalize_mcp_name(name).as_str())
}

/// Read `~/.claude.json` and extract every MCP server declared there:
///   - top-level `mcpServers`            -> origin "user-claudejson"
///   - `projects.<path>.mcpServers`      -> origin "project:<basename(path)>"
/// Returns `(origin, name, cfg)` tuples. Tolerates a missing/unreadable file
/// (returns an empty vec — never an error) so a fresh install still works.
fn collect_claude_json_mcps() -> Vec<(String, String, McpServerCfg)> {
    let mut out: Vec<(String, String, McpServerCfg)> = Vec::new();
    let Some(home) = dirs::home_dir() else {
        return out;
    };
    let path = home.join(".claude.json");
    let Ok(raw) = fs::read_to_string(&path) else {
        return out;
    };
    let Ok(value): Result<serde_json::Value, _> = serde_json::from_str(&raw) else {
        return out;
    };

    // (a) top-level mcpServers
    if let Some(obj) = value.get("mcpServers").and_then(|v| v.as_object()) {
        for (name, cfg_val) in obj.iter() {
            if let Ok(cfg) = serde_json::from_value::<McpServerCfg>(cfg_val.clone()) {
                out.push(("user-claudejson".to_string(), name.clone(), cfg));
            }
        }
    }

    // (b) project-scoped projects.<path>.mcpServers
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

/// Discover MCP servers contributed by installed plugins. Walks
/// ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/.mcp.json
/// AND ~/.claude/plugins/marketplaces/<...>/.mcp.json. Each entry is
/// tagged with origin "plugin:<plugin-slug>" so the UI can display where
/// it came from. Matches Claudia's discovery behaviour.
fn collect_plugin_mcps() -> Vec<(String, String, McpServerCfg)> {
    let mut out: Vec<(String, String, McpServerCfg)> = Vec::new();
    let Some(home) = dirs::home_dir() else {
        return out;
    };
    let plugins_root = home.join(".claude").join("plugins");
    if !plugins_root.exists() {
        return out;
    }
    // Walk depth-limited (we don't recurse into node_modules etc.). Each
    // .mcp.json sits next to its plugin's .claude-plugin/plugin.json so a
    // 5-level walk from ~/.claude/plugins is more than enough.
    let mut stack: Vec<(std::path::PathBuf, usize)> = vec![(plugins_root, 0)];
    while let Some((dir, depth)) = stack.pop() {
        if depth > 6 {
            continue;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in rd.filter_map(|e| e.ok()) {
            let p = entry.path();
            if p.is_dir() {
                // Skip obvious junk to keep the walk fast.
                let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
                if matches!(name, "node_modules" | ".git" | "dist" | "build") {
                    continue;
                }
                stack.push((p, depth + 1));
            } else if p.file_name().and_then(|s| s.to_str()) == Some(".mcp.json") {
                // Derive plugin slug from the closest ancestor that looks
                // like a plugin root. Heuristic: the directory two levels
                // above (cache/<marketplace>/<plugin>/<version>/.mcp.json)
                // or one level above for marketplaces/<plugin>/.mcp.json.
                let plugin_slug = derive_plugin_slug(&p).unwrap_or_else(|| "unknown".to_string());
                let parsed = parse_mcp_file(&p);
                for (name, cfg) in parsed.into_iter() {
                    out.push((plugin_slug.clone(), name, cfg));
                }
            }
        }
    }
    out
}

fn derive_plugin_slug(mcp_path: &std::path::Path) -> Option<String> {
    let parts: Vec<&std::ffi::OsStr> = mcp_path.iter().collect::<Vec<_>>();
    // Find the index of "plugins" (first match — root of the tree).
    let mut idx_plugins: Option<usize> = None;
    for (i, p) in parts.iter().enumerate() {
        if p.to_string_lossy() == "plugins" {
            idx_plugins = Some(i);
            break;
        }
    }
    let i = idx_plugins?;
    // After "plugins/" we may see either "cache/<marketplace>/<plugin>/..."
    // or "marketplaces/<marketplace>/<plugin>/..." or "marketplaces/<plugin>/...".
    // Prefer the segment immediately under the marketplace name.
    let after: Vec<String> = parts[i + 1..]
        .iter()
        .map(|s| s.to_string_lossy().to_string())
        .collect();
    match after.as_slice() {
        // cache / <marketplace> / <plugin-slug> / <version> / .mcp.json
        [first, _market, plugin, _ver, _file, ..] if first == "cache" => Some(plugin.clone()),
        // marketplaces / <marketplace> / <plugin-slug> / .mcp.json
        [first, _market, plugin, _file, ..] if first == "marketplaces" => Some(plugin.clone()),
        // marketplaces / <plugin-slug> / .mcp.json
        [first, plugin, _file, ..] if first == "marketplaces" => Some(plugin.clone()),
        _ => after.first().cloned(),
    }
}

/// Discover MCP servers declared in a project-level `.mcp.json` at the
/// user's currently-open project root. We don't have a single canonical
/// cwd here — projects are managed by the Control Center's own Projects
/// tab — so we scan every registered project's path. This mirrors how
/// Claudia surfaces project MCPs across the user's known projects.
fn collect_project_mcps() -> Vec<(String, String, McpServerCfg)> {
    let mut out: Vec<(String, String, McpServerCfg)> = Vec::new();
    let Some(home) = dirs::home_dir() else {
        return out;
    };
    let registry = home.join(".ultron").join("cockpit").join("projects.json");
    let Ok(raw) = fs::read_to_string(&registry) else {
        return out;
    };
    let Ok(value): Result<serde_json::Value, _> = serde_json::from_str(&raw) else {
        return out;
    };
    let projects = value
        .get("projects")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    for proj in projects.iter() {
        let path_str = proj.get("path").and_then(|v| v.as_str()).unwrap_or("");
        if path_str.is_empty() {
            continue;
        }
        let candidate = std::path::Path::new(path_str).join(".mcp.json");
        if !candidate.exists() {
            continue;
        }
        let proj_label = proj
            .get("name")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| {
                std::path::Path::new(path_str)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("project")
                    .to_string()
            });
        for (name, cfg) in parse_mcp_file(&candidate).into_iter() {
            out.push((proj_label.clone(), name, cfg));
        }
    }
    out
}

pub fn list_mcps_inner() -> Result<Vec<McpInfo>, String> {
    let settings = parse_settings()?;
    let health = read_health();
    let fallbacks = parse_fallbacks();

    // De-dup by (name, origin) so the same MCP showing up via user AND
    // plugin doesn't render twice with the same chip. We DO keep entries
    // with the same name but different origins so the user can see when
    // a plugin would shadow a user-scope server.
    let mut seen: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    let mut out: Vec<McpInfo> = Vec::new();

    // Source 1: user settings.json
    for (name, cfg) in settings.mcp_servers.iter() {
        let key = (name.clone(), "user".to_string());
        if seen.insert(key) {
            out.push(build_mcp_info(
                name,
                cfg,
                "user".to_string(),
                None,
                &health,
                &fallbacks,
            ));
        }
    }

    // Source 2: plugin .mcp.json files
    for (plugin, name, cfg) in collect_plugin_mcps().into_iter() {
        let origin = format!("plugin:{}", plugin);
        let key = (name.clone(), origin.clone());
        if seen.insert(key) {
            out.push(build_mcp_info(
                &name,
                &cfg,
                origin,
                Some(plugin),
                &health,
                &fallbacks,
            ));
        }
    }

    // Source 3: project-level .mcp.json files
    for (project, name, cfg) in collect_project_mcps().into_iter() {
        let origin = format!("project:{}", project);
        let key = (name.clone(), origin.clone());
        if seen.insert(key) {
            out.push(build_mcp_info(
                &name,
                &cfg,
                origin,
                Some(project),
                &health,
                &fallbacks,
            ));
        }
    }

    // Source 4: ~/.claude.json (top-level + project-scoped mcpServers). This
    // is where the user's real MCPs actually live; the older sources only
    // covered settings.json + plugin/project .mcp.json files.
    for (origin, name, cfg) in collect_claude_json_mcps().into_iter() {
        let plugin = origin
            .strip_prefix("project:")
            .map(|p| p.to_string());
        let key = (name.clone(), origin.clone());
        if seen.insert(key) {
            out.push(build_mcp_info(
                &name,
                &cfg,
                origin,
                plugin,
                &health,
                &fallbacks,
            ));
        }
    }

    // Collapse duplicates by normalised name: the same logical server may be
    // declared in multiple scopes/files (e.g. sequential-thinking in two
    // projects, or railway-mcp-server vs railway). We keep the FIRST entry
    // per normalised name as the canonical row and fold the rest into its
    // duplicate_count / duplicate_origins so the UI can show "xN".
    // Reflect Claude Code's own disable list: a raw server name listed in
    // settings.json `disabledMcpjsonServers` is genuinely disabled by Claude
    // Code even when the source config didn't carry `disabled: true`.
    if !settings.disabled_mcpjson_servers.is_empty() {
        let disabled_set: std::collections::HashSet<&str> = settings
            .disabled_mcpjson_servers
            .iter()
            .map(|s| s.as_str())
            .collect();
        for info in out.iter_mut() {
            if disabled_set.contains(info.name.as_str()) {
                info.disabled = true;
            }
        }
    }

    // How editable an origin is FROM ULTRON (lower = more editable). When the
    // same logical server shows up in several scopes we keep the MOST editable
    // one as the canonical (visible) row so the user can actually act on it —
    // previously the first source won, which meant a plugin copy shadowed the
    // user's own editable copy and the toggle did nothing.
    fn editability_rank(origin: &str) -> u8 {
        if origin == "user" || origin == "user-claudejson" {
            0
        } else if origin.starts_with("project:") {
            1
        } else if origin.starts_with("plugin:") {
            2
        } else {
            3
        }
    }
    let mut deduped: Vec<McpInfo> = Vec::with_capacity(out.len());
    let mut idx_by_norm: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    for info in out.into_iter() {
        let norm = normalize_mcp_name(&info.name);
        if let Some(&i) = idx_by_norm.get(&norm) {
            if editability_rank(&info.origin) < editability_rank(&deduped[i].origin) {
                // Incoming entry is more editable — promote it to canonical and
                // fold the previous canonical (and its origins) into the count.
                let prev_count = deduped[i].duplicate_count;
                let prev_origins = std::mem::take(&mut deduped[i].duplicate_origins);
                let mut promoted = info;
                promoted.duplicate_count = prev_count + 1;
                for o in prev_origins {
                    if !promoted.duplicate_origins.contains(&o) {
                        promoted.duplicate_origins.push(o);
                    }
                }
                deduped[i] = promoted;
            } else {
                let canonical = &mut deduped[i];
                canonical.duplicate_count += 1;
                if !canonical.duplicate_origins.contains(&info.origin) {
                    canonical.duplicate_origins.push(info.origin.clone());
                }
            }
        } else {
            idx_by_norm.insert(norm, deduped.len());
            deduped.push(info);
        }
    }
    let mut out = deduped;

    // Stable ordering: user first, then project, then plugin, alphabetical
    // within each group. "user-claudejson" is treated as user-scope.
    out.sort_by(|a, b| {
        let bucket = |o: &str| -> u8 {
            if o == "user" || o == "user-claudejson" {
                0
            } else if o.starts_with("project:") {
                1
            } else if o.starts_with("plugin:") {
                2
            } else {
                3
            }
        };
        bucket(&a.origin)
            .cmp(&bucket(&b.origin))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(out)
}

// ---------------------------------------------------------------------------
// CRUD mutations on settings.json mcpServers
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
pub struct McpMutationResult {
    pub success: bool,
    pub name: String,
    pub backup_path: Option<String>,
}

/// Names that round-trip safely as JSON object keys and as mcp ids in
/// CLI commands. Lower-case kebab/underscore, starts with alnum, 2–61
/// chars total. Conservative on purpose — matches what Claude Code
/// itself uses for mcpServers entries.
fn validate_mcp_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 61 || name.len() < 2 {
        return Err("name must be 2–61 chars".to_string());
    }
    let bytes = name.as_bytes();
    let first = bytes[0];
    let first_ok = first.is_ascii_lowercase() || first.is_ascii_digit();
    if !first_ok {
        return Err("name must start with a lowercase letter or digit".to_string());
    }
    for &b in &bytes[1..] {
        let ok = b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-';
        if !ok {
            return Err("name may only contain lowercase letters, digits, '_' or '-'".to_string());
        }
    }
    Ok(())
}

/// Shared mutation core: read settings, mutate mcpServers via `f`, save back.
fn mutate_mcp_servers<F>(name: &str, f: F) -> Result<McpMutationResult, String>
where
    F: FnOnce(&mut serde_json::Map<String, serde_json::Value>) -> Result<(), String>,
{
    validate_mcp_name(name)?;

    let snapshot = settings::settings_read_inner()?;
    let mut content = snapshot.content;

    let root = content
        .as_object_mut()
        .ok_or_else(|| "settings.json root is not an object".to_string())?;

    // Ensure mcpServers exists and is an object.
    let entry = root
        .entry("mcpServers".to_string())
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    let servers = entry
        .as_object_mut()
        .ok_or_else(|| "mcpServers is not an object".to_string())?;

    f(servers)?;

    let save = settings::settings_save_inner(settings::SettingsSavePayload { content })?;
    Ok(McpMutationResult {
        success: save.success,
        name: name.to_string(),
        backup_path: save.backup_path,
    })
}

/// Add or remove a raw server name from settings.json `disabledMcpjsonServers`
/// — Claude Code's native disable switch. It genuinely disables servers defined
/// in project `.mcp.json` files and in `~/.claude.json` `projects.*.mcpServers`.
/// It does NOT affect plugin-provided servers (disable the plugin instead) nor
/// top-level `~/.claude.json` `mcpServers` (those must be edited there); the
/// frontend only offers this toggle for the scopes it can actually control.
pub fn set_mcpjson_disabled_inner(
    name: String,
    disabled: bool,
) -> Result<McpMutationResult, String> {
    // Light guard only: this just toggles membership in a string array (no
    // command execution), and existing server names may use characters the
    // strict create-time validator rejects (e.g. `UnityMCP`).
    let trimmed = name.trim();
    if trimmed.is_empty() || name.len() > 200 || name.contains(['\n', '\r', '\0']) {
        return Err("invalid MCP name".to_string());
    }

    let snapshot = settings::settings_read_inner()?;
    let mut content = snapshot.content;
    let root = content
        .as_object_mut()
        .ok_or_else(|| "settings.json root is not an object".to_string())?;

    // Read the current list, tolerating a missing or wrong-typed key.
    let mut list: Vec<String> = root
        .get("disabledMcpjsonServers")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let present = list.iter().any(|n| n == &name);
    if disabled && !present {
        list.push(name.clone());
    } else if !disabled && present {
        list.retain(|n| n != &name);
    }

    root.insert(
        "disabledMcpjsonServers".to_string(),
        serde_json::Value::Array(list.into_iter().map(serde_json::Value::String).collect()),
    );

    let save = settings::settings_save_inner(settings::SettingsSavePayload { content })?;
    Ok(McpMutationResult {
        success: save.success,
        name,
        backup_path: save.backup_path,
    })
}

// Hard allowlist of MCP launcher commands. Anything else is rejected before
// write so a compromised webview / SKILL.md crafted / future generate-from-
// prompt path can't slip a `powershell.exe -EncodedCommand <payload>` into
// settings.json — which Claude Code would happily run on next session start
// (persistent RCE, no UI feedback).
const MCP_COMMAND_ALLOWLIST: &[&str] = &[
    "npx",
    "npm",
    "node",
    "uvx",
    "uv",
    "python",
    "python.exe",
    "deno",
    "bun",
    "cargo",
    "go",
    "ruby",
    "java",
    "java.exe",
];

const MCP_FORBIDDEN_ARG_FRAGMENTS: &[&str] = &[
    "-EncodedCommand",
    "-encodedcommand",
    "-Command",
    "Invoke-Expression",
    "iex ",
    "DownloadString",
    "wget ",
    "curl -",
];

fn validate_mcp_config(config: &serde_json::Value) -> Result<(), String> {
    let obj = config
        .as_object()
        .ok_or_else(|| "config must be a JSON object".to_string())?;

    // Two shapes are valid: launcher-style with `command` + optional `args`
    // (most common) OR `url` for SSE MCPs. Anything else is rejected so we
    // don't silently accept `Invoke-Expression` payloads.
    let has_command = obj.contains_key("command");
    let has_url = obj.contains_key("url");
    if !has_command && !has_url {
        return Err("config must have either 'command' or 'url'".into());
    }
    if has_command && has_url {
        return Err("config cannot have both 'command' and 'url'".into());
    }

    if let Some(cmd) = obj.get("command").and_then(|v| v.as_str()) {
        let cmd_trimmed = cmd.trim();
        if cmd_trimmed.is_empty() {
            return Err("command is empty".into());
        }
        // Reject absolute paths and UNC — only bare executable names from
        // the allowlist. Forces the user to type `npx` rather than
        // `C:\Windows\System32\cmd.exe`.
        if cmd_trimmed.contains('\\') || cmd_trimmed.contains('/') {
            return Err(format!(
                "command must be a bare executable name, not a path: '{}'",
                cmd_trimmed
            ));
        }
        let lower = cmd_trimmed.to_ascii_lowercase();
        let stripped = lower.strip_suffix(".exe").unwrap_or(&lower);
        if !MCP_COMMAND_ALLOWLIST.contains(&stripped) {
            return Err(format!(
                "command '{}' is not in the MCP allowlist (allowed: {})",
                cmd_trimmed,
                MCP_COMMAND_ALLOWLIST.join(", ")
            ));
        }
    }

    if let Some(args) = obj.get("args") {
        let arr = args
            .as_array()
            .ok_or_else(|| "args must be an array".to_string())?;
        for (i, a) in arr.iter().enumerate() {
            let s = a
                .as_str()
                .ok_or_else(|| format!("args[{}] must be a string", i))?;
            for needle in MCP_FORBIDDEN_ARG_FRAGMENTS {
                if s.contains(needle) {
                    return Err(format!(
                        "args[{}] contains forbidden fragment '{}'",
                        i, needle
                    ));
                }
            }
        }
    }

    if let Some(url) = obj.get("url").and_then(|v| v.as_str()) {
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err("url must be http(s)://".into());
        }
    }

    if let Some(env) = obj.get("env") {
        if !env.is_object() {
            return Err("env must be a JSON object".into());
        }
    }

    Ok(())
}

pub fn add_mcp_inner(name: String, config: serde_json::Value) -> Result<McpMutationResult, String> {
    validate_mcp_config(&config)?;
    mutate_mcp_servers(&name, |servers| {
        if servers.contains_key(&name) {
            return Err(format!("mcpServers['{}'] already exists", name));
        }
        servers.insert(name.clone(), config);
        Ok(())
    })
}

pub fn update_mcp_inner(
    name: String,
    config: serde_json::Value,
) -> Result<McpMutationResult, String> {
    validate_mcp_config(&config)?;
    mutate_mcp_servers(&name, |servers| {
        if !servers.contains_key(&name) {
            return Err(format!("mcpServers['{}'] does not exist", name));
        }
        servers.insert(name.clone(), config);
        Ok(())
    })
}

pub fn delete_mcp_inner(name: String) -> Result<McpMutationResult, String> {
    mutate_mcp_servers(&name, |servers| {
        if servers.remove(&name).is_none() {
            return Err(format!("mcpServers['{}'] does not exist", name));
        }
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// AI-driven MCP scaffolding (Claude via cmd.exe /C)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
pub struct McpGenerationResult {
    pub success: bool,
    pub name: String,
    pub config: serde_json::Value,
    pub raw_output: String,
}

/// Trim Markdown code fences and pull the largest balanced JSON object out
/// of an LLM response. Tries, in order:
///   1. ```json ... ``` fenced block
///   2. first '{' to last '}' substring
///
/// Returns the raw substring without parsing.
fn extract_json_blob(text: &str) -> Option<String> {
    // 1. Fenced
    if let Some(start) = text.find("```json") {
        let after = &text[start + "```json".len()..];
        if let Some(end) = after.find("```") {
            return Some(after[..end].trim().to_string());
        }
    }
    if let Some(start) = text.find("```") {
        let after = &text[start + 3..];
        if let Some(end) = after.find("```") {
            let candidate = after[..end].trim();
            // Could be ``` ... ``` with a language tag on the first line.
            let candidate = candidate
                .split_once('\n')
                .map(|(_, rest)| rest.trim())
                .unwrap_or(candidate);
            if candidate.starts_with('{') {
                return Some(candidate.to_string());
            }
        }
    }
    // 2. First { to last }
    let first = text.find('{')?;
    let last = text.rfind('}')?;
    if last <= first {
        return None;
    }
    Some(text[first..=last].to_string())
}

const MCP_PROMPT_TEMPLATE: &str = r#"You are scaffolding a new MCP (Model Context Protocol) server entry for Claude Code's ~/.claude/settings.json mcpServers object.

The user described what they want:
---
{DESCRIPTION}
---

Respond with ONLY a single JSON object inside a ```json fenced code block. No prose before or after. No commentary.

The JSON object must have this exact shape:

```json
{
  "name": "kebab-case-name",
  "config": {
    "command": "npx",
    "args": ["-y", "<package>"],
    "env": {}
  }
}
```

Rules:
- "name" is the mcpServers key. Lowercase letters, digits, '-' or '_'. Start with a letter or digit. 2–61 chars.
- "config" is the value that goes under mcpServers[name].
- For stdio servers: include "command" (e.g. "npx", "uvx", "node", "python"), "args" array, "env" object (can be empty).
- For HTTP/SSE servers: include "url" (string) and optionally "type": "sse". Omit command/args/env.
- Prefer the canonical npm/uvx package for well-known MCPs (e.g. @modelcontextprotocol/server-filesystem, server-github, server-postgres).
- If credentials are required, put placeholder env vars like "GITHUB_TOKEN": "${GITHUB_TOKEN}" — DO NOT invent secrets.
- Be conservative with args: include only what's strictly needed to start the server.

Now produce the JSON for the described MCP."#;

pub async fn generate_mcp_from_prompt_inner(
    app: &tauri::AppHandle,
    description: String,
) -> Result<McpGenerationResult, String> {
    let description = description.trim().to_string();
    if description.is_empty() {
        return Err("description is empty".to_string());
    }
    let full_prompt = MCP_PROMPT_TEMPLATE.replace("{DESCRIPTION}", &description);

    // Control Center 2.0: no internal AI router. MCP scaffold generation
    // defaults to Claude (best at JSON shape under tight constraints).
    let inline =
        crate::sessions::run_inline_inner(app, "claude".to_string(), None, full_prompt).await?;

    let raw_output = if inline.stdout.trim().is_empty() {
        inline.stderr.clone()
    } else {
        inline.stdout.clone()
    };

    // Parse the JSON blob out of Claude's response.
    let blob = match extract_json_blob(&raw_output) {
        Some(b) => b,
        None => {
            return Ok(McpGenerationResult {
                success: false,
                name: String::new(),
                config: serde_json::Value::Null,
                raw_output,
            });
        }
    };

    let parsed: serde_json::Value = match serde_json::from_str(&blob) {
        Ok(v) => v,
        Err(_) => {
            return Ok(McpGenerationResult {
                success: false,
                name: String::new(),
                config: serde_json::Value::Null,
                raw_output,
            });
        }
    };

    let obj = match parsed.as_object() {
        Some(o) => o,
        None => {
            return Ok(McpGenerationResult {
                success: false,
                name: String::new(),
                config: serde_json::Value::Null,
                raw_output,
            });
        }
    };

    let name = obj
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let config = obj
        .get("config")
        .cloned()
        .unwrap_or(serde_json::Value::Null);

    // Soft-validate: if the name doesn't pass, still return success=false but
    // with the parsed name/config so the frontend can let the user edit.
    let ok = validate_mcp_name(&name).is_ok() && config.is_object();

    Ok(McpGenerationResult {
        success: ok,
        name,
        config,
        raw_output,
    })
}

// ---------------------------------------------------------------------------
// P7: ping a server (spawn command + send JSON-RPC initialize, timeout 2s).
// ---------------------------------------------------------------------------

use std::io::{Read, Write};
use std::process::Stdio;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct McpPingResult {
    pub name: String,
    pub ok: bool,
    pub latency_ms: Option<u64>,
    pub error: Option<String>,
}

pub fn mcp_ping_inner(name: String) -> McpPingResult {
    let settings = match parse_settings() {
        Ok(s) => s,
        Err(e) => {
            return McpPingResult {
                name,
                ok: false,
                latency_ms: None,
                error: Some(format!("read settings: {e}")),
            }
        }
    };
    let Some(cfg) = settings.mcp_servers.get(&name) else {
        return McpPingResult {
            name,
            ok: false,
            latency_ms: None,
            error: Some("server not found in settings.json".to_string()),
        };
    };

    // HTTP/SSE servers are best-effort: skip the JSON-RPC handshake and
    // report ok=true / latency=None to signal "no probe".
    let is_http = cfg.url.is_some()
        || cfg
            .transport
            .as_deref()
            .map(|t| t.eq_ignore_ascii_case("http") || t.eq_ignore_ascii_case("sse"))
            .unwrap_or(false);
    if is_http {
        return McpPingResult {
            name: name.clone(),
            ok: true,
            latency_ms: None,
            error: None,
        };
    }

    let Some(command) = cfg.command.clone() else {
        return McpPingResult {
            name,
            ok: false,
            latency_ms: None,
            error: Some("stdio server has no command".to_string()),
        };
    };

    let start = Instant::now();
    let mut cmd = std::process::Command::new(&command);
    cmd.args(&cfg.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return McpPingResult {
                name,
                ok: false,
                latency_ms: None,
                error: Some(format!("spawn: {e}")),
            }
        }
    };
    let init = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "clientInfo": {"name": "ultron-control-center", "version": "2.0.0"},
            "capabilities": {}
        }
    });
    let line = format!("{}\n", init);
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(line.as_bytes());
    }

    // Read one chunk of stdout with a 2s budget.
    let stdout = child.stdout.take();
    let (tx, rx) = std::sync::mpsc::channel::<bool>();
    if let Some(mut out) = stdout {
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let r = out.read(&mut buf);
            let ok = matches!(r, Ok(n) if n > 0);
            let _ = tx.send(ok);
        });
    }
    let ok = rx.recv_timeout(Duration::from_secs(2)).unwrap_or(false);
    let elapsed = start.elapsed().as_millis() as u64;
    let _ = child.kill();
    let _ = child.wait();

    McpPingResult {
        name,
        ok,
        latency_ms: Some(elapsed),
        error: if ok {
            None
        } else {
            Some("no initialize response within 2s".to_string())
        },
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

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
                "C:\\Users\\USER": {
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
                "C:\\Users\\USER\\skills": {
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

        // 3 top-level + 1 (USER) + 5 (System32) + 1 (skills) = 10 entries.
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
            .any(|(o, n, _)| o == "project:USER" && n == "gemini"));

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

        // Unknowns the prompt called out.
        assert!(is_unknown_mcp("discord"));
        assert!(is_unknown_mcp("fakechat"));
        assert!(is_unknown_mcp("imessage"));
        assert!(is_unknown_mcp("exa"));
        // github-pat is a user-specific alias, not the canonical "github".
        assert!(is_unknown_mcp("github-pat"));
    }

    #[test]
    fn normalize_strips_scaffolding_affixes() {
        assert_eq!(normalize_mcp_name("railway-mcp-server"), "railway");
        assert_eq!(normalize_mcp_name("superpowers-mcp"), "superpowers");
        assert_eq!(normalize_mcp_name("mcp-server-github"), "github");
        assert_eq!(normalize_mcp_name("Sequential-Thinking"), "sequential-thinking");
    }
}
