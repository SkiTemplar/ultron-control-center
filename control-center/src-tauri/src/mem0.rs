// ULTRON Control Center 2.0 — Mem0 client (REST)
//
// Reads the API key from `~/.claude/settings.json` (`mem0.apiKey` field) and
// talks to Mem0 cloud at https://api.mem0.ai/v1/memories/. Used by the global
// Memory panel and (P4) the per-project Context sub-tab.
//
// v2.6 (card v27-f16): every call now appends a JSONL line to
// `~/.ultron/logs/mem0.jsonl` so the user can SEE why a call failed. The log
// captures op, timestamp, status code, latency, response body excerpt and any
// error string. Surfaced in the UI via `mem0_diagnostics`.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::time::{Duration, Instant};

const MEM0_BASE: &str = "https://api.mem0.ai/v1";
const HTTP_TIMEOUT_SECS: u64 = 5;
const MEM0_LOG_MAX_ENTRIES: usize = 200;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Mem0LogEntry {
    pub timestamp: String,
    pub op: String,
    pub ok: bool,
    pub status_code: Option<u16>,
    pub latency_ms: Option<u64>,
    pub error: Option<String>,
    pub body_excerpt: Option<String>,
    pub query: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Mem0Diagnostics {
    pub api_key_present: bool,
    pub api_key_masked: Option<String>,
    pub api_key_error: Option<String>,
    pub endpoint: String,
    pub log_path: String,
    pub last_success: Option<Mem0LogEntry>,
    pub last_error: Option<Mem0LogEntry>,
    pub recent: Vec<Mem0LogEntry>,
}

fn log_path() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron").join("logs").join("mem0.jsonl"))
}

fn body_excerpt(text: &str) -> String {
    // Trim to 2KB so the log file stays readable.
    if text.len() <= 2048 {
        text.to_string()
    } else {
        format!("{}…[truncated {} bytes]", &text[..2048], text.len() - 2048)
    }
}

fn append_log(entry: &Mem0LogEntry) {
    let Some(path) = log_path() else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let Ok(line) = serde_json::to_string(entry) else {
        return;
    };
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(f, "{line}");
    }
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Mem0Status {
    pub connected: bool,
    pub api_key_masked: Option<String>,
    pub latency_ms: Option<u64>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Mem0Memory {
    pub id: String,
    pub memory: String,
    pub user_id: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    #[serde(default)]
    pub metadata: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct Mem0SearchRequest<'a> {
    pub query: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct Mem0AddRequest<'a> {
    pub messages: Vec<Mem0Message<'a>>,
    pub user_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<&'a serde_json::Value>,
}

#[derive(Debug, Serialize)]
pub struct Mem0Message<'a> {
    pub role: &'a str,
    pub content: &'a str,
}

fn read_api_key() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("no home dir")?;
    let path = home.join(".claude").join("settings.json");
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("settings.json parse: {e}"))?;
    // The Mem0 key may live in a few places depending on how the user
    // wired the MCP server. Claude Code stores MCP entries under the
    // top-level key `mcpServers` (camelCase, single key — not a nested
    // `mcp.servers`). We check in this order:
    //   - mem0.apiKey                                          (legacy/explicit)
    //   - mcpServers.mem0.headers.Authorization                (Claude Code MCP — primary)
    //   - mcpServers."mem0-mcp".headers.Authorization          (alternate naming users sometimes pick)
    //   - mcp.servers.mem0.headers.Authorization               (very old custom layout, kept for safety)
    //   - env var MEM0_API_KEY                                 (last-resort fallback)
    let extract_token = |raw: &str| raw.trim_start_matches("Token ").trim().to_string();
    let key = if let Some(k) = v.pointer("/mem0/apiKey").and_then(|x| x.as_str()) {
        k.to_string()
    } else if let Some(h) = v
        .pointer("/mcpServers/mem0/headers/Authorization")
        .and_then(|x| x.as_str())
    {
        extract_token(h)
    } else if let Some(h) = v
        .pointer("/mcpServers/mem0-mcp/headers/Authorization")
        .and_then(|x| x.as_str())
    {
        extract_token(h)
    } else if let Some(h) = v
        .pointer("/mcp/servers/mem0/headers/Authorization")
        .and_then(|x| x.as_str())
    {
        extract_token(h)
    } else if let Ok(env_key) = std::env::var("MEM0_API_KEY") {
        env_key
    } else {
        return Err(
            "Mem0 API key not found. Add it to settings.json at mcpServers.mem0.headers.Authorization or set MEM0_API_KEY."
                .to_string(),
        );
    };
    if key.is_empty() || key.starts_with("REEMPLAZAR_CON_TU_API_KEY") {
        return Err("Mem0 API key placeholder — configure mem0.apiKey".to_string());
    }
    Ok(key)
}

fn mask_key(k: &str) -> String {
    if k.len() <= 8 {
        return "****".to_string();
    }
    format!("{}…{}", &k[..4], &k[k.len() - 4..])
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())
}

pub async fn status_inner() -> Result<Mem0Status, String> {
    let key = match read_api_key() {
        Ok(k) => k,
        Err(e) => {
            append_log(&Mem0LogEntry {
                timestamp: now_iso(),
                op: "status".into(),
                ok: false,
                status_code: None,
                latency_ms: None,
                error: Some(e.clone()),
                body_excerpt: None,
                query: None,
            });
            return Ok(Mem0Status {
                connected: false,
                api_key_masked: None,
                latency_ms: None,
                error: Some(e),
            });
        }
    };
    let masked = mask_key(&key);
    let client = http_client()?;
    let started = Instant::now();
    // NOTE: We hit `/v1/ping/` rather than `/v1/memories/?limit=1`. The Mem0
    // memories list endpoint requires at least one filter (`user_id`,
    // `agent_id`, `app_id` or `run_id`) and returns HTTP 400 otherwise, which
    // would surface as a false "not connected" in the UI. `/v1/ping/` returns
    // 200 with `{status, org_id, project_id, user_email}` whenever the token
    // is valid, which is exactly the signal the Memory tab needs.
    let resp = client
        .get(format!("{MEM0_BASE}/ping/"))
        .header("Authorization", format!("Token {key}"))
        .send()
        .await;
    let latency_ms = started.elapsed().as_millis() as u64;
    match resp {
        Ok(r) if r.status().is_success() => {
            let status_code = r.status().as_u16();
            // Read body so we can capture org/project/user_email for debug.
            let body_text = r.text().await.unwrap_or_default();
            append_log(&Mem0LogEntry {
                timestamp: now_iso(),
                op: "status".into(),
                ok: true,
                status_code: Some(status_code),
                latency_ms: Some(latency_ms),
                error: None,
                body_excerpt: Some(body_excerpt(&body_text)),
                query: None,
            });
            Ok(Mem0Status {
                connected: true,
                api_key_masked: Some(masked),
                latency_ms: Some(latency_ms),
                error: None,
            })
        }
        Ok(r) => {
            let status_code = r.status().as_u16();
            let body_text = r.text().await.unwrap_or_default();
            let err = format!("HTTP {status_code}");
            append_log(&Mem0LogEntry {
                timestamp: now_iso(),
                op: "status".into(),
                ok: false,
                status_code: Some(status_code),
                latency_ms: Some(latency_ms),
                error: Some(err.clone()),
                body_excerpt: Some(body_excerpt(&body_text)),
                query: None,
            });
            Ok(Mem0Status {
                connected: false,
                api_key_masked: Some(masked),
                latency_ms: Some(latency_ms),
                error: Some(format!("{err}: {}", body_excerpt(&body_text))),
            })
        }
        Err(e) => {
            let err = e.to_string();
            append_log(&Mem0LogEntry {
                timestamp: now_iso(),
                op: "status".into(),
                ok: false,
                status_code: None,
                latency_ms: None,
                error: Some(err.clone()),
                body_excerpt: None,
                query: None,
            });
            Ok(Mem0Status {
                connected: false,
                api_key_masked: Some(masked),
                latency_ms: None,
                error: Some(err),
            })
        }
    }
}

pub async fn search_inner(
    query: String,
    project_id: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<Mem0Memory>, String> {
    // v2.6.2 fix: Mem0 v1 search rejects blank queries with HTTP 400
    // {"query":["This field may not be blank."]}. Short-circuit empty /
    // whitespace queries so the Memory tab doesn't fire useless calls
    // when the input is cleared or on initial mount.
    if query.trim().is_empty() {
        append_log(&Mem0LogEntry {
            timestamp: now_iso(),
            op: "search".into(),
            ok: true,
            status_code: None,
            latency_ms: Some(0),
            error: None,
            body_excerpt: Some("skipped: empty query".into()),
            query: Some(query),
        });
        return Ok(Vec::new());
    }
    let key = match read_api_key() {
        Ok(k) => k,
        Err(e) => {
            append_log(&Mem0LogEntry {
                timestamp: now_iso(),
                op: "search".into(),
                ok: false,
                status_code: None,
                latency_ms: None,
                error: Some(e.clone()),
                body_excerpt: None,
                query: Some(query.clone()),
            });
            return Err(e);
        }
    };
    let client = http_client()?;
    let started = Instant::now();
    // v2.5: Mem0 v1 search REQUIRES at least one filter (user_id /
    // agent_id / app_id / run_id). When the caller passes no project_id
    // we fell through to user_id=None, which triggered HTTP 400 "Bad
    // Request" in the Memory tab. Default to a stable sentinel so
    // global search works.
    let user_id_effective = project_id.as_deref().unwrap_or("global");
    let body = Mem0SearchRequest {
        query: &query,
        user_id: Some(user_id_effective),
        limit,
    };
    let resp = match client
        .post(format!("{MEM0_BASE}/memories/search/"))
        .header("Authorization", format!("Token {key}"))
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            let err = e.to_string();
            append_log(&Mem0LogEntry {
                timestamp: now_iso(),
                op: "search".into(),
                ok: false,
                status_code: None,
                latency_ms: Some(started.elapsed().as_millis() as u64),
                error: Some(err.clone()),
                body_excerpt: None,
                query: Some(query),
            });
            return Err(err);
        }
    };
    let latency_ms = started.elapsed().as_millis() as u64;
    if !resp.status().is_success() {
        // v2.6: include response body for diagnostic context.
        let status = resp.status();
        let status_code = status.as_u16();
        let body_text = resp.text().await.unwrap_or_else(|_| "<no body>".into());
        let err = format!("Mem0 search HTTP {status}: {body_text}");
        append_log(&Mem0LogEntry {
            timestamp: now_iso(),
            op: "search".into(),
            ok: false,
            status_code: Some(status_code),
            latency_ms: Some(latency_ms),
            error: Some(err.clone()),
            body_excerpt: Some(body_excerpt(&body_text)),
            query: Some(query),
        });
        return Err(err);
    }
    let status_code = resp.status().as_u16();
    let body_text = resp.text().await.map_err(|e| e.to_string())?;
    let value: serde_json::Value = match serde_json::from_str(&body_text) {
        Ok(v) => v,
        Err(e) => {
            let err = format!("Mem0 search JSON parse: {e}");
            append_log(&Mem0LogEntry {
                timestamp: now_iso(),
                op: "search".into(),
                ok: false,
                status_code: Some(status_code),
                latency_ms: Some(latency_ms),
                error: Some(err.clone()),
                body_excerpt: Some(body_excerpt(&body_text)),
                query: Some(query),
            });
            return Err(err);
        }
    };
    // Mem0 returns either {"results": [...]} or [...] depending on api version.
    let arr = match value
        .get("results")
        .and_then(|v| v.as_array())
        .cloned()
        .or_else(|| value.as_array().cloned())
    {
        Some(arr) => arr,
        None => {
            let err = "unexpected Mem0 search response shape".to_string();
            append_log(&Mem0LogEntry {
                timestamp: now_iso(),
                op: "search".into(),
                ok: false,
                status_code: Some(status_code),
                latency_ms: Some(latency_ms),
                error: Some(err.clone()),
                body_excerpt: Some(body_excerpt(&body_text)),
                query: Some(query),
            });
            return Err(err);
        }
    };
    let result_count = arr.len();
    let memories: Vec<Mem0Memory> = serde_json::from_value(serde_json::Value::Array(arr))
        .map_err(|e| format!("Mem0 search deserialize: {e}"))?;
    append_log(&Mem0LogEntry {
        timestamp: now_iso(),
        op: "search".into(),
        ok: true,
        status_code: Some(status_code),
        latency_ms: Some(latency_ms),
        error: None,
        body_excerpt: Some(format!("results={result_count}")),
        query: Some(query),
    });
    Ok(memories)
}

pub async fn add_inner(
    content: String,
    project_id: String,
    metadata: Option<serde_json::Value>,
) -> Result<Mem0Memory, String> {
    let key = match read_api_key() {
        Ok(k) => k,
        Err(e) => {
            append_log(&Mem0LogEntry {
                timestamp: now_iso(),
                op: "add".into(),
                ok: false,
                status_code: None,
                latency_ms: None,
                error: Some(e.clone()),
                body_excerpt: None,
                query: None,
            });
            return Err(e);
        }
    };
    let client = http_client()?;
    let started = Instant::now();
    // v2.6 bug fix: empty project_id sent `user_id: ""` which Mem0 rejected
    // as HTTP 400. Fall back to "global" — same convention search_inner uses.
    let user_id_effective = if project_id.trim().is_empty() {
        "global"
    } else {
        project_id.trim()
    };
    let body = Mem0AddRequest {
        messages: vec![Mem0Message {
            role: "user",
            content: &content,
        }],
        user_id: user_id_effective,
        metadata: metadata.as_ref(),
    };
    let resp = match client
        .post(format!("{MEM0_BASE}/memories/"))
        .header("Authorization", format!("Token {key}"))
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            let err = e.to_string();
            append_log(&Mem0LogEntry {
                timestamp: now_iso(),
                op: "add".into(),
                ok: false,
                status_code: None,
                latency_ms: Some(started.elapsed().as_millis() as u64),
                error: Some(err.clone()),
                body_excerpt: None,
                query: None,
            });
            return Err(err);
        }
    };
    let latency_ms = started.elapsed().as_millis() as u64;
    if !resp.status().is_success() {
        // v2.6: include response body for diagnostic context.
        let status = resp.status();
        let status_code = status.as_u16();
        let body_text = resp.text().await.unwrap_or_else(|_| "<no body>".into());
        let err = format!("Mem0 add HTTP {status}: {body_text}");
        append_log(&Mem0LogEntry {
            timestamp: now_iso(),
            op: "add".into(),
            ok: false,
            status_code: Some(status_code),
            latency_ms: Some(latency_ms),
            error: Some(err.clone()),
            body_excerpt: Some(body_excerpt(&body_text)),
            query: None,
        });
        return Err(err);
    }
    let status_code = resp.status().as_u16();
    let body_text = resp.text().await.map_err(|e| e.to_string())?;
    let value: serde_json::Value = serde_json::from_str(&body_text).map_err(|e| e.to_string())?;
    // Some Mem0 endpoints return an array of created memories — take the first.
    let mem_val = if value.is_array() {
        value
            .as_array()
            .and_then(|a| a.first())
            .cloned()
            .ok_or("Mem0 add: empty results")?
    } else {
        value
    };
    append_log(&Mem0LogEntry {
        timestamp: now_iso(),
        op: "add".into(),
        ok: true,
        status_code: Some(status_code),
        latency_ms: Some(latency_ms),
        error: None,
        body_excerpt: Some(body_excerpt(&body_text)),
        query: None,
    });
    serde_json::from_value(mem_val).map_err(|e| format!("Mem0 add deserialize: {e}"))
}

pub async fn delete_inner(id: String) -> Result<(), String> {
    let key = match read_api_key() {
        Ok(k) => k,
        Err(e) => {
            append_log(&Mem0LogEntry {
                timestamp: now_iso(),
                op: "delete".into(),
                ok: false,
                status_code: None,
                latency_ms: None,
                error: Some(e.clone()),
                body_excerpt: None,
                query: Some(id.clone()),
            });
            return Err(e);
        }
    };
    let client = http_client()?;
    let started = Instant::now();
    let resp = match client
        .delete(format!("{MEM0_BASE}/memories/{id}/"))
        .header("Authorization", format!("Token {key}"))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            let err = e.to_string();
            append_log(&Mem0LogEntry {
                timestamp: now_iso(),
                op: "delete".into(),
                ok: false,
                status_code: None,
                latency_ms: Some(started.elapsed().as_millis() as u64),
                error: Some(err.clone()),
                body_excerpt: None,
                query: Some(id),
            });
            return Err(err);
        }
    };
    let latency_ms = started.elapsed().as_millis() as u64;
    let status_code = resp.status().as_u16();
    if !resp.status().is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        let err = format!("Mem0 delete HTTP {status_code}");
        append_log(&Mem0LogEntry {
            timestamp: now_iso(),
            op: "delete".into(),
            ok: false,
            status_code: Some(status_code),
            latency_ms: Some(latency_ms),
            error: Some(err.clone()),
            body_excerpt: Some(body_excerpt(&body_text)),
            query: Some(id),
        });
        return Err(err);
    }
    append_log(&Mem0LogEntry {
        timestamp: now_iso(),
        op: "delete".into(),
        ok: true,
        status_code: Some(status_code),
        latency_ms: Some(latency_ms),
        error: None,
        body_excerpt: None,
        query: Some(id),
    });
    Ok(())
}

/// Read the last N lines of the mem0 log and produce a digest.
pub fn diagnostics_inner() -> Result<Mem0Diagnostics, String> {
    let endpoint = MEM0_BASE.to_string();
    let path = log_path().ok_or("no HOME dir for log path")?;
    let log_path_str = path.display().to_string();

    let (api_key_present, api_key_masked, api_key_error) = match read_api_key() {
        Ok(k) => (true, Some(mask_key(&k)), None),
        Err(e) => (false, None, Some(e)),
    };

    let mut recent: Vec<Mem0LogEntry> = Vec::new();
    if path.exists() {
        let text = std::fs::read_to_string(&path)
            .map_err(|e| format!("read mem0 log: {e}"))?;
        // Take the last MEM0_LOG_MAX_ENTRIES lines.
        let lines: Vec<&str> = text.lines().rev().take(MEM0_LOG_MAX_ENTRIES).collect();
        for line in lines.into_iter().rev() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Ok(entry) = serde_json::from_str::<Mem0LogEntry>(trimmed) {
                recent.push(entry);
            }
        }
    }

    let last_success = recent.iter().rev().find(|e| e.ok).cloned();
    let last_error = recent.iter().rev().find(|e| !e.ok).cloned();

    Ok(Mem0Diagnostics {
        api_key_present,
        api_key_masked,
        api_key_error,
        endpoint,
        log_path: log_path_str,
        last_success,
        last_error,
        recent,
    })
}

/// Active connectivity test — same as `status_inner` but exposed under its
/// own command name so the UI button can show a discrete "Test connection"
/// outcome without affecting the background poll loop.
pub async fn test_connection_inner() -> Result<Mem0Status, String> {
    status_inner().await
}
