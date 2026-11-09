// Domain types for the AI Router.
//
// Contains all the public/crate-visible structs, enums, and constants that
// the other submódulos share.  Storage-path helpers also live here because
// they are pure functions over the types and `ultron_root`.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub use super::api_format::ApiFormat;
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
///
/// Se deserializa a través de `ProviderRaw` para deducir `api_format` en un
/// `providers.json` escrito antes de que existiera el campo.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(from = "super::api_format::ProviderRaw")]
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
    /// Protocolo con el que se despacha la llamada (`try_assignment_call`).
    pub api_format: ApiFormat,
    /// `true` solo para los proveedores dados de alta desde la UI
    /// (`ai_router_upsert_custom_provider`); son los únicos que se pueden
    /// borrar.
    #[serde(default)]
    pub custom: bool,
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ZoneAssignment {
    pub provider_id: String,
    pub model: String,
    #[serde(default)]
    pub max_tokens: u32,
}

/// A named routing zone (e.g. "chat", "summarize", "light").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Zone {
    pub id: String,
    pub label: String,
    pub category: String,
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
/// Cap of the doubling cooldown (15 -> 30 -> 60 -> 120 min) applied when the
/// provider gives no explicit retry hint.
pub(crate) const HEALTH_GATE_COOLDOWN_MAX_MINUTES: i64 = 120;

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
    /// Last terminal failure message (redacted, then truncated, in `apply_metric_sample`).
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
    /// Terminal failures in a row for THIS model (reset on success). Drives
    /// the health gate, which is keyed by (provider, model): Groq quotas are
    /// per model, so a 429 on one model must not bench its siblings.
    #[serde(default)]
    pub consecutive_failures: u64,
    /// Health gate: route() soft-skips this model until this RFC3339 instant.
    /// Survives the daily counter reset (it is an absolute instant).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cooldown_until: Option<String>,
}

/// Request counter of one free-tier quota bucket for the CURRENT day.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DailyUsage {
    /// ISO date (YYYY-MM-DD, UTC) the counter belongs to.
    pub date: String,
    /// Requests sent to this bucket today.
    pub count: u64,
}

/// Key of the daily free-tier counter in `RouterMetrics::daily`.
///
/// La cuota gratuita de Groq y de Gemini es POR MODELO (2026-09-07: el 120b
/// en 429 dejaba al 20b con su propio bucket intacto), así que el contador va
/// por la pareja (proveedor, modelo). Con la clave antigua, por proveedor, la
/// suma de los dos modelos de Groq agotaba el tope de los dos a la vez y la
/// cadena saltaba a las 20 peticiones diarias de Gemini.
pub(crate) fn daily_quota_key(provider_id: &str, model: &str) -> String {
    format!("{provider_id}::{model}")
}

/// Final outcome of one `route()` call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RouteOutcome {
    /// The zone's primary answered.
    Primary,
    /// A fallback answered after the primary failed or was skipped.
    Fallback,
    /// Every provider of the chain failed or was skipped: no answer.
    Failed,
}

impl RouteOutcome {
    /// `true` when the primary did NOT serve the route (fallback or failure).
    pub fn missed_primary(self) -> bool {
        !matches!(self, RouteOutcome::Primary)
    }
}

/// Size of the rolling window backing the `*_recent` rates.
///
/// The cumulative rates mix in failures from providers that have since been
/// retired (claude-haiku 2026-06-10, gemini-cli 2026-06-19), so they are NOT
/// an actionable health signal. The recent window only counts the last N
/// route() outcomes, reflecting the CURRENT zone configuration.
pub(crate) const RECENT_FALLBACK_WINDOW: usize = 200;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RouterMetrics {
    #[serde(alias = "tokens_saved_total")]
    pub fallback_output_tokens: u64,
    pub cost_saved_usd: f64,
    pub by_class: HashMap<String, ClassMetrics>,
    /// EMA (alpha 0.1) of per-ATTEMPT failures (1 = failed attempt, 0 = ok).
    /// It is not a route fallback ratio: see `real_fallback_count`.
    pub fallback_rate: f64,
    /// Daily free-tier counters keyed by `daily_quota_key(provider, model)`.
    #[serde(default)]
    pub daily: HashMap<String, DailyUsage>,
    #[serde(default)]
    pub by_model: HashMap<String, ModelMetrics>,
    #[serde(default)]
    pub fail_reasons: HashMap<String, u64>,
    /// Every finished route() call, including the ones whose chain failed.
    #[serde(default)]
    pub routes_total: u64,
    /// Routes answered by a fallback (not the primary).
    #[serde(default)]
    pub real_fallback_count: u64,
    /// Routes where the whole chain failed or was skipped (no answer).
    #[serde(default)]
    pub routes_failed: u64,
    /// Rolling window of the most recent route outcomes, bounded to
    /// `RECENT_FALLBACK_WINDOW` (oldest dropped). Drives the `*_recent` rates.
    #[serde(default)]
    pub recent_outcomes: Vec<RouteOutcome>,
    /// Legacy window (true = fallback) written by binaries older than
    /// 2026-10-23. Read only to seed `recent_outcomes`; never written back.
    #[serde(default, skip_serializing)]
    pub recent_routes: Vec<bool>,
}

impl RouterMetrics {
    /// Seed `recent_outcomes` from the legacy boolean window when a file
    /// written by an older binary has no outcome window yet. Idempotent.
    pub(crate) fn adopt_legacy_window(&mut self) {
        if self.recent_outcomes.is_empty() && !self.recent_routes.is_empty() {
            self.recent_outcomes = self
                .recent_routes
                .iter()
                .map(|&fb| {
                    if fb {
                        RouteOutcome::Fallback
                    } else {
                        RouteOutcome::Primary
                    }
                })
                .collect();
        }
        self.recent_routes.clear();
    }

    /// Requests already sent today to the free-tier bucket of (provider, model).
    pub(crate) fn daily_used(&self, provider_id: &str, model: &str, today: &str) -> u64 {
        self.daily
            .get(&daily_quota_key(provider_id, model))
            .filter(|d| d.date == today)
            .map(|d| d.count)
            .unwrap_or(0)
    }
}

/// Approximate published free-tier DAILY request limit (RPD) of ONE model of
/// the provider (the bucket is per model, see `daily_quota_key`).
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
    /// EMA (α=0.1) over the 0/1 per-attempt success/failure stream. Context
    /// only: it is not a route-level ratio.
    pub attempt_failure_rate: f64,
    /// Fraction of ALL route() calls the primary did NOT serve: a fallback
    /// answered or the whole chain failed (cumulative; includes history from
    /// retired providers).
    pub real_fallback_rate: f64,
    pub real_fallback_count: u64,
    /// Routes where the whole chain failed or was skipped (no answer).
    pub routes_failed: u64,
    /// `routes_failed / routes_total` (cumulative).
    pub route_failure_rate: f64,
    pub routes_total: u64,
    /// Same as `real_fallback_rate` but only over the last `recent_window`
    /// routes — the actionable health signal the dashboard headlines.
    pub real_fallback_rate_recent: f64,
    /// Failed routes over the last `recent_window` routes.
    pub route_failure_rate_recent: f64,
    /// Number of routes actually present in the recent window (0..=window cap).
    pub recent_window: u64,
    pub zone_chains: HashMap<String, Vec<String>>,
}

// ---------------------------------------------------------------------------
// Storage layout — path helpers
// ---------------------------------------------------------------------------

#[cfg(test)]
thread_local! {
    /// Raíz alternativa del router para los tests del hilo actual. Cada test
    /// de cargo corre en su propio hilo, así que no hay carreras entre tests.
    static TEST_ROOT: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

/// Mientras vive, todas las rutas del router de ESTE hilo cuelgan de `dir`
/// en vez de `~/.ultron`: un test que llame a `load_zones`, `route` o a las
/// métricas no lee ni reescribe la configuración real del usuario.
#[cfg(test)]
pub(crate) struct TestRootGuard;

#[cfg(test)]
impl TestRootGuard {
    pub(crate) fn new(dir: &std::path::Path) -> Self {
        TEST_ROOT.with(|r| *r.borrow_mut() = Some(dir.to_path_buf()));
        TestRootGuard
    }
}

#[cfg(test)]
impl Drop for TestRootGuard {
    fn drop(&mut self) {
        TEST_ROOT.with(|r| *r.borrow_mut() = None);
    }
}

/// `~/.ultron`, o la raíz de `TestRootGuard` en los tests.
fn router_root() -> Result<PathBuf, String> {
    #[cfg(test)]
    if let Some(dir) = TEST_ROOT.with(|r| r.borrow().clone()) {
        return Ok(dir);
    }
    ultron_root()
}

pub(crate) fn router_dir() -> Result<PathBuf, String> {
    let p = router_root()?.join("cockpit").join("ai-router");
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

/// Configuración del delegador multi-motor (`scripts/delegate.mjs`).
pub(crate) fn delegation_path() -> Result<PathBuf, String> {
    Ok(router_dir()?.join("delegation.json"))
}

/// Ledger append-only de delegaciones que escribe `scripts/delegate.mjs`.
pub(crate) fn delegations_ledger_path() -> Result<PathBuf, String> {
    Ok(router_root()?.join("cockpit").join("delegations.jsonl"))
}

/// `scripts/delegate.mjs` del repo de ULTRON.
pub(crate) fn delegate_script_path() -> Result<PathBuf, String> {
    Ok(router_root()?.join("scripts").join("delegate.mjs"))
}

/// Append-only structured route-decision log (cat15.2). Consumed by the
/// activity timeline (`activity_timeline::ingest_routing`) via plain file
/// reads. Lives under `~/.ultron/logs/` alongside the hook JSONL streams.
pub(crate) fn route_decisions_path() -> Result<PathBuf, String> {
    let dir = router_root()?.join("logs");
    fs::create_dir_all(&dir).map_err(|e| format!("create logs dir: {}", e))?;
    Ok(dir.join("route-decisions.jsonl"))
}
