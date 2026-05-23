// ULTRON Control Center 2.0 — Mem0 client (REST)
//
// Reads the API key from `~/.claude/settings.json` (`mem0.apiKey` field) and
// talks to Mem0 cloud at https://api.mem0.ai/v1/memories/. Used by the global
// Memory panel and (P4) the per-project Context sub-tab.

use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

const MEM0_BASE: &str = "https://api.mem0.ai/v1";
const HTTP_TIMEOUT_SECS: u64 = 5;

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
        Ok(r) if r.status().is_success() => Ok(Mem0Status {
            connected: true,
            api_key_masked: Some(masked),
            latency_ms: Some(latency_ms),
            error: None,
        }),
        Ok(r) => Ok(Mem0Status {
            connected: false,
            api_key_masked: Some(masked),
            latency_ms: Some(latency_ms),
            error: Some(format!("HTTP {}", r.status())),
        }),
        Err(e) => Ok(Mem0Status {
            connected: false,
            api_key_masked: Some(masked),
            latency_ms: None,
            error: Some(e.to_string()),
        }),
    }
}

pub async fn search_inner(
    query: String,
    project_id: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<Mem0Memory>, String> {
    let key = read_api_key()?;
    let client = http_client()?;
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
    let resp = client
        .post(format!("{MEM0_BASE}/memories/search/"))
        .header("Authorization", format!("Token {key}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Mem0 search HTTP {}", resp.status()));
    }
    let value: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    // Mem0 returns either {"results": [...]} or [...] depending on api version.
    let arr = value
        .get("results")
        .and_then(|v| v.as_array())
        .cloned()
        .or_else(|| value.as_array().cloned())
        .ok_or("unexpected Mem0 search response shape")?;
    let memories: Vec<Mem0Memory> = serde_json::from_value(serde_json::Value::Array(arr))
        .map_err(|e| format!("Mem0 search deserialize: {e}"))?;
    Ok(memories)
}

pub async fn add_inner(
    content: String,
    project_id: String,
    metadata: Option<serde_json::Value>,
) -> Result<Mem0Memory, String> {
    let key = read_api_key()?;
    let client = http_client()?;
    let body = Mem0AddRequest {
        messages: vec![Mem0Message {
            role: "user",
            content: &content,
        }],
        user_id: &project_id,
        metadata: metadata.as_ref(),
    };
    let resp = client
        .post(format!("{MEM0_BASE}/memories/"))
        .header("Authorization", format!("Token {key}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Mem0 add HTTP {}", resp.status()));
    }
    let value: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
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
    serde_json::from_value(mem_val).map_err(|e| format!("Mem0 add deserialize: {e}"))
}

pub async fn delete_inner(id: String) -> Result<(), String> {
    let key = read_api_key()?;
    let client = http_client()?;
    let resp = client
        .delete(format!("{MEM0_BASE}/memories/{id}/"))
        .header("Authorization", format!("Token {key}"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Mem0 delete HTTP {}", resp.status()));
    }
    Ok(())
}
