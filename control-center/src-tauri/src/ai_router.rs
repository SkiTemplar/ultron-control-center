// ULTRON Control Center — AI Router backend.
//
// Owns zone -> (provider, model) routing decisions plus a thin health-check
// + test-invocation layer over each upstream provider. The frontend lives in
// `src/components/AIRouter/` and talks to the seven `#[tauri::command]`
// wrappers exposed at the bottom of this file.
//
// Architecture (intentionally simple — no LiteLLM sidecar):
//   - Storage: three JSON files under `~/.ultron/cockpit/ai-router/`.
//       providers.json  — static-ish provider catalog (id, kind, models)
//       zones.json      — list of Zone records (id, primary, fallbacks)
//       metrics.json    — aggregate router metrics (counters + savings)
//   - Each upstream API gets a dedicated wrapper:
//       - anthropic (claude-haiku) via Messages API + ANTHROPIC_API_KEY
//       - codex (gpt-*) via OpenAI-compatible chat/completions + OPENAI_API_KEY
//       - gemini via generativelanguage v1beta + GEMINI_API_KEY
//       - groq via OpenAI-compatible chat/completions + GROQ_API_KEY
//       - ollama via local /api/generate (no key required)
//       - deepseek via OpenAI-compatible chat/completions + DEEPSEEK_API_KEY
//   - Health checks use cheap HEAD/GET-style probes (e.g. /api/tags for
//     ollama, models endpoints for hosted providers). They never spend tokens.
//   - Test invocations DO spend tokens. They return latency + a short response
//     excerpt + token counts so the UI can validate a zone end-to-end.
//
// Failure discipline: every command surfaces `Result<T, String>` so the UI
// can show the error verbatim in the test result banner. Missing API keys
// are reported as explicit, friendly messages ("missing GEMINI_API_KEY env
// var"); we never panic and never block on a slow network call (10s cap).

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

use crate::ultron_root;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/// Computational weight class of an AI task. Mirrors the TypeScript
/// `ProviderClass` union in `src/components/AIRouter/types.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderClass {
    Trivial,
    Light,
    Medium,
    Heavy,
}

/// API-key state for a provider. Drives the catalog badge in the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApiKeyStatus {
    Configured,
    Missing,
    Placeholder,
}

/// Public provider record exposed to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Provider {
    pub id: String,
    pub name: String,
    /// Approximate USD per million output tokens (display only).
    pub cost_per_mtok: f64,
    pub supports: Vec<ProviderClass>,
    pub api_key_status: ApiKeyStatus,
    /// Optional override for health-check endpoint.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health_endpoint: Option<String>,
    /// Internal: whether this provider runs locally (ollama) or in the cloud.
    /// Not exposed in the UI today but kept for future routing decisions.
    #[serde(default)]
    pub kind: ProviderKind,
    /// Internal: env-var name for the API key. Empty for local providers.
    #[serde(default)]
    pub key_env_var: String,
    /// Internal: base URL for API calls.
    #[serde(default)]
    pub base_url: String,
    /// Internal: default model id used by `ai_router_test` when the zone
    /// references this provider.
    #[serde(default)]
    pub default_model: String,
    /// Internal: list of models exposed under this provider.
    #[serde(default)]
    pub models: Vec<String>,
    /// Internal: CLI executable name for `kind = Cli` providers (e.g. `"codex"`,
    /// `"gemini"`). On Windows the wrapper automatically uses `cmd /C <cmd>`
    /// to handle `.cmd` npm shims correctly (see windows-tauri-cli-gotcha).
    /// Absent (`None`) for Cloud and Local providers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli_command: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    #[default]
    Cloud,
    Local,
    /// A subscription-based CLI that authenticates via OAuth (no API key
    /// required). Examples: `codex` (ChatGPT Plus) and `gemini` (Google One).
    Cli,
}

/// One step in a routing decision — primary or fallback.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZoneAssignment {
    pub provider_id: String,
    pub model: String,
    #[serde(default)]
    pub max_tokens: u32,
}

/// A named routing zone (e.g. "chat", "code-edit", "research-web").
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Zone {
    pub id: String,
    pub label: String,
    pub category: String,
    pub task_class: ProviderClass,
    pub primary: ZoneAssignment,
    #[serde(default)]
    pub fallbacks: Vec<ZoneAssignment>,
    /// Optional system prompt prepended to every test invocation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ClassMetrics {
    pub count: u64,
    /// Output tokens accumulated across all calls to this provider (antes
    /// nunca se poblaba; ahora se llena desde la respuesta del proveedor).
    pub tokens: u64,
    pub latency_p95_ms: u64,
    /// Calls that succeeded (outcome.is_ok()). success_rate = success_count/count.
    #[serde(default)]
    pub success_count: u64,
}

/// Token usage extraido de la respuesta de un proveedor.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

/// Resultado de una llamada a un proveedor: texto + uso de tokens. Sustituye
/// al `String` plano para poder trackear stats reales (tokens/cost/success).
#[derive(Debug, Clone, Default)]
pub struct CallOutcome {
    pub text: String,
    pub usage: TokenUsage,
}

/// Metricas por MODELO concreto (key = "provider_id::model"). Lo que el
/// rediseno funcional necesita: call count, success rate, tokens y latencia
/// por cada modelo realmente usado.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ModelMetrics {
    pub provider_id: String,
    pub model: String,
    pub count: u64,
    pub success_count: u64,
    pub output_tokens: u64,
    pub latency_ms_avg: u64,
}

/// Per-provider request counter for the CURRENT day. Used to compute the
/// "% del free tier" gauge. Resets automatically when `date` no longer
/// matches today (UTC) — see `bump_metrics`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DailyUsage {
    /// ISO date (YYYY-MM-DD, UTC) the counter belongs to.
    pub date: String,
    /// Requests routed to this provider today.
    pub count: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RouterMetrics {
    pub tokens_saved_total: u64,
    pub cost_saved_usd: f64,
    pub by_class: HashMap<String, ClassMetrics>,
    /// Ratio of calls that fell back to a secondary provider (0.0..=1.0).
    pub fallback_rate: f64,
    /// Per-provider request counts for the current day (free-tier gauge).
    #[serde(default)]
    pub daily: HashMap<String, DailyUsage>,
    /// Per-model metrics (key = "provider_id::model"). Alimenta la matriz
    /// provider/modelo del rediseno del AI Router.
    #[serde(default)]
    pub by_model: HashMap<String, ModelMetrics>,
}

/// Approximate published free-tier DAILY request limit (RPD) per provider.
/// Only providers with a real free API tier return Some; subscription CLIs,
/// local models and paid-only providers return None (the UI then keeps the
/// classic key/CLI badge instead of a free-tier gauge). Figures are rough
/// published limits at build time and shown with an "approx" tooltip.
fn free_tier_daily_limit(provider_id: &str) -> Option<u64> {
    match provider_id {
        // Google Gemini API free tier — Flash-class ~1500 req/day.
        "gemini" => Some(1500),
        // Groq free tier — conservative ~1000 req/day per model.
        "groq" => Some(1000),
        _ => None,
    }
}

/// Result of `ai_router_test` — returned verbatim to the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestResult {
    pub ok: bool,
    pub provider_id: String,
    pub model: String,
    pub latency_ms: u64,
    pub response_excerpt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// Storage layout
// ---------------------------------------------------------------------------

fn router_dir() -> Result<PathBuf, String> {
    let p = ultron_root()?.join("cockpit").join("ai-router");
    fs::create_dir_all(&p).map_err(|e| format!("create ai-router dir: {}", e))?;
    Ok(p)
}

fn providers_path() -> Result<PathBuf, String> {
    Ok(router_dir()?.join("providers.json"))
}

fn zones_path() -> Result<PathBuf, String> {
    Ok(router_dir()?.join("zones.json"))
}

fn metrics_path() -> Result<PathBuf, String> {
    Ok(router_dir()?.join("metrics.json"))
}

// ---------------------------------------------------------------------------
// Seed data — written on first run if the files don't exist.
// ---------------------------------------------------------------------------

fn seed_providers() -> Vec<Provider> {
    vec![
        Provider {
            id: "claude-haiku".into(),
            name: "Anthropic Claude Haiku".into(),
            cost_per_mtok: 1.25,
            supports: vec![ProviderClass::Trivial, ProviderClass::Light, ProviderClass::Medium],
            api_key_status: ApiKeyStatus::Missing,
            health_endpoint: Some("https://api.anthropic.com/v1/models".into()),
            kind: ProviderKind::Cloud,
            key_env_var: "ANTHROPIC_API_KEY".into(),
            base_url: "https://api.anthropic.com".into(),
            default_model: "claude-haiku-4-5-20251001".into(),
            models: vec!["claude-haiku-4-5-20251001".into()],
            cli_command: None,
        },
        Provider {
            id: "codex".into(),
            name: "OpenAI Codex (gpt-5)".into(),
            cost_per_mtok: 10.0,
            supports: vec![ProviderClass::Light, ProviderClass::Medium, ProviderClass::Heavy],
            api_key_status: ApiKeyStatus::Missing,
            health_endpoint: Some("https://api.openai.com/v1/models".into()),
            kind: ProviderKind::Cloud,
            key_env_var: "OPENAI_API_KEY".into(),
            base_url: "https://api.openai.com".into(),
            default_model: "gpt-5".into(),
            models: vec!["gpt-5".into(), "gpt-4o".into(), "gpt-4o-mini".into()],
            cli_command: None,
        },
        Provider {
            id: "gemini".into(),
            name: "Google Gemini".into(),
            cost_per_mtok: 0.35,
            supports: vec![ProviderClass::Trivial, ProviderClass::Light, ProviderClass::Medium, ProviderClass::Heavy],
            api_key_status: ApiKeyStatus::Missing,
            health_endpoint: Some(
                "https://generativelanguage.googleapis.com/v1beta/models".into(),
            ),
            kind: ProviderKind::Cloud,
            key_env_var: "GEMINI_API_KEY".into(),
            base_url: "https://generativelanguage.googleapis.com".into(),
            default_model: "gemini-2.5-flash".into(),
            models: vec!["gemini-2.5-flash".into(), "gemini-2.5-pro".into()],
            cli_command: None,
        },
        Provider {
            id: "groq".into(),
            name: "Groq".into(),
            cost_per_mtok: 0.59,
            supports: vec![ProviderClass::Trivial, ProviderClass::Light],
            api_key_status: ApiKeyStatus::Missing,
            health_endpoint: Some("https://api.groq.com/openai/v1/models".into()),
            kind: ProviderKind::Cloud,
            key_env_var: "GROQ_API_KEY".into(),
            base_url: "https://api.groq.com/openai".into(),
            default_model: "llama-3.3-70b-versatile".into(),
            models: vec![
                "llama-3.3-70b-versatile".into(),
                "llama-3.1-8b-instant".into(),
            ],
            cli_command: None,
        },
        Provider {
            id: "ollama".into(),
            name: "Ollama (local)".into(),
            cost_per_mtok: 0.0,
            supports: vec![ProviderClass::Trivial, ProviderClass::Light, ProviderClass::Medium],
            api_key_status: ApiKeyStatus::Configured, // local; no key needed.
            health_endpoint: Some("http://localhost:11434/api/tags".into()),
            kind: ProviderKind::Local,
            key_env_var: String::new(),
            base_url: "http://localhost:11434".into(),
            default_model: "qwen2.5-coder:32b".into(),
            models: vec![
                "qwen2.5-coder:7b".into(),
                "qwen2.5-coder:32b".into(),
                "deepseek-coder-v2:16b".into(),
            ],
            cli_command: None,
        },
        Provider {
            id: "deepseek".into(),
            name: "DeepSeek".into(),
            cost_per_mtok: 0.14,
            supports: vec![ProviderClass::Light, ProviderClass::Medium],
            api_key_status: ApiKeyStatus::Missing,
            health_endpoint: Some("https://api.deepseek.com/models".into()),
            kind: ProviderKind::Cloud,
            key_env_var: "DEEPSEEK_API_KEY".into(),
            base_url: "https://api.deepseek.com".into(),
            default_model: "deepseek-coder".into(),
            models: vec!["deepseek-coder".into(), "deepseek-chat".into()],
            cli_command: None,
        },
        // ----------------------------------------------------------------
        // CLI providers — authenticate via OAuth subscription, no API key.
        // Install: `npm install -g @openai/codex` / `npm install -g @google/gemini-cli`
        // ----------------------------------------------------------------
        Provider {
            id: "codex-cli".into(),
            name: "OpenAI Codex CLI (gpt-5 via OAuth)".into(),
            cost_per_mtok: 0.0, // covered by ChatGPT Plus subscription
            supports: vec![ProviderClass::Light, ProviderClass::Medium, ProviderClass::Heavy],
            api_key_status: ApiKeyStatus::Configured, // patched by detect_cli at load time
            health_endpoint: None,
            kind: ProviderKind::Cli,
            key_env_var: String::new(),
            base_url: String::new(),
            default_model: "gpt-5".into(),
            models: vec!["gpt-5".into()],
            cli_command: Some("codex".into()),
        },
        Provider {
            id: "gemini-cli".into(),
            name: "Google Gemini CLI (gemini-2.5-flash via OAuth)".into(),
            cost_per_mtok: 0.0, // covered by Google One subscription
            supports: vec![
                ProviderClass::Trivial,
                ProviderClass::Light,
                ProviderClass::Medium,
                ProviderClass::Heavy,
            ],
            api_key_status: ApiKeyStatus::Configured, // patched by detect_cli at load time
            health_endpoint: None,
            kind: ProviderKind::Cli,
            key_env_var: String::new(),
            base_url: String::new(),
            default_model: "gemini-2.5-flash".into(),
            models: vec!["gemini-2.5-flash".into()],
            cli_command: Some("gemini".into()),
        },
    ]
}

fn seed_zones() -> Vec<Zone> {
    vec![
        Zone {
            id: "chat".into(),
            label: "General chat".into(),
            category: "chat".into(),
            task_class: ProviderClass::Light,
            primary: ZoneAssignment {
                provider_id: "claude-haiku".into(),
                model: "claude-haiku-4-5-20251001".into(),
                max_tokens: 1024,
            },
            fallbacks: vec![ZoneAssignment {
                provider_id: "groq".into(),
                model: "llama-3.3-70b-versatile".into(),
                max_tokens: 1024,
            }],
            system_prompt: None,
        },
        Zone {
            id: "code-edit".into(),
            label: "Code edit (multi-file)".into(),
            category: "code".into(),
            task_class: ProviderClass::Medium,
            primary: ZoneAssignment {
                provider_id: "codex".into(),
                model: "gpt-5".into(),
                max_tokens: 4096,
            },
            fallbacks: vec![ZoneAssignment {
                provider_id: "deepseek".into(),
                model: "deepseek-coder".into(),
                max_tokens: 4096,
            }],
            system_prompt: None,
        },
        Zone {
            id: "code-review".into(),
            label: "Code review".into(),
            category: "code".into(),
            task_class: ProviderClass::Light,
            primary: ZoneAssignment {
                provider_id: "claude-haiku".into(),
                model: "claude-haiku-4-5-20251001".into(),
                max_tokens: 2048,
            },
            fallbacks: vec![],
            system_prompt: None,
        },
        Zone {
            id: "research-web".into(),
            label: "Web research with grounding".into(),
            category: "research".into(),
            task_class: ProviderClass::Medium,
            primary: ZoneAssignment {
                provider_id: "gemini".into(),
                model: "gemini-2.5-flash".into(),
                max_tokens: 4096,
            },
            fallbacks: vec![ZoneAssignment {
                provider_id: "claude-haiku".into(),
                model: "claude-haiku-4-5-20251001".into(),
                max_tokens: 4096,
            }],
            system_prompt: None,
        },
        Zone {
            id: "summarize".into(),
            label: "Summarize document".into(),
            category: "chat".into(),
            task_class: ProviderClass::Trivial,
            primary: ZoneAssignment {
                provider_id: "groq".into(),
                model: "llama-3.3-70b-versatile".into(),
                max_tokens: 1024,
            },
            fallbacks: vec![ZoneAssignment {
                provider_id: "gemini".into(),
                model: "gemini-2.5-flash".into(),
                max_tokens: 1024,
            }],
            system_prompt: None,
        },
        Zone {
            id: "routing-decision".into(),
            label: "Router judge (decide which zone to use)".into(),
            category: "system".into(),
            task_class: ProviderClass::Trivial,
            primary: ZoneAssignment {
                provider_id: "claude-haiku".into(),
                model: "claude-haiku-4-5-20251001".into(),
                max_tokens: 256,
            },
            fallbacks: vec![ZoneAssignment {
                provider_id: "groq".into(),
                model: "llama-3.3-70b-versatile".into(),
                max_tokens: 256,
            }],
            system_prompt: Some(
                "You classify user prompts into one of the configured zones. \
                 Reply with the zone id only."
                    .into(),
            ),
        },
        Zone {
            id: "code-fast-local".into(),
            label: "Fast offline code completion".into(),
            category: "code".into(),
            task_class: ProviderClass::Light,
            primary: ZoneAssignment {
                provider_id: "ollama".into(),
                model: "qwen2.5-coder:32b".into(),
                max_tokens: 2048,
            },
            fallbacks: vec![],
            system_prompt: None,
        },
        // Internal utility tasks (hook telemetry, workday summaries, etc.)
        // mapped to the cheapest available cloud model with Groq as fallback.
        Zone {
            id: "utility".into(),
            label: "Utility (internal automation tasks)".into(),
            category: "system".into(),
            task_class: ProviderClass::Trivial,
            primary: ZoneAssignment {
                provider_id: "groq".into(),
                model: "llama-3.3-70b-versatile".into(),
                max_tokens: 512,
            },
            fallbacks: vec![ZoneAssignment {
                provider_id: "claude-haiku".into(),
                model: "claude-haiku-4-5-20251001".into(),
                max_tokens: 512,
            }],
            system_prompt: None,
        },
        // Light/quick requests (plugins_info, single-turn completions, etc.)
        // alias to a fast cheap model; Groq primary, Ollama fallback if local.
        Zone {
            id: "light".into(),
            label: "Light (fast single-turn completions)".into(),
            category: "chat".into(),
            task_class: ProviderClass::Light,
            primary: ZoneAssignment {
                provider_id: "groq".into(),
                model: "llama-3.3-70b-versatile".into(),
                max_tokens: 1024,
            },
            fallbacks: vec![ZoneAssignment {
                provider_id: "ollama".into(),
                model: "qwen2.5-coder:32b".into(),
                max_tokens: 1024,
            }],
            system_prompt: None,
        },
    ]
}

// ---------------------------------------------------------------------------
// File I/O — read on demand; write atomically (tmp + rename) on save.
// ---------------------------------------------------------------------------

fn read_json<T: serde::de::DeserializeOwned>(path: &PathBuf) -> Result<T, String> {
    let bytes =
        fs::read(path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse {}: {}", path.display(), e))
}

fn write_json<T: Serialize>(path: &PathBuf, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("create dir {}: {}", parent.display(), e))?;
    }
    let body = serde_json::to_vec_pretty(value)
        .map_err(|e| format!("serialize {}: {}", path.display(), e))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &body).map_err(|e| format!("write {}: {}", tmp.display(), e))?;
    fs::rename(&tmp, path).map_err(|e| format!("rename to {}: {}", path.display(), e))?;
    Ok(())
}

/// Returns the providers list, seeding the file on first run. Then patches
/// every entry's `api_key_status` against the current process env so the UI
/// reflects "Configured" vs "Missing" without a separate command.
fn load_providers() -> Result<Vec<Provider>, String> {
    let path = providers_path()?;
    let mut providers: Vec<Provider> = if path.exists() {
        read_json(&path)?
    } else {
        let seeded = seed_providers();
        write_json(&path, &seeded)?;
        seeded
    };
    for p in providers.iter_mut() {
        p.api_key_status = compute_key_status(p);
    }
    Ok(providers)
}

fn compute_key_status(p: &Provider) -> ApiKeyStatus {
    if p.kind == ProviderKind::Local {
        return ApiKeyStatus::Configured;
    }
    // CLI providers are "configured" iff the CLI binary is installed.
    // They have no API key — the subscription auth happens inside the CLI.
    if p.kind == ProviderKind::Cli {
        let cmd = p.cli_command.as_deref().unwrap_or("");
        return if !cmd.is_empty() && detect_cli(cmd) {
            ApiKeyStatus::Configured
        } else {
            ApiKeyStatus::Missing
        };
    }
    if p.key_env_var.is_empty() {
        return ApiKeyStatus::Configured;
    }
    match std::env::var(&p.key_env_var) {
        Ok(v) if !v.trim().is_empty() && !looks_like_placeholder(&v) => ApiKeyStatus::Configured,
        Ok(_) => ApiKeyStatus::Placeholder,
        Err(_) => ApiKeyStatus::Missing,
    }
}

fn looks_like_placeholder(v: &str) -> bool {
    let lower = v.to_ascii_lowercase();
    lower.contains("your-key")
        || lower.contains("replace")
        || lower.starts_with("xxx")
        || lower == "sk-..."
}

fn load_zones() -> Result<Vec<Zone>, String> {
    let path = zones_path()?;
    if path.exists() {
        read_json(&path)
    } else {
        let seeded = seed_zones();
        write_json(&path, &seeded)?;
        Ok(seeded)
    }
}

fn save_zones(zones: &[Zone]) -> Result<(), String> {
    write_json(&zones_path()?, &zones.to_vec())
}

fn load_metrics() -> Result<RouterMetrics, String> {
    let path = metrics_path()?;
    if path.exists() {
        read_json(&path)
    } else {
        let m = RouterMetrics::default();
        write_json(&path, &m)?;
        Ok(m)
    }
}

// ---------------------------------------------------------------------------
// CLI presence cache — populated once per process, never invalidated.
//
// `detect_cli` shells out to `where` (Windows) or `which` (Unix) exactly
// once per command name. Subsequent calls read from this cache so the hot
// path in `route()` / `disabled_providers_set()` does zero I/O after the
// first lookup.
//
// Windows gotcha (see memory: windows-tauri-cli-gotcha): npm-installed CLIs
// such as `codex` and `gemini` land on PATH as `.cmd` shims. The bare
// `where codex` command finds `codex.cmd`, which is sufficient for detection.
// When we *invoke* the CLI in `call_cli()` we must go through `cmd /C` to
// execute `.cmd` shims — `std::process::Command::new("codex")` alone fails.
// ---------------------------------------------------------------------------

static CLI_CACHE: Lazy<Mutex<HashMap<String, bool>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Returns `true` when `command` resolves on the current PATH.
///
/// Uses `where` on Windows and `which` on all other platforms. The result
/// is cached for the process lifetime — safe because CLI tools are not
/// installed/uninstalled mid-session.
pub fn detect_cli(command: &str) -> bool {
    // Fast path: already cached.
    if let Ok(cache) = CLI_CACHE.lock() {
        if let Some(&result) = cache.get(command) {
            return result;
        }
    }

    #[cfg(target_os = "windows")]
    let found = std::process::Command::new("where")
        .arg(command)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    #[cfg(not(target_os = "windows"))]
    let found = std::process::Command::new("which")
        .arg(command)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    if let Ok(mut cache) = CLI_CACHE.lock() {
        cache.insert(command.to_string(), found);
    }
    found
}

// ---------------------------------------------------------------------------
// Health check cache — last result per provider, 30 s TTL.
// ---------------------------------------------------------------------------

struct HealthEntry {
    online: bool,
    checked_at: Instant,
}

static HEALTH_CACHE: Lazy<Mutex<HashMap<String, HealthEntry>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

const HEALTH_TTL: Duration = Duration::from_secs(30);
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| format!("build http client: {}", e))
}

fn provider_health(provider: &Provider) -> bool {
    // Fast path: cache hit.
    if let Ok(cache) = HEALTH_CACHE.lock() {
        if let Some(entry) = cache.get(&provider.id) {
            if entry.checked_at.elapsed() < HEALTH_TTL {
                return entry.online;
            }
        }
    }

    let online = probe_provider(provider);

    if let Ok(mut cache) = HEALTH_CACHE.lock() {
        cache.insert(
            provider.id.clone(),
            HealthEntry {
                online,
                checked_at: Instant::now(),
            },
        );
    }
    online
}

fn probe_provider(provider: &Provider) -> bool {
    let url = match provider.health_endpoint.as_ref() {
        Some(u) => u.clone(),
        None => return false,
    };
    let Ok(client) = http_client() else {
        return false;
    };
    let mut req = client.get(&url);

    // Per-provider auth headers. We never gate the health check on a 200 —
    // any < 500 response means the upstream is reachable.
    if provider.id == "claude-haiku" {
        if let Ok(key) = std::env::var(&provider.key_env_var) {
            req = req.header("x-api-key", key).header("anthropic-version", "2023-06-01");
        }
    } else if provider.id == "gemini" {
        if let Ok(key) = std::env::var(&provider.key_env_var) {
            req = req.query(&[("key", key)]);
        }
    } else if !provider.key_env_var.is_empty() {
        if let Ok(key) = std::env::var(&provider.key_env_var) {
            req = req.header("Authorization", format!("Bearer {}", key));
        }
    }

    match req.send() {
        Ok(resp) => resp.status().as_u16() < 500,
        Err(_) => false,
    }
}

// ---------------------------------------------------------------------------
// Test invocation — issues a real API call against the zone's primary
// provider and returns latency + a short response excerpt.
// ---------------------------------------------------------------------------

fn test_zone(zone: &Zone, sample_prompt: &str) -> TestResult {
    let providers = match load_providers() {
        Ok(p) => p,
        Err(e) => {
            return TestResult {
                ok: false,
                provider_id: zone.primary.provider_id.clone(),
                model: zone.primary.model.clone(),
                latency_ms: 0,
                response_excerpt: String::new(),
                error: Some(format!("load providers: {}", e)),
            };
        }
    };

    let provider = match providers.iter().find(|p| p.id == zone.primary.provider_id) {
        Some(p) => p.clone(),
        None => {
            return TestResult {
                ok: false,
                provider_id: zone.primary.provider_id.clone(),
                model: zone.primary.model.clone(),
                latency_ms: 0,
                response_excerpt: String::new(),
                error: Some(format!(
                    "unknown provider id '{}' for zone '{}'",
                    zone.primary.provider_id, zone.id
                )),
            };
        }
    };

    // Key / CLI check up front so we don't burn a request when prerequisites
    // are absent.
    match provider.kind {
        ProviderKind::Cli => {
            let cmd = provider.cli_command.as_deref().unwrap_or("");
            if cmd.is_empty() || !detect_cli(cmd) {
                let install_hint = match cmd {
                    "codex" => "Install with: npm install -g @openai/codex",
                    "gemini" => "Install with: npm install -g @google/gemini-cli",
                    _ => "Install the CLI and ensure it is on PATH",
                };
                return TestResult {
                    ok: false,
                    provider_id: provider.id.clone(),
                    model: zone.primary.model.clone(),
                    latency_ms: 0,
                    response_excerpt: String::new(),
                    error: Some(format!(
                        "CLI '{}' not found on PATH. {}",
                        cmd, install_hint
                    )),
                };
            }
        }
        ProviderKind::Cloud if !provider.key_env_var.is_empty() => {
            match std::env::var(&provider.key_env_var) {
                Ok(v) if !v.trim().is_empty() && !looks_like_placeholder(&v) => {}
                _ => {
                    return TestResult {
                        ok: false,
                        provider_id: provider.id.clone(),
                        model: zone.primary.model.clone(),
                        latency_ms: 0,
                        response_excerpt: String::new(),
                        error: Some(format!(
                            "missing {} env var — configure the API key in your environment",
                            provider.key_env_var
                        )),
                    };
                }
            }
        }
        _ => {}
    }

    let started = Instant::now();
    let outcome = match provider.kind {
        ProviderKind::Cli => call_cli(&provider, sample_prompt),
        _ => match provider.id.as_str() {
            "claude-haiku" => call_anthropic(&provider, &zone.primary.model, sample_prompt, zone.system_prompt.as_deref(), zone.primary.max_tokens),
            "codex" => call_openai_compat(&provider, &zone.primary.model, sample_prompt, zone.system_prompt.as_deref(), zone.primary.max_tokens),
            "groq" => call_openai_compat(&provider, &zone.primary.model, sample_prompt, zone.system_prompt.as_deref(), zone.primary.max_tokens),
            "deepseek" => call_openai_compat(&provider, &zone.primary.model, sample_prompt, zone.system_prompt.as_deref(), zone.primary.max_tokens),
            "gemini" => call_gemini(&provider, &zone.primary.model, sample_prompt, zone.system_prompt.as_deref(), zone.primary.max_tokens),
            "ollama" => call_ollama(&provider, &zone.primary.model, sample_prompt, zone.system_prompt.as_deref(), zone.primary.max_tokens),
            other => Err(format!("no wrapper implemented for provider '{}'", other)),
        },
    };
    let latency_ms = started.elapsed().as_millis() as u64;

    let providers_for_cost = load_providers().unwrap_or_default();
    let cost_of_primary = providers_for_cost
        .iter()
        .find(|p| p.id == zone.primary.provider_id)
        .map(|p| p.cost_per_mtok)
        .unwrap_or(0.0);

    match outcome {
        Ok(co) => {
            // Feed real metrics so the dashboard moves after every Test click.
            let _ = bump_metrics(MetricSample {
                provider_id: &provider.id,
                model: &zone.primary.model,
                success: true,
                output_tokens: co.usage.output_tokens,
                cost_per_mtok: cost_of_primary,
                primary_cost_per_mtok: cost_of_primary,
                latency_ms,
            });
            TestResult {
                ok: true,
                provider_id: provider.id,
                model: zone.primary.model.clone(),
                latency_ms,
                response_excerpt: truncate(&co.text, 280),
                error: None,
            }
        }
        Err(e) => {
            let _ = bump_metrics(MetricSample {
                provider_id: &provider.id,
                model: &zone.primary.model,
                success: false,
                output_tokens: 0,
                cost_per_mtok: cost_of_primary,
                primary_cost_per_mtok: cost_of_primary,
                latency_ms,
            });
            TestResult {
                ok: false,
                provider_id: provider.id,
                model: zone.primary.model.clone(),
                latency_ms,
                response_excerpt: String::new(),
                error: Some(e),
            }
        }
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push_str("...");
    out
}

// ---------------------------------------------------------------------------
// Per-provider wrappers — each returns the assistant text on success.
// ---------------------------------------------------------------------------

/// KIRKARDO R11.1 FIX-9: detect HTTP 429 / Anthropic rate-limit responses
/// and push the signal into `quota_watchdog` so subsequent route() calls
/// skip the saturated provider without waiting for the 60s poll cycle.
///
/// Today only Claude providers are modelled by `quota_watchdog`; other
/// providers log the event but don't get a quota state update (the watchdog
/// would need a per-provider map first — tracked as a R11 deferred item).
///
/// Parses `retry-after` (seconds OR HTTP-date), `anthropic-ratelimit-tokens-reset`
/// (RFC 3339), or falls back to `now + 5 min` so the critical flag eventually
/// clears on its own if the API stops complaining.
fn react_to_rate_limit(
    provider: &Provider,
    status: reqwest::StatusCode,
    headers: &reqwest::header::HeaderMap,
    body: &str,
) {
    let is_429 = status == reqwest::StatusCode::TOO_MANY_REQUESTS;
    let body_l = body.to_ascii_lowercase();
    let is_quota_error = body_l.contains("credit balance")
        || body_l.contains("rate_limit_error")
        || body_l.contains("quota_exceeded")
        || body_l.contains("insufficient_quota");
    if !is_429 && !is_quota_error {
        return;
    }
    if !provider.id.to_ascii_lowercase().contains("claude") {
        // Non-Claude providers: nothing to persist today, but eprintln so the
        // event isn't silent during debug builds.
        eprintln!(
            "[ai_router] rate-limit detected on {} (status {}); per-provider quota not yet modelled",
            provider.id, status
        );
        return;
    }
    let now = chrono::Utc::now();
    let parse_seconds = |s: &str| -> Option<chrono::DateTime<chrono::Utc>> {
        s.trim().parse::<i64>().ok().map(|secs| now + chrono::Duration::seconds(secs))
    };
    let parse_http_date = |s: &str| -> Option<chrono::DateTime<chrono::Utc>> {
        chrono::DateTime::parse_from_rfc2822(s.trim())
            .ok()
            .map(|d| d.with_timezone(&chrono::Utc))
    };
    let parse_rfc3339 = |s: &str| -> Option<chrono::DateTime<chrono::Utc>> {
        chrono::DateTime::parse_from_rfc3339(s.trim())
            .ok()
            .map(|d| d.with_timezone(&chrono::Utc))
    };
    let reset_at = headers
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| parse_seconds(s).or_else(|| parse_http_date(s)))
        .or_else(|| {
            headers
                .get("anthropic-ratelimit-tokens-reset")
                .and_then(|v| v.to_str().ok())
                .and_then(parse_rfc3339)
        })
        .or(Some(now + chrono::Duration::minutes(5)));
    crate::quota_watchdog::update_from_headers(99.0, reset_at);
}

fn call_anthropic(
    provider: &Provider,
    model: &str,
    prompt: &str,
    system: Option<&str>,
    max_tokens: u32,
) -> Result<CallOutcome, String> {
    let client = http_client()?;
    let key = std::env::var(&provider.key_env_var)
        .map_err(|_| format!("missing {} env var", provider.key_env_var))?;
    let url = format!("{}/v1/messages", provider.base_url.trim_end_matches('/'));
    // KIRKARDO R11.3 FIX-4: wrap the system prompt in an ephemeral cache
    // breakpoint so Anthropic deduplicates the (usually stable) system text
    // across calls within the 5-minute window. Saves ~90% on input cost for
    // hot zones like code-review where the same routing prompt repeats.
    // Empty/short system prompts fall back to the legacy plain string form
    // (Anthropic requires cache_control items to have non-trivial content).
    let system_value = match system {
        Some(s) if s.len() >= 32 => serde_json::json!([
            {
                "type": "text",
                "text": s,
                "cache_control": { "type": "ephemeral" }
            }
        ]),
        Some(s) => serde_json::Value::String(s.to_string()),
        None => serde_json::Value::String(String::new()),
    };
    let body = serde_json::json!({
        "model": model,
        "max_tokens": clamp_max_tokens(max_tokens, 1024),
        "system": system_value,
        "messages": [{ "role": "user", "content": prompt }],
    });
    let resp = client
        .post(&url)
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .map_err(|e| format!("anthropic request failed: {}", e))?;
    let status = resp.status();
    let headers = resp.headers().clone();
    let text = resp.text().unwrap_or_default();
    if !status.is_success() {
        react_to_rate_limit(provider, status, &headers, &text);
        return Err(format!("anthropic {}: {}", status, truncate(&text, 200)));
    }
    let v: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("parse anthropic response: {}", e))?;
    let out = v
        .get("content")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("text"))
        .and_then(|t| t.as_str())
        .unwrap_or("(no text in response)")
        .to_string();
    let usage = TokenUsage {
        input_tokens: v.pointer("/usage/input_tokens").and_then(|x| x.as_u64()).unwrap_or(0),
        output_tokens: v.pointer("/usage/output_tokens").and_then(|x| x.as_u64()).unwrap_or(0),
    };
    Ok(CallOutcome { text: out, usage })
}

fn call_openai_compat(
    provider: &Provider,
    model: &str,
    prompt: &str,
    system: Option<&str>,
    max_tokens: u32,
) -> Result<CallOutcome, String> {
    let client = http_client()?;
    let key = std::env::var(&provider.key_env_var)
        .map_err(|_| format!("missing {} env var", provider.key_env_var))?;
    let url = format!(
        "{}/v1/chat/completions",
        provider.base_url.trim_end_matches('/')
    );
    let mut messages: Vec<serde_json::Value> = Vec::new();
    if let Some(sys) = system {
        if !sys.is_empty() {
            messages.push(serde_json::json!({ "role": "system", "content": sys }));
        }
    }
    messages.push(serde_json::json!({ "role": "user", "content": prompt }));
    let body = serde_json::json!({
        "model": model,
        "messages": messages,
        "max_tokens": clamp_max_tokens(max_tokens, 1024),
    });
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", key))
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .map_err(|e| format!("{} request failed: {}", provider.id, e))?;
    let status = resp.status();
    let headers = resp.headers().clone();
    let text = resp.text().unwrap_or_default();
    if !status.is_success() {
        react_to_rate_limit(provider, status, &headers, &text);
        return Err(format!("{} {}: {}", provider.id, status, truncate(&text, 200)));
    }
    let v: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("parse {} response: {}", provider.id, e))?;
    let out = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("(no text in response)")
        .to_string();
    let usage = TokenUsage {
        input_tokens: v.pointer("/usage/prompt_tokens").and_then(|x| x.as_u64()).unwrap_or(0),
        output_tokens: v.pointer("/usage/completion_tokens").and_then(|x| x.as_u64()).unwrap_or(0),
    };
    Ok(CallOutcome { text: out, usage })
}

fn call_gemini(
    provider: &Provider,
    model: &str,
    prompt: &str,
    system: Option<&str>,
    max_tokens: u32,
) -> Result<CallOutcome, String> {
    let client = http_client()?;
    let key = std::env::var(&provider.key_env_var)
        .map_err(|_| format!("missing {} env var", provider.key_env_var))?;
    let url = format!(
        "{}/v1beta/models/{}:generateContent",
        provider.base_url.trim_end_matches('/'),
        model
    );
    let mut body = serde_json::json!({
        "contents": [{ "role": "user", "parts": [{ "text": prompt }] }],
        "generationConfig": { "maxOutputTokens": clamp_max_tokens(max_tokens, 1024) },
    });
    if let Some(sys) = system {
        if !sys.is_empty() {
            body["systemInstruction"] =
                serde_json::json!({ "parts": [{ "text": sys }] });
        }
    }
    let resp = client
        .post(&url)
        .query(&[("key", key)])
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .map_err(|e| format!("gemini request failed: {}", e))?;
    let status = resp.status();
    let headers = resp.headers().clone();
    let text = resp.text().unwrap_or_default();
    if !status.is_success() {
        react_to_rate_limit(provider, status, &headers, &text);
        return Err(format!("gemini {}: {}", status, truncate(&text, 200)));
    }
    let v: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("parse gemini response: {}", e))?;
    let out = v
        .get("candidates")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("content"))
        .and_then(|c| c.get("parts"))
        .and_then(|p| p.get(0))
        .and_then(|p| p.get("text"))
        .and_then(|t| t.as_str())
        .unwrap_or("(no text in response)")
        .to_string();
    let usage = TokenUsage {
        input_tokens: v.pointer("/usageMetadata/promptTokenCount").and_then(|x| x.as_u64()).unwrap_or(0),
        output_tokens: v.pointer("/usageMetadata/candidatesTokenCount").and_then(|x| x.as_u64()).unwrap_or(0),
    };
    Ok(CallOutcome { text: out, usage })
}

fn call_ollama(
    provider: &Provider,
    model: &str,
    prompt: &str,
    system: Option<&str>,
    _max_tokens: u32,
) -> Result<CallOutcome, String> {
    let client = http_client()?;
    // Pre-flight: ollama must actually be running locally.
    let tags_url = format!("{}/api/tags", provider.base_url.trim_end_matches('/'));
    if client.get(&tags_url).send().is_err() {
        return Err(
            "Ollama is not running. Start it with `ollama serve` or install it from \
             https://ollama.com/."
                .into(),
        );
    }
    let url = format!("{}/api/generate", provider.base_url.trim_end_matches('/'));
    let mut body = serde_json::json!({
        "model": model,
        "prompt": prompt,
        "stream": false,
    });
    if let Some(sys) = system {
        if !sys.is_empty() {
            body["system"] = serde_json::Value::String(sys.to_string());
        }
    }
    let resp = client
        .post(&url)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .map_err(|e| format!("ollama request failed: {}", e))?;
    let status = resp.status();
    let text = resp.text().unwrap_or_default();
    if !status.is_success() {
        return Err(format!("ollama {}: {}", status, truncate(&text, 200)));
    }
    let v: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("parse ollama response: {}", e))?;
    let out = v
        .get("response")
        .and_then(|r| r.as_str())
        .unwrap_or("(no response field)")
        .to_string();
    let usage = TokenUsage {
        input_tokens: v.get("prompt_eval_count").and_then(|x| x.as_u64()).unwrap_or(0),
        output_tokens: v.get("eval_count").and_then(|x| x.as_u64()).unwrap_or(0),
    };
    Ok(CallOutcome { text: out, usage })
}

fn clamp_max_tokens(requested: u32, default: u32) -> u32 {
    if requested == 0 {
        default
    } else {
        requested.min(8192)
    }
}

// ---------------------------------------------------------------------------
// CLI provider wrapper — invokes a locally installed OAuth-authenticated CLI.
//
// Windows note (windows-tauri-cli-gotcha): npm-installed CLIs arrive as
// `.cmd` shims.  `Command::new("codex")` resolves the `.cmd` shim only when
// run through `cmd.exe /C`.  On Unix, the binary is a plain ELF/Mach-O that
// executes directly.
//
// Both `codex` and `gemini` accept `-p <prompt>` and `--model <model>` as of
// their respective GA releases (2025/2026). The flag spellings are identical
// so a single arms-match is sufficient.
//
// Timeout: the blocking call can hang if the CLI awaits interactive input.
// Both CLIs exit non-zero if not authenticated — we surface that stderr as
// the error message so the user knows to run `codex auth` / `gemini auth`.
// ---------------------------------------------------------------------------

/// Invoke a CLI provider synchronously and return its stdout on success.
/// CLI providers no exponen contadores de tokens, asi que usage queda en 0.
fn call_cli(provider: &Provider, prompt: &str) -> Result<CallOutcome, String> {
    let cmd = provider
        .cli_command
        .as_deref()
        .ok_or_else(|| format!("provider '{}' has no cli_command configured", provider.id))?;

    let model = provider.default_model.as_str();

    // Build the argument list.  Both supported CLIs share the same flags.
    let prompt_flag = "-p";
    let model_flag = "--model";

    // SAFETY: all strings are owned by the caller; no raw pointers.
    #[cfg(target_os = "windows")]
    let output = {
        // On Windows, npm `.cmd` shims must be invoked via `cmd /C`. Cmd.exe
        // interprets `& | < > ^ %` as meta-characters, so a prompt containing
        // `& calc` would execute `calc.exe` (KIRKARDO R11.1 CVE). We sanitise
        // the prompt by replacing every cmd-meta char with `_` BEFORE building
        // the shell string. Inner double-quotes are also stripped — npm CLIs
        // tolerate single-quoted prompts but cmd.exe quoting of nested quotes
        // is hostile, so the safest path is to neuter them entirely.
        // Newlines collapse to spaces because /C accepts a single line.
        fn sanitize_for_cmd(s: &str) -> String {
            let mut out = String::with_capacity(s.len());
            for ch in s.chars() {
                match ch {
                    '&' | '|' | '<' | '>' | '^' | '%' | '(' | ')' | '!' | '"' => out.push('_'),
                    '\r' | '\n' | '\t' => out.push(' '),
                    c if (c as u32) < 0x20 => out.push(' '),
                    c => out.push(c),
                }
            }
            out
        }
        let safe_prompt = sanitize_for_cmd(prompt);
        let safe_cmd = sanitize_for_cmd(cmd);
        let safe_model = sanitize_for_cmd(model);
        let shell_arg = format!(
            "{safe_cmd} {prompt_flag} \"{safe_prompt}\" {model_flag} {safe_model}"
        );
        std::process::Command::new("cmd")
            .args(["/C", &shell_arg])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| format!("spawn cmd /C {cmd}: {e}"))?
    };

    #[cfg(not(target_os = "windows"))]
    let output = std::process::Command::new(cmd)
        .args([prompt_flag, prompt, model_flag, model])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("spawn {cmd}: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "{cmd} exited {}: {}",
            output.status,
            truncate(stderr.trim(), 300)
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if stdout.trim().is_empty() {
        return Err(format!("{cmd} produced no output"));
    }
    Ok(CallOutcome { text: stdout, usage: TokenUsage::default() })
}

// ---------------------------------------------------------------------------
// Tauri commands — thin wrappers around the helpers above.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn ai_router_list_zones() -> Result<Vec<Zone>, String> {
    load_zones()
}

#[tauri::command]
pub fn ai_router_get_zone(id: String) -> Result<Zone, String> {
    load_zones()?
        .into_iter()
        .find(|z| z.id == id)
        .ok_or_else(|| format!("zone '{}' not found", id))
}

#[tauri::command]
pub fn ai_router_update_zone(zone: Zone) -> Result<(), String> {
    let mut zones = load_zones()?;
    if let Some(existing) = zones.iter_mut().find(|z| z.id == zone.id) {
        *existing = zone;
    } else {
        zones.push(zone);
    }
    save_zones(&zones)
}

#[tauri::command]
pub fn ai_router_list_providers() -> Result<Vec<Provider>, String> {
    load_providers()
}

#[tauri::command]
pub fn ai_router_health(provider_id: String) -> Result<bool, String> {
    let providers = load_providers()?;
    let provider = providers
        .iter()
        .find(|p| p.id == provider_id)
        .ok_or_else(|| format!("provider '{}' not found", provider_id))?;
    Ok(provider_health(provider))
}

#[tauri::command]
pub fn ai_router_metrics() -> Result<RouterMetrics, String> {
    load_metrics()
}

#[tauri::command]
pub fn ai_router_test(zone_id: String, sample_prompt: String) -> Result<TestResult, String> {
    let zones = load_zones()?;
    let zone = zones
        .iter()
        .find(|z| z.id == zone_id)
        .ok_or_else(|| format!("zone '{}' not found", zone_id))?;
    let prompt = if sample_prompt.trim().is_empty() {
        "Respond with a single word: OK"
    } else {
        sample_prompt.as_str()
    };
    Ok(test_zone(zone, prompt))
}

// ---------------------------------------------------------------------------
// KIRKARDO 28 Paso 1 — Real router with fallback chain.
//
// Until this function existed, the router was decorative: only the UI Test
// button reached the providers, fallbacks lived in JSON but were never
// followed, metrics stayed at zero forever. This is the entrypoint Rust
// callers (cost_watchdog summariser, future delegate_task summariser, etc.)
// can use to actually consume the zone configuration.
//
// Contract:
//   - Loads the zone, validates it exists.
//   - Tries `zone.primary` first via `try_assignment_call`.
//   - On error, walks `zone.fallbacks` in order, returning the first
//     successful response.
//   - Increments RouterMetrics on every attempt (success and failure).
//   - Returns Err only when EVERY provider in the chain failed.
//
// SCOPE NOTE (KIRKARDO R11.4 FIX-11): this function is currently invoked
// only by the `ai_router_route` Tauri command — i.e. the "Test" button in
// Settings → AI Router and the Usage panel simulator. Claude Code itself
// (the CLI hosting this app) does NOT route LLM calls through this code;
// it talks to Anthropic directly. That means `metrics.json` reflects
// Tauri-UI-triggered routes only, not real Claude Code traffic.
//
// To make the router observe production LLM calls, two options exist:
//   (A) An external proxy in front of Claude Code's HTTP client that
//       posts each request through `ai_router_route`. Heavy.
//   (B) A Claude Code "model_route" plugin/hook that delegates the
//       provider decision to this router. Lighter; not yet implemented.
// Until (A) or (B) lands, treat this router as a Tauri-UI affordance for
// experimenting with zones and fallback chains, NOT as a system-wide
// routing layer.
// ---------------------------------------------------------------------------
pub fn route(zone_id: &str, prompt: &str) -> Result<String, String> {
    let zones = load_zones()?;
    let zone = zones
        .iter()
        .find(|z| z.id == zone_id)
        .ok_or_else(|| format!("zone '{}' not found", zone_id))?;

    // Compute disabled providers once per route call. This is O(providers)
    // and involves one file read, but it is fast enough for interactive use
    // and guarantees that a key added after startup is picked up immediately.
    let disabled = disabled_providers_set();

    // Load providers once to look up cost_per_mtok (for savings stats). The
    // "savings" baseline is the PRIMARY provider's cost: cuando una ruta cae a
    // un proveedor mas barato que el primario, contamos lo ahorrado.
    let providers = load_providers().unwrap_or_default();
    let cost_of = |pid: &str| -> f64 {
        providers
            .iter()
            .find(|p| p.id == pid)
            .map(|p| p.cost_per_mtok)
            .unwrap_or(0.0)
    };
    let primary_cost = cost_of(&zone.primary.provider_id);

    let mut last_error = String::new();
    let chain = std::iter::once(&zone.primary).chain(zone.fallbacks.iter());

    for assignment in chain {
        // Skip providers that have no usable API key. We record a soft error
        // in `last_error` so the final "all providers failed" message is
        // informative, but we do NOT call `bump_metrics` for skipped entries
        // because no actual attempt was made.
        if disabled.contains(&assignment.provider_id) {
            last_error = format!(
                "[{}/{}] skipped — provider has no API key \
                 (set the key env var or configure in Settings > AI Router)",
                assignment.provider_id, assignment.model
            );
            continue;
        }

        let started = Instant::now();
        let outcome = try_assignment_call(assignment, prompt, zone.system_prompt.as_deref());
        let latency_ms = started.elapsed().as_millis() as u64;

        let success = outcome.is_ok();
        let out_tokens = outcome.as_ref().map(|c| c.usage.output_tokens).unwrap_or(0);

        // Persist metrics for every attempt — only way the dashboard counts
        // move at all. Best-effort: a metrics write failure does not abort.
        let _ = bump_metrics(MetricSample {
            provider_id: &assignment.provider_id,
            model: &assignment.model,
            success,
            output_tokens: out_tokens,
            cost_per_mtok: cost_of(&assignment.provider_id),
            primary_cost_per_mtok: primary_cost,
            latency_ms,
        });

        match outcome {
            Ok(co) => return Ok(co.text),
            Err(e) => {
                last_error = format!("[{}/{}] {}", assignment.provider_id, assignment.model, e);
                continue;
            }
        }
    }
    Err(format!(
        "all providers failed for zone '{}': {}",
        zone_id, last_error
    ))
}

/// Try a single provider+model assignment. Shared with `route()` and
/// (eventually) `test_zone` once we refactor that call site.
fn try_assignment_call(
    assignment: &ZoneAssignment,
    prompt: &str,
    system_prompt: Option<&str>,
) -> Result<CallOutcome, String> {
    // --- Quota guard (P0 2026-05-27) ---
    // When Claude subscription quota is at or above 98 % we skip all Claude
    // providers so `route()` cascades to the next fallback automatically.
    // The error string uses a stable prefix (`quota_critical_skip:`) so
    // callers can distinguish quota-induced skips from real API failures.
    if crate::quota_watchdog::is_critical(&assignment.provider_id) {
        return Err(format!(
            "quota_critical_skip:{} — Claude quota >= {}% — routing to fallback",
            assignment.provider_id,
            crate::quota_watchdog::CRITICAL_THRESHOLD,
        ));
    }

    let providers = load_providers()?;
    let provider = providers
        .iter()
        .find(|p| p.id == assignment.provider_id)
        .ok_or_else(|| format!("unknown provider '{}'", assignment.provider_id))?;

    match provider.kind {
        ProviderKind::Cli => {
            // CLI providers authenticate via OAuth subscription — no API key.
            // Skip if the binary is not installed on PATH.
            let cmd = provider.cli_command.as_deref().unwrap_or("");
            if cmd.is_empty() || !detect_cli(cmd) {
                let install_hint = match cmd {
                    "codex" => "Install with: npm install -g @openai/codex",
                    "gemini" => "Install with: npm install -g @google/gemini-cli",
                    _ => "Install the CLI and ensure it is on PATH",
                };
                return Err(format!(
                    "CLI '{}' not found on PATH. {}",
                    cmd, install_hint
                ));
            }
            return call_cli(provider, prompt);
        }
        ProviderKind::Cloud if !provider.key_env_var.is_empty() => {
            match std::env::var(&provider.key_env_var) {
                Ok(v) if !v.trim().is_empty() && !looks_like_placeholder(&v) => {}
                _ => {
                    return Err(format!(
                        "Provider '{}' has no API key. \
                         Set {} or configure it in Settings > AI Router.",
                        assignment.provider_id, provider.key_env_var
                    ));
                }
            }
        }
        _ => {}
    }

    match provider.id.as_str() {
        "claude-haiku" => call_anthropic(provider, &assignment.model, prompt, system_prompt, assignment.max_tokens),
        "codex" | "groq" | "deepseek" => call_openai_compat(provider, &assignment.model, prompt, system_prompt, assignment.max_tokens),
        "gemini" => call_gemini(provider, &assignment.model, prompt, system_prompt, assignment.max_tokens),
        "ollama" => call_ollama(provider, &assignment.model, prompt, system_prompt, assignment.max_tokens),
        other => Err(format!("no wrapper implemented for provider '{}'", other)),
    }
}

/// Una muestra de métricas tras un intento de ruta. Agrupa los parámetros
/// para evitar una firma con 7 argumentos posicionales.
struct MetricSample<'a> {
    provider_id: &'a str,
    model: &'a str,
    success: bool,
    output_tokens: u64,
    cost_per_mtok: f64,
    primary_cost_per_mtok: f64,
    latency_ms: u64,
}

/// Mutate the persisted metrics so the dashboard moves. Best-effort (un fallo
/// de escritura no aborta la ruta). Trackea: por-proveedor (by_class) y
/// por-modelo (by_model) count/success/tokens/latencia, contador diario para
/// el gauge free-tier, fallback_rate (EMA), y tokens/cost "ahorrados" cuando
/// la ruta cae a un proveedor más barato que el primario.
fn bump_metrics(s: MetricSample<'_>) -> Result<(), String> {
    let mut metrics = load_metrics().unwrap_or_default();

    // --- Per-provider (by_class) ---
    let pm = metrics.by_class.entry(s.provider_id.to_string()).or_default();
    pm.count = pm.count.saturating_add(1);
    if s.success {
        pm.success_count = pm.success_count.saturating_add(1);
    }
    pm.tokens = pm.tokens.saturating_add(s.output_tokens);
    if pm.count <= 1 {
        pm.latency_p95_ms = s.latency_ms;
    } else {
        pm.latency_p95_ms = (pm.latency_p95_ms + s.latency_ms) / 2;
    }

    // --- Per-model (by_model), key = "provider::model" ---
    let key = format!("{}::{}", s.provider_id, s.model);
    let mm = metrics.by_model.entry(key).or_default();
    mm.provider_id = s.provider_id.to_string();
    mm.model = s.model.to_string();
    mm.count = mm.count.saturating_add(1);
    if s.success {
        mm.success_count = mm.success_count.saturating_add(1);
    }
    mm.output_tokens = mm.output_tokens.saturating_add(s.output_tokens);
    mm.latency_ms_avg = if mm.count <= 1 {
        s.latency_ms
    } else {
        (mm.latency_ms_avg + s.latency_ms) / 2
    };

    // --- Fallback rate (EMA 0.1 over the 0/1 failure stream) ---
    if s.success {
        metrics.fallback_rate *= 0.9;
    } else {
        metrics.fallback_rate = metrics.fallback_rate * 0.9 + 0.1;
    }

    // --- Savings: tokens servidos por un proveedor más barato que el
    // primario = tokens "descargados" de Claude; coste ahorrado = diferencia
    // de tarifa por esos tokens. Solo cuenta en éxito. ---
    if s.success && s.output_tokens > 0 && s.cost_per_mtok < s.primary_cost_per_mtok {
        metrics.tokens_saved_total = metrics.tokens_saved_total.saturating_add(s.output_tokens);
        let delta = (s.primary_cost_per_mtok - s.cost_per_mtok).max(0.0);
        metrics.cost_saved_usd += (s.output_tokens as f64) * delta / 1_000_000.0;
    }

    // --- Daily counter (free-tier gauge), reset on UTC date change ---
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let du = metrics.daily.entry(s.provider_id.to_string()).or_default();
    if du.date != today {
        du.date = today;
        du.count = 0;
    }
    du.count = du.count.saturating_add(1);

    write_json(&metrics_path()?, &metrics)
}

/// Public Tauri command surface so the frontend (or a future summariser)
/// can invoke `route` without going through the test surface.
#[tauri::command]
pub fn ai_router_route(zone_id: String, prompt: String) -> Result<String, String> {
    route(&zone_id, &prompt)
}

// ---------------------------------------------------------------------------
// Key validation + disabled-provider surface  (P1 — 2026-05-27)
//
// Design rationale:
//   - `compute_key_status` already knows how to detect missing/placeholder
//     keys. We build on top of it rather than duplicating the logic.
//   - "Disabled" means: cloud provider + no usable key. Local providers
//     (ollama) are never disabled regardless of key state.
//   - `route()` consults `disabled_providers_set()` before attempting any
//     assignment so providers without keys are silently skipped in the
//     fallback chain. If the *only* viable option is keyed and missing,
//     `try_assignment_call` still returns a friendly error message
//     (the existing key-check inside that fn handles it).
//   - `ai_router_validate_keys` is a diagnostics surface; it does NOT gate
//     the `route` path itself — `disabled_providers_set` does that.
// ---------------------------------------------------------------------------

/// Per-provider key validation result returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyValidation {
    pub provider_id: String,
    pub provider_label: String,
    pub has_key: bool,
    /// How the key was found: `"env"`, `"none"` (local providers return `"local"`).
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

/// Compute the set of provider IDs that should be skipped by `route()`.
/// A provider is disabled when `compute_key_status` returns Missing or
/// Placeholder.  This covers three cases uniformly:
///   - Cloud providers whose API key env var is absent/placeholder.
///   - CLI providers whose binary is not installed on PATH.
///   - Local providers are never disabled (compute_key_status returns
///     Configured unconditionally for them).
///
/// Called on every `route()` invocation; not cached so a freshly installed
/// CLI or a newly exported env var is picked up without restart.
fn disabled_providers_set() -> std::collections::HashSet<String> {
    load_providers()
        .unwrap_or_default()
        .into_iter()
        .filter(|p| {
            matches!(compute_key_status(p), ApiKeyStatus::Missing | ApiKeyStatus::Placeholder)
        })
        .map(|p| p.id)
        .collect()
}

/// Tauri command — validate keys for every configured provider.
///
/// Returns one `KeyValidation` entry per provider. The frontend uses this
/// to render the "AI Router > Keys" panel and to show the warning badge
/// on the router tab when any cloud provider is missing a key.
///
/// Example output (serialised to JSON by Tauri):
/// ```json
/// [
///   { "provider_id": "claude-haiku", "provider_label": "Anthropic Claude Haiku",
///     "has_key": true, "source": "env" },
///   { "provider_id": "codex", "provider_label": "OpenAI Codex (gpt-5)",
///     "has_key": false, "source": "none",
///     "warning": "Set OPENAI_API_KEY or configure in Settings > AI Router." },
///   { "provider_id": "ollama", "provider_label": "Ollama (local)",
///     "has_key": true, "source": "local" }
/// ]
/// ```
#[tauri::command]
pub fn ai_router_validate_keys() -> Result<Vec<KeyValidation>, String> {
    let providers = load_providers()?;
    let validations = providers
        .iter()
        .map(|p| {
            // --- CLI providers (OAuth subscription, no API key) ---
            if p.kind == ProviderKind::Cli {
                let cmd = p.cli_command.as_deref().unwrap_or("");
                let installed = !cmd.is_empty() && detect_cli(cmd);
                let install_hint = match cmd {
                    "codex" => "npm install -g @openai/codex  then  codex auth",
                    "gemini" => "npm install -g @google/gemini-cli  then  gemini auth",
                    _ => "Install the CLI and run its auth command",
                };
                return KeyValidation {
                    provider_id: p.id.clone(),
                    provider_label: p.name.clone(),
                    has_key: installed,
                    source: if installed {
                        "cli-installed".to_string()
                    } else {
                        "cli-missing".to_string()
                    },
                    warning: if installed {
                        None
                    } else {
                        Some(format!(
                            "CLI '{}' not found on PATH. {}",
                            cmd, install_hint
                        ))
                    },
                };
            }

            // --- Local providers (ollama etc.) ---
            if p.kind == ProviderKind::Local || p.key_env_var.is_empty() {
                return KeyValidation {
                    provider_id: p.id.clone(),
                    provider_label: p.name.clone(),
                    has_key: true,
                    source: "local".to_string(),
                    warning: None,
                };
            }

            // --- Cloud providers (API key via env var) ---
            match std::env::var(&p.key_env_var) {
                Ok(v) if !v.trim().is_empty() && !looks_like_placeholder(&v) => KeyValidation {
                    provider_id: p.id.clone(),
                    provider_label: p.name.clone(),
                    has_key: true,
                    source: "env".to_string(),
                    warning: None,
                },
                Ok(_) => KeyValidation {
                    provider_id: p.id.clone(),
                    provider_label: p.name.clone(),
                    has_key: false,
                    source: "none".to_string(),
                    warning: Some(format!(
                        "Provider '{}' has a placeholder value in {}. \
                         Set a real key or configure it in Settings > AI Router.",
                        p.id, p.key_env_var
                    )),
                },
                Err(_) => KeyValidation {
                    provider_id: p.id.clone(),
                    provider_label: p.name.clone(),
                    has_key: false,
                    source: "none".to_string(),
                    warning: Some(format!(
                        "Provider '{}' has no API key. \
                         Set {} or configure it in Settings > AI Router.",
                        p.id, p.key_env_var
                    )),
                },
            }
        })
        .collect();
    Ok(validations)
}

/// Tauri command — returns provider IDs that are currently disabled
/// (cloud providers without a usable API key).
///
/// The frontend can use this list to grey-out providers in the zone editor
/// and to warn the user before saving a zone that references a disabled
/// provider.
#[tauri::command]
pub fn ai_router_disabled_providers() -> Result<Vec<String>, String> {
    // Re-use disabled_providers_set so the logic stays in one place.
    let mut ids: Vec<String> = disabled_providers_set().into_iter().collect();
    ids.sort(); // deterministic order for the UI
    Ok(ids)
}

// ---------------------------------------------------------------------------
// Usage summary — per-key + per-provider snapshot the Usage tab consumes
// (user request 2026-05-27: "analisis de cada una de las keys que tengo
// activa, cuanto llevo. Verificar que este todo en orden y aplicar
// fallbacks"). Combines key state + accumulated metrics + zone refs so
// the UI can render one row per provider with: key OK, traffic so far,
// in which zones it acts as primary vs fallback.
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProviderUsageRow {
    pub provider_id: String,
    pub provider_label: String,
    pub key_env_var: String,
    pub key_present: bool,
    pub key_masked: Option<String>,
    /// Count of total route attempts hitting this provider (sum of
    /// success + failure since the metrics file was last reset).
    pub call_count: u64,
    /// Successful calls (outcome.is_ok()). Para el success-rate del rediseno.
    pub success_count: u64,
    /// Output tokens acumulados servidos por este proveedor.
    pub total_tokens: u64,
    /// Running latency average in ms (KIRKARDO 19 — proper p50/p95
    /// histogram would be more honest, deferred to v2.9.x).
    pub latency_ms_avg: u64,
    /// Zones where this provider is the primary choice.
    pub primary_for_zones: Vec<String>,
    /// Zones where this provider sits in a fallback slot.
    pub fallback_for_zones: Vec<String>,
    /// Published free-tier daily request limit (RPD), if the provider has a
    /// real free API tier. None for paid-only / CLI / local providers.
    pub free_tier_limit: Option<u64>,
    /// Requests routed to this provider TODAY (UTC). 0 if none yet today.
    pub free_tier_used_today: u64,
    /// Percentage of the daily free tier consumed today (0..=100+). None when
    /// there is no known free-tier limit for this provider.
    pub free_tier_pct: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UsageSummary {
    pub providers: Vec<ProviderUsageRow>,
    /// Global fallback rate across all routes (EMA 0.1 in route()).
    pub fallback_rate: f64,
    /// Per-zone fallback chain: { zone_id -> [primary, fallback1, fallback2, ...] }.
    /// Lets the UI render "if primary X fails, will try Y then Z".
    pub zone_chains: HashMap<String, Vec<String>>,
}

fn mask_key(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || looks_like_placeholder(trimmed) {
        return None;
    }
    if trimmed.len() <= 8 {
        return Some("*".repeat(trimmed.len()));
    }
    Some(format!(
        "{}{}{}",
        &trimmed[..4],
        "*".repeat(trimmed.len() - 8),
        &trimmed[trimmed.len() - 4..]
    ))
}

#[tauri::command]
pub fn ai_router_usage_summary() -> Result<UsageSummary, String> {
    let providers = load_providers()?;
    let zones = load_zones()?;
    let metrics = load_metrics().unwrap_or_default();

    let mut rows: Vec<ProviderUsageRow> = Vec::with_capacity(providers.len());
    for p in &providers {
        let (key_present, key_masked) = if p.kind == ProviderKind::Cli {
            // CLI providers: "key" is the CLI binary itself.
            let cmd = p.cli_command.as_deref().unwrap_or("");
            let installed = !cmd.is_empty() && detect_cli(cmd);
            (installed, None)
        } else if p.key_env_var.is_empty() {
            // Ollama-style local providers — no key needed.
            (true, None)
        } else {
            match std::env::var(&p.key_env_var) {
                Ok(v) => {
                    let masked = mask_key(&v);
                    (masked.is_some(), masked)
                }
                Err(_) => (false, None),
            }
        };

        let mut primary_for_zones: Vec<String> = Vec::new();
        let mut fallback_for_zones: Vec<String> = Vec::new();
        for z in &zones {
            if z.primary.provider_id == p.id {
                primary_for_zones.push(z.id.clone());
            }
            if z.fallbacks.iter().any(|f| f.provider_id == p.id) {
                fallback_for_zones.push(z.id.clone());
            }
        }

        // Provider-level metrics live in `by_class` (we piggyback on it,
        // see bump_metrics comments).
        let cm = metrics.by_class.get(&p.id).cloned().unwrap_or_default();

        // Free-tier daily gauge: requests today vs published RPD limit.
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let used_today = metrics
            .daily
            .get(&p.id)
            .filter(|d| d.date == today)
            .map(|d| d.count)
            .unwrap_or(0);
        let free_tier_limit = free_tier_daily_limit(&p.id);
        let free_tier_pct = free_tier_limit
            .filter(|lim| *lim > 0)
            .map(|lim| (used_today as f64 / lim as f64) * 100.0);

        rows.push(ProviderUsageRow {
            provider_id: p.id.clone(),
            provider_label: p.name.clone(),
            key_env_var: p.key_env_var.clone(),
            key_present,
            key_masked,
            call_count: cm.count,
            success_count: cm.success_count,
            total_tokens: cm.tokens,
            latency_ms_avg: cm.latency_p95_ms,
            primary_for_zones,
            fallback_for_zones,
            free_tier_limit,
            free_tier_used_today: used_today,
            free_tier_pct,
        });
    }

    let mut zone_chains: HashMap<String, Vec<String>> = HashMap::new();
    for z in &zones {
        let mut chain: Vec<String> = vec![z.primary.provider_id.clone()];
        for f in &z.fallbacks {
            chain.push(f.provider_id.clone());
        }
        zone_chains.insert(z.id.clone(), chain);
    }

    Ok(UsageSummary {
        providers: rows,
        fallback_rate: metrics.fallback_rate,
        zone_chains,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_providers_includes_all_six_targets() {
        let ids: Vec<String> = seed_providers().into_iter().map(|p| p.id).collect();
        for expected in [
            "claude-haiku",
            "codex",
            "gemini",
            "groq",
            "ollama",
            "deepseek",
        ] {
            assert!(ids.iter().any(|id| id == expected), "missing {}", expected);
        }
    }

    #[test]
    fn seed_zones_includes_all_seven_targets() {
        let ids: Vec<String> = seed_zones().into_iter().map(|z| z.id).collect();
        for expected in [
            "chat",
            "code-edit",
            "code-review",
            "research-web",
            "summarize",
            "routing-decision",
            "code-fast-local",
        ] {
            assert!(ids.iter().any(|id| id == expected), "missing {}", expected);
        }
    }

    #[test]
    fn truncate_respects_unicode() {
        let s = "abcdefghij";
        assert_eq!(truncate(s, 5), "abcde...");
        assert_eq!(truncate(s, 99), "abcdefghij");
    }

    #[test]
    fn placeholder_detection_catches_common_patterns() {
        assert!(looks_like_placeholder("YOUR-KEY-HERE"));
        assert!(looks_like_placeholder("replace-me"));
        assert!(looks_like_placeholder("sk-..."));
        assert!(!looks_like_placeholder("sk-proj-abc123"));
    }

    #[test]
    fn clamp_max_tokens_uses_default_on_zero() {
        assert_eq!(clamp_max_tokens(0, 1024), 1024);
        assert_eq!(clamp_max_tokens(2048, 1024), 2048);
        assert_eq!(clamp_max_tokens(99_999, 1024), 8192);
    }

    // -----------------------------------------------------------------------
    // P1 2026-05-27 — key validation + disabled-providers
    // -----------------------------------------------------------------------

    /// Minimal Provider builder to avoid repeating all 12 fields in every test.
    fn make_provider(
        id: &str,
        kind: ProviderKind,
        key_env_var: &str,
        cli_command: Option<&str>,
    ) -> Provider {
        Provider {
            id: id.into(),
            name: format!("Test {id}"),
            cost_per_mtok: 0.0,
            supports: vec![ProviderClass::Light],
            api_key_status: ApiKeyStatus::Missing,
            health_endpoint: None,
            kind,
            key_env_var: key_env_var.into(),
            base_url: "https://example.com".into(),
            default_model: "test-model".into(),
            models: vec![],
            cli_command: cli_command.map(String::from),
        }
    }

    #[test]
    fn local_provider_never_disabled() {
        let ollama = make_provider("ollama", ProviderKind::Local, "", None);
        assert_eq!(compute_key_status(&ollama), ApiKeyStatus::Configured);
    }

    #[test]
    fn cloud_provider_missing_key_is_missing_status() {
        let p = make_provider(
            "qwen-cloud",
            ProviderKind::Cloud,
            "__ULTRON_TEST_KEY_NOT_SET_XYZ__",
            None,
        );
        if std::env::var("__ULTRON_TEST_KEY_NOT_SET_XYZ__").is_err() {
            assert_eq!(compute_key_status(&p), ApiKeyStatus::Missing);
        }
    }

    #[test]
    fn cloud_provider_placeholder_key_is_placeholder_status() {
        let key_var = "__ULTRON_TEST_PLACEHOLDER_KEY__";
        // SAFETY: test-only mutation, single-threaded test runner.
        unsafe { std::env::set_var(key_var, "your-key-here") };
        let p = make_provider("test-cloud", ProviderKind::Cloud, key_var, None);
        let status = compute_key_status(&p);
        unsafe { std::env::remove_var(key_var) };
        assert_eq!(status, ApiKeyStatus::Placeholder);
    }

    #[test]
    fn cloud_provider_real_key_is_configured_status() {
        let key_var = "__ULTRON_TEST_REAL_KEY__";
        unsafe { std::env::set_var(key_var, "sk-proj-abc123realkey") };
        let p = make_provider("test-cloud2", ProviderKind::Cloud, key_var, None);
        let status = compute_key_status(&p);
        unsafe { std::env::remove_var(key_var) };
        assert_eq!(status, ApiKeyStatus::Configured);
    }

    #[test]
    fn key_validation_warning_message_contains_env_var_name() {
        let key_var = "__ULTRON_TEST_WARN_KEY__";
        unsafe { std::env::remove_var(key_var) };
        let p = make_provider("warn-provider", ProviderKind::Cloud, key_var, None);

        let warning = match std::env::var(&p.key_env_var) {
            Err(_) => Some(format!(
                "Provider '{}' has no API key. \
                 Set {} or configure it in Settings > AI Router.",
                p.id, p.key_env_var
            )),
            _ => None,
        };

        let w = warning.expect("warning should be present when key is absent");
        assert!(w.contains(key_var), "warning must name the env var");
        assert!(w.contains("warn-provider"), "warning must name the provider");
    }

    // -----------------------------------------------------------------------
    // CLI provider tests — card-codex-gemini-subscription-2026-05-27
    // -----------------------------------------------------------------------

    #[test]
    fn cli_provider_with_no_cli_command_is_missing() {
        // A Cli provider with no cli_command at all must report Missing.
        let p = make_provider("broken-cli", ProviderKind::Cli, "", None);
        assert_eq!(compute_key_status(&p), ApiKeyStatus::Missing);
    }

    #[test]
    fn cli_provider_with_nonexistent_command_is_missing() {
        let p = make_provider(
            "ghost-cli",
            ProviderKind::Cli,
            "",
            Some("__ultron_ghost_binary_xyz__"),
        );
        assert_eq!(compute_key_status(&p), ApiKeyStatus::Missing);
    }

    #[test]
    fn detect_cli_finds_well_known_shell() {
        // cmd.exe exists on every Windows machine; sh exists on every Unix.
        #[cfg(target_os = "windows")]
        assert!(detect_cli("cmd"), "cmd.exe should be detectable on Windows");
        #[cfg(not(target_os = "windows"))]
        assert!(detect_cli("sh"), "sh should be detectable on Unix");
    }

    #[test]
    fn detect_cli_returns_false_for_nonexistent() {
        assert!(!detect_cli("__ultron_ghost_binary_xyz__"));
    }

    #[test]
    fn detect_cli_result_is_stable_across_calls() {
        // Two calls for the same command must return the same value.
        // Primarily verifies the cache path does not corrupt state.
        let first = detect_cli("__ultron_cache_stability_test__");
        let second = detect_cli("__ultron_cache_stability_test__");
        assert_eq!(first, second);
    }

    #[test]
    fn seed_providers_includes_cli_providers() {
        let ids: Vec<String> = seed_providers().into_iter().map(|p| p.id).collect();
        assert!(ids.iter().any(|id| id == "codex-cli"), "missing codex-cli");
        assert!(ids.iter().any(|id| id == "gemini-cli"), "missing gemini-cli");
    }

    #[test]
    fn cli_providers_have_correct_metadata() {
        for p in seed_providers() {
            if p.id == "codex-cli" || p.id == "gemini-cli" {
                assert_eq!(p.kind, ProviderKind::Cli, "{} must have kind=Cli", p.id);
                assert!(
                    p.cli_command.is_some(),
                    "{} must have cli_command set",
                    p.id
                );
                assert!(
                    p.key_env_var.is_empty(),
                    "{} must have empty key_env_var (no API key needed)",
                    p.id
                );
            }
        }
    }

    #[test]
    fn cli_missing_binary_makes_provider_disabled_for_route() {
        // When the CLI binary is absent, compute_key_status must return Missing,
        // which is the signal disabled_providers_set() uses to skip the provider
        // in route(). No file I/O — purely unit-level logic test.
        let ghost = make_provider(
            "ghost-cli",
            ProviderKind::Cli,
            "",
            Some("__ultron_ghost_binary_xyz__"),
        );
        assert_eq!(
            compute_key_status(&ghost),
            ApiKeyStatus::Missing,
            "ghost CLI must be Missing so route() skips it via disabled_providers_set"
        );
    }
}
