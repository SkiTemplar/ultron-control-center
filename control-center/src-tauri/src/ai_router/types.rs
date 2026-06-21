// Domain types for the AI Router.
//
// Contains all the public/crate-visible structs, enums, and constants that
// the other submódulos share.  Storage-path helpers also live here because
// they are pure functions over the types and `ultron_root`.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::ultron_root;

// ---------------------------------------------------------------------------
// Retry / backoff — FailReason
// ---------------------------------------------------------------------------

/// Reason a provider call failed — used in metrics and retry decisions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailReason {
    /// HTTP 429 Too Many Requests — rate-limited.
    RateLimit,
    /// HTTP 529 or upstream overload signal.
    Overloaded,
    /// Network or connect timeout elapsed.
    Timeout,
    /// Any other non-transient error.
    Error,
}

impl FailReason {
    /// Returns true when it is safe to retry this kind of failure.
    pub fn is_transient(self) -> bool {
        matches!(
            self,
            FailReason::RateLimit | FailReason::Overloaded | FailReason::Timeout
        )
    }

    /// Classify an HTTP status code returned by a cloud provider.
    pub fn from_http_status(status: u16) -> Self {
        match status {
            429 => FailReason::RateLimit,
            529 => FailReason::Overloaded,
            _ => FailReason::Error,
        }
    }
}

impl std::fmt::Display for FailReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            FailReason::RateLimit => "rate_limit",
            FailReason::Overloaded => "overloaded",
            FailReason::Timeout => "timeout",
            FailReason::Error => "error",
        };
        f.write_str(s)
    }
}

// ---------------------------------------------------------------------------
// CallOutcome + TokenUsage
// ---------------------------------------------------------------------------

/// Token usage extraido de la respuesta de un proveedor.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

/// Resultado de una llamada a un proveedor: texto + uso de tokens.
#[derive(Debug, Clone, Default)]
pub struct CallOutcome {
    pub text: String,
    pub usage: TokenUsage,
}

// ---------------------------------------------------------------------------
// Provider domain types
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

// ---------------------------------------------------------------------------
// Metrics types
// ---------------------------------------------------------------------------

/// Health gate thresholds (F1 2026-06-10). After N consecutive terminal
/// failures a provider enters a cooldown window during which route() skips it
/// (soft-skip — see `ClassMetrics::cooldown_until`).
pub(crate) const HEALTH_GATE_CONSECUTIVE_FAILURES: u64 = 3;
pub(crate) const HEALTH_GATE_COOLDOWN_MINUTES: i64 = 15;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ClassMetrics {
    pub count: u64,
    /// Output tokens accumulated across all calls to this provider.
    pub tokens: u64,
    /// Running latency average in ms (EMA).
    #[serde(alias = "latency_p95_ms", default)]
    pub latency_ms_avg: u64,
    /// Calls that succeeded (outcome.is_ok()).
    #[serde(default)]
    pub success_count: u64,
    /// ISO date (YYYY-MM-DD, UTC) these per-class counters belong to.
    #[serde(default)]
    pub date: String,
    /// Last terminal failure message (truncated, redacted upstream).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    /// RFC3339 timestamp of the last terminal failure.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error_at: Option<String>,
    /// RFC3339 timestamp of the last success.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_success_at: Option<String>,
    /// Terminal failures in a row (reset on success). Drives the health gate.
    #[serde(default)]
    pub consecutive_failures: u64,
    /// Health gate: route() soft-skips this provider until this RFC3339
    /// instant once `consecutive_failures` reaches the threshold.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cooldown_until: Option<String>,
}

/// Fixed-bucket latency histogram for p50/p95 tracking.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LatencyHistogram {
    /// Upper-bound (ms) of each bucket.  Exactly 8 entries; the last is u64::MAX.
    #[serde(default = "LatencyHistogram::default_bounds")]
    pub bounds: Vec<u64>,
    /// Count of observations per bucket (parallel array to `bounds`).
    #[serde(default)]
    pub counts: Vec<u64>,
    /// Total number of observations recorded.
    #[serde(default)]
    pub total: u64,
    /// Sum of all latency_ms values (used to derive the running average).
    #[serde(default)]
    pub sum_ms: u64,
}

impl Default for LatencyHistogram {
    fn default() -> Self {
        let bounds = Self::default_bounds();
        let n = bounds.len();
        Self {
            bounds,
            counts: vec![0; n],
            total: 0,
            sum_ms: 0,
        }
    }
}

impl LatencyHistogram {
    /// Canonical 8-bucket boundaries (ms).
    pub fn default_bounds() -> Vec<u64> {
        vec![50, 100, 250, 500, 1_000, 2_500, 5_000, u64::MAX]
    }

    /// Record one latency observation.
    pub fn record(&mut self, latency_ms: u64) {
        self.total = self.total.saturating_add(1);
        self.sum_ms = self.sum_ms.saturating_add(latency_ms);
        if self.counts.len() < self.bounds.len() {
            eprintln!(
                "[ULTRON ai_router] LatencyHistogram::record — corrupt state: \
                 counts.len()={} < bounds.len()={}, auto-healing by extending counts",
                self.counts.len(),
                self.bounds.len()
            );
            self.counts.resize(self.bounds.len(), 0);
        }
        for (i, &bound) in self.bounds.iter().enumerate() {
            if latency_ms <= bound {
                self.counts[i] = self.counts[i].saturating_add(1);
                return;
            }
        }
        // Should be unreachable because the last bound is u64::MAX.
        if let Some(last) = self.counts.last_mut() {
            *last = last.saturating_add(1);
        }
    }

    /// Running average in ms, or 0 when no observations have been recorded.
    pub fn avg_ms(&self) -> u64 {
        self.sum_ms.checked_div(self.total).unwrap_or(0)
    }

    /// p50 (median) latency in ms.
    pub fn p50_ms(&self) -> u64 {
        self.percentile(50)
    }

    /// p95 latency in ms.
    pub fn p95_ms(&self) -> u64 {
        self.percentile(95)
    }

    /// Generic percentile: `pct` in 0..=100.
    pub fn percentile(&self, pct: u8) -> u64 {
        if self.total == 0 {
            return 0;
        }
        if self.counts.len() < self.bounds.len() {
            return 0;
        }
        let target = ((self.total as f64) * (pct as f64) / 100.0).ceil() as u64;
        let mut cumulative: u64 = 0;
        for (i, &cnt) in self.counts.iter().enumerate() {
            cumulative = cumulative.saturating_add(cnt);
            if cumulative >= target {
                return self.bounds[i];
            }
        }
        self.bounds.last().copied().unwrap_or(0)
    }
}

/// Metricas por MODELO concreto (key = "provider_id::model").
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ModelMetrics {
    pub provider_id: String,
    pub model: String,
    pub count: u64,
    pub success_count: u64,
    pub output_tokens: u64,
    #[serde(default)]
    pub histogram: LatencyHistogram,
    #[serde(default)]
    pub latency_ms_avg: u64,
    #[serde(default)]
    pub latency_p50_ms: u64,
    #[serde(default)]
    pub latency_p95_ms: u64,
    #[serde(default)]
    pub total_retries: u64,
    #[serde(default)]
    pub retried_calls: u64,
    #[serde(default)]
    pub date: String,
}

/// Per-provider request counter for the CURRENT day.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DailyUsage {
    /// ISO date (YYYY-MM-DD, UTC) the counter belongs to.
    pub date: String,
    /// Requests routed to this provider today.
    pub count: u64,
}

/// Per-routing-mode counters, reset daily.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ModeCounters {
    /// Day (UTC, YYYY-MM-DD) this counter set belongs to.
    pub date: String,
    #[serde(default)]
    pub counts: HashMap<String, u64>,
}

/// Size of the rolling window backing `real_fallback_rate_recent`.
///
/// The cumulative `real_fallback_rate` mixes in failures from providers that
/// have since been retired (claude-haiku 2026-06-10, gemini-cli 2026-06-19),
/// so it is NOT an actionable health signal. The recent window only counts the
/// last N route() outcomes, reflecting the CURRENT zone configuration.
pub(crate) const RECENT_FALLBACK_WINDOW: usize = 200;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RouterMetrics {
    pub tokens_saved_total: u64,
    pub cost_saved_usd: f64,
    pub by_class: HashMap<String, ClassMetrics>,
    /// Ratio of calls that fell back to a secondary provider (0.0..=1.0).
    pub fallback_rate: f64,
    #[serde(default)]
    pub daily: HashMap<String, DailyUsage>,
    #[serde(default)]
    pub by_model: HashMap<String, ModelMetrics>,
    #[serde(default)]
    pub by_mode: ModeCounters,
    #[serde(default)]
    pub fail_reasons: HashMap<String, u64>,
    #[serde(default)]
    pub routes_total: u64,
    #[serde(default)]
    pub real_fallback_count: u64,
    /// Rolling window of the most recent route outcomes (true = the winning
    /// provider was NOT the primary). Bounded to `RECENT_FALLBACK_WINDOW`;
    /// oldest entries are dropped. Drives `real_fallback_rate_recent`.
    #[serde(default)]
    pub recent_routes: Vec<bool>,
}

/// Approximate published free-tier DAILY request limit (RPD) per provider.
///
/// ENV-OVERRIDE: checks environment variables so operators can adjust limits
/// at deploy time without recompiling:
///   ULTRON_GEMINI_TIER_LIMIT  — override for the "gemini" provider (integer)
///   ULTRON_GROQ_TIER_LIMIT    — override for the "groq" provider (integer)
pub fn free_tier_daily_limit(provider_id: &str) -> Option<u64> {
    fn env_override(var: &str) -> Option<u64> {
        std::env::var(var)
            .ok()
            .and_then(|v| v.trim().parse::<u64>().ok())
            .filter(|&n| n > 0)
    }

    match provider_id {
        "gemini" => Some(env_override("ULTRON_GEMINI_TIER_LIMIT").unwrap_or(20)),
        "groq" => Some(env_override("ULTRON_GROQ_TIER_LIMIT").unwrap_or(1000)),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Usage summary types (returned by the usage_summary command)
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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProviderUsageRow {
    pub provider_id: String,
    pub provider_label: String,
    pub key_env_var: String,
    pub key_present: bool,
    pub key_masked: Option<String>,
    pub call_count: u64,
    pub success_count: u64,
    pub total_tokens: u64,
    pub latency_ms_avg: u64,
    pub primary_for_zones: Vec<String>,
    pub fallback_for_zones: Vec<String>,
    pub free_tier_limit: Option<u64>,
    pub free_tier_used_today: u64,
    pub last_error: Option<String>,
    pub last_error_at: Option<String>,
    pub consecutive_failures: u64,
    pub cooldown_until: Option<String>,
    pub free_tier_pct: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UsageSummary {
    pub providers: Vec<ProviderUsageRow>,
    /// EMA (α=0.1) over the 0/1 per-attempt success/failure stream.
    pub fallback_rate: f64,
    /// Same value as `fallback_rate`, renamed for clarity.
    pub attempt_failure_rate: f64,
    /// Fraction of ALL completed route() calls where the winning provider was
    /// NOT the primary (cumulative; includes history from retired providers).
    pub real_fallback_rate: f64,
    pub real_fallback_count: u64,
    pub routes_total: u64,
    /// Same fraction but only over the last `recent_window` routes — the
    /// actionable health signal, immune to retired-provider history.
    pub real_fallback_rate_recent: f64,
    /// Number of routes actually present in the recent window (0..=window cap).
    pub recent_window: u64,
    pub zone_chains: HashMap<String, Vec<String>>,
}

// ---------------------------------------------------------------------------
// Storage layout — path helpers
// ---------------------------------------------------------------------------

pub(crate) fn router_dir() -> Result<PathBuf, String> {
    let p = ultron_root()?.join("cockpit").join("ai-router");
    fs::create_dir_all(&p).map_err(|e| format!("create ai-router dir: {}", e))?;
    Ok(p)
}

pub(crate) fn providers_path() -> Result<PathBuf, String> {
    Ok(router_dir()?.join("providers.json"))
}

pub(crate) fn zones_path() -> Result<PathBuf, String> {
    Ok(router_dir()?.join("zones.json"))
}

pub(crate) fn metrics_path() -> Result<PathBuf, String> {
    Ok(router_dir()?.join("metrics.json"))
}

/// Append-only structured route-decision log (cat15.2). Consumed by the
/// LiveSessionMonitor via plain file reads (no Tauri command needed).
/// Lives under `~/.ultron/logs/` alongside the hook JSONL streams.
pub(crate) fn route_decisions_path() -> Result<PathBuf, String> {
    let dir = ultron_root()?.join("logs");
    fs::create_dir_all(&dir).map_err(|e| format!("create logs dir: {}", e))?;
    Ok(dir.join("route-decisions.jsonl"))
}
