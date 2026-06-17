// mcps/types_io.rs — DTOs, internal data types, I/O helpers, catalog and normalisation.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

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
    #[serde(default)]
    pub description: String,
    /// True when the (normalised) server name is not in the curated set of
    /// well-known MCPs.
    #[serde(default)]
    pub unknown: bool,
    /// How many config entries collapsed onto this normalised name.
    #[serde(default)]
    pub duplicate_count: u32,
    /// Origins of every entry that collapsed onto this normalised name.
    #[serde(default)]
    pub duplicate_origins: Vec<String>,
    /// True when the server config carries `disabled: true`.
    #[serde(default)]
    pub disabled: bool,
}

// ---------------------------------------------------------------------------
// CRUD result types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
pub struct McpMutationResult {
    pub success: bool,
    pub name: String,
    pub backup_path: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct McpGenerationResult {
    pub success: bool,
    pub name: String,
    pub config: serde_json::Value,
    pub raw_output: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct McpPingResult {
    pub name: String,
    pub ok: bool,
    pub latency_ms: Option<u64>,
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// Internal parsing types
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub(super) struct SettingsRoot {
    #[serde(rename = "mcpServers", default)]
    pub(super) mcp_servers: BTreeMap<String, McpServerCfg>,
    #[serde(rename = "disabledMcpjsonServers", default)]
    pub(super) disabled_mcpjson_servers: Vec<String>,
}

#[derive(Debug, Deserialize, Clone, Default)]
pub(super) struct McpServerCfg {
    #[serde(default)]
    pub(super) command: Option<String>,
    #[serde(default)]
    pub(super) args: Vec<String>,
    #[serde(default)]
    pub(super) url: Option<String>,
    #[serde(default, rename = "type")]
    pub(super) transport: Option<String>,
    #[serde(default)]
    pub(super) disabled: bool,
}

#[derive(Debug, Deserialize)]
pub(super) struct HealthDoc {
    pub(super) checked_at: Option<String>,
    #[serde(default)]
    pub(super) results: BTreeMap<String, String>,
}

#[derive(Debug, Default, Clone)]
pub(super) struct FallbackEntry {
    pub(super) fallback_message: Option<String>,
    pub(super) alert_severity: Option<String>,
    pub(super) expected_offline: bool,
}

// ---------------------------------------------------------------------------
// settings.json I/O
// ---------------------------------------------------------------------------

pub(super) fn settings_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude/settings.json"))
}

pub(super) fn parse_settings() -> Result<SettingsRoot, String> {
    let path = settings_path().ok_or_else(|| "no HOME".to_string())?;
    let raw = fs::read_to_string(&path).map_err(|e| format!("read settings: {}", e))?;
    serde_json::from_str::<SettingsRoot>(&raw).map_err(|e| format!("parse settings: {}", e))
}

// ---------------------------------------------------------------------------
// mcp-health.json
// ---------------------------------------------------------------------------

pub(super) fn read_health() -> HealthDoc {
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
// ---------------------------------------------------------------------------

pub(super) fn parse_fallbacks() -> BTreeMap<String, FallbackEntry> {
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

/// Parse a generic `{ "mcpServers": { ... } }` JSON file. Returns an
/// empty map when the file is missing, unreadable, or doesn't carry the
/// expected top-level key.
pub(super) fn parse_mcp_file(path: &std::path::Path) -> BTreeMap<String, McpServerCfg> {
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
// Well-known MCP description catalog
// ---------------------------------------------------------------------------

fn well_known_description(name: &str) -> Option<&'static str> {
    let n = name.to_lowercase();
    let key = n
        .strip_prefix("mcp-")
        .or_else(|| n.strip_prefix("server-"))
        .unwrap_or(&n);

    match key {
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

fn generic_description(name: &str, cfg: &McpServerCfg) -> String {
    if let Some(url) = &cfg.url {
        return format!("Remote MCP server at {}.", url);
    }
    if let Some(cmd) = &cfg.command {
        if cfg.args.is_empty() {
            return format!("Local stdio server started with `{}`.", cmd);
        }
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

// ---------------------------------------------------------------------------
// Name normalisation + known-server set
// ---------------------------------------------------------------------------

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

pub(super) fn normalize_mcp_name(name: &str) -> String {
    let mut n = name.to_lowercase();
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

pub(super) fn is_unknown_mcp(name: &str) -> bool {
    !KNOWN_MCP_NAMES.contains(&normalize_mcp_name(name).as_str())
}

// ---------------------------------------------------------------------------
// McpInfo builder — joins all metadata sources into a single shape
// ---------------------------------------------------------------------------

pub(super) fn build_mcp_info(
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
        duplicate_count: 1,
        duplicate_origins: vec![origin],
        disabled: cfg.disabled,
    }
}
