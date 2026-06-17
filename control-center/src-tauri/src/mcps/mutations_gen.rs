// mcps/mutations_gen.rs — CRUD mutations, AI generation, and ping.

use std::io::{Read, Write};
use std::process::Stdio;
use std::time::{Duration, Instant};

use super::types_io::{parse_settings, McpGenerationResult, McpMutationResult, McpPingResult};
use crate::settings;

// ---------------------------------------------------------------------------
// CRUD mutations on settings.json mcpServers
// ---------------------------------------------------------------------------

/// Names that round-trip safely as JSON object keys and as mcp ids in
/// CLI commands. Lower-case kebab/underscore, starts with alnum, 2–61
/// chars total. Conservative on purpose — matches what Claude Code
/// itself uses for mcpServers entries.
fn validate_mcp_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 61 || name.len() < 2 {
        return Err("name must be 2-61 chars".to_string());
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

pub fn set_mcpjson_disabled_inner(
    name: String,
    disabled: bool,
) -> Result<McpMutationResult, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || name.len() > 200 || name.contains(['\n', '\r', '\0']) {
        return Err("invalid MCP name".to_string());
    }

    let snapshot = settings::settings_read_inner()?;
    let mut content = snapshot.content;
    let root = content
        .as_object_mut()
        .ok_or_else(|| "settings.json root is not an object".to_string())?;

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

// Hard allowlist of MCP launcher commands.
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
// AI-driven MCP scaffolding
// ---------------------------------------------------------------------------

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
- "name" is the mcpServers key. Lowercase letters, digits, '-' or '_'. Start with a letter or digit. 2-61 chars.
- "config" is the value that goes under mcpServers[name].
- For stdio servers: include "command" (e.g. "npx", "uvx", "node", "python"), "args" array, "env" object (can be empty).
- For HTTP/SSE servers: include "url" (string) and optionally "type": "sse". Omit command/args/env.
- Prefer the canonical npm/uvx package for well-known MCPs (e.g. @modelcontextprotocol/server-filesystem, server-github, server-postgres).
- If credentials are required, put placeholder env vars like "GITHUB_TOKEN": "${GITHUB_TOKEN}" -- DO NOT invent secrets.
- Be conservative with args: include only what's strictly needed to start the server.

Now produce the JSON for the described MCP."#;

fn extract_json_blob(text: &str) -> Option<String> {
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
            let candidate = candidate
                .split_once('\n')
                .map(|(_, rest)| rest.trim())
                .unwrap_or(candidate);
            if candidate.starts_with('{') {
                return Some(candidate.to_string());
            }
        }
    }
    let first = text.find('{')?;
    let last = text.rfind('}')?;
    if last <= first {
        return None;
    }
    Some(text[first..=last].to_string())
}

pub async fn generate_mcp_from_prompt_inner(
    app: &tauri::AppHandle,
    description: String,
) -> Result<McpGenerationResult, String> {
    let description = description.trim().to_string();
    if description.is_empty() {
        return Err("description is empty".to_string());
    }
    let full_prompt = MCP_PROMPT_TEMPLATE.replace("{DESCRIPTION}", &description);

    let inline =
        crate::sessions::run_inline_inner(app, "claude".to_string(), None, full_prompt).await?;

    let raw_output = if inline.stdout.trim().is_empty() {
        inline.stderr.clone()
    } else {
        inline.stdout.clone()
    };

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

    let ok = validate_mcp_name(&name).is_ok() && config.is_object();

    Ok(McpGenerationResult {
        success: ok,
        name,
        config,
        raw_output,
    })
}

// ---------------------------------------------------------------------------
// P7: ping a server
// ---------------------------------------------------------------------------

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
