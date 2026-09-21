// ULTRON Control Center — Anthropic plan limits.
//
// `usage.rs` reports *consumption* computed from local files. That answers
// "how many tokens did I burn", never "how much of my plan is left": the
// quota itself lives server-side and `/usage` inside Claude Code fetches it
// on demand. This module closes that gap so the Usage tab can show the same
// two gauges without opening a terminal.
//
// Source: GET https://api.anthropic.com/api/oauth/usage, authenticated with
// the OAuth access token Claude Code stores in ~/.claude/.credentials.json.
// The token is read, sent to Anthropic, and dropped — it is never logged,
// never cached, and never returned to the frontend.
//
// The endpoint is not part of Anthropic's documented public API, so every
// field is parsed defensively out of a serde_json::Value: a renamed or
// dropped key degrades one gauge instead of failing the whole report. When
// the call fails entirely the last good response is served with `stale =
// true` so the panel shows slightly old numbers rather than an error.

use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA: &str = "oauth-2026-04-20";
const HTTP_TIMEOUT_SECS: u64 = 12;
/// Claude Code itself refreshes this endpoint sparingly. A short TTL keeps
/// the panel live (it polls on focus and on a timer) without turning every
/// window focus into an HTTP round-trip.
const CACHE_TTL_SECS: u64 = 60;

// ---------------------------------------------------------------------------
// Shapes returned to the frontend
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PlanWindow {
    /// Percent of the window consumed, 0-100.
    pub utilization: f64,
    /// ISO-8601 instant at which this window rolls over.
    pub resets_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PlanScopedLimit {
    pub kind: String,
    pub group: String,
    pub percent: f64,
    pub severity: String,
    pub resets_at: Option<String>,
    /// Model display name when the limit is scoped to one (e.g. "Fable").
    pub scope_label: Option<String>,
    pub is_active: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BreakdownRow {
    pub key: String,
    pub display_name: String,
    pub percent: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PlanLimits {
    /// "max", "pro", … as recorded by Claude Code at login.
    pub subscription_type: Option<String>,
    pub five_hour: Option<PlanWindow>,
    pub seven_day: Option<PlanWindow>,
    /// Every limit the endpoint reports, including per-model scoped ones.
    pub limits: Vec<PlanScopedLimit>,
    /// Where the weekly allowance went, by surface (Claude Code, Chats, …).
    pub breakdown: Vec<BreakdownRow>,
    pub breakdown_as_of: Option<String>,
    pub extra_usage_enabled: bool,
    /// Unix seconds at which this payload was fetched from Anthropic.
    pub fetched_at: u64,
    /// True when the live call failed and these are cached numbers.
    pub stale: bool,
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

fn credentials_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join(".credentials.json"))
}

fn cache_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| {
        h.join(".ultron")
            .join(".tmp")
            .join("plan-limits-cache.json")
    })
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/// Returns (access_token, subscription_type). The token is handed straight to
/// the HTTP call and never stored anywhere else.
fn read_oauth_token() -> Result<(String, Option<String>), String> {
    let path = credentials_path().ok_or_else(|| "no HOME dir".to_string())?;
    let raw = fs::read_to_string(&path).map_err(|e| {
        format!("no se pudo leer ~/.claude/.credentials.json ({e}). ¿Has iniciado sesión en Claude Code?")
    })?;
    let json: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("credentials.json ilegible: {e}"))?;
    let oauth = json.get("claudeAiOauth").ok_or_else(|| {
        "credentials.json sin claudeAiOauth (login por API key, no OAuth)".to_string()
    })?;
    let token = oauth
        .get("accessToken")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "credentials.json sin accessToken".to_string())?
        .to_string();
    let sub = oauth
        .get("subscriptionType")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Ok((token, sub))
}

// ---------------------------------------------------------------------------
// Defensive extraction from the raw payload
// ---------------------------------------------------------------------------

fn as_f64(v: Option<&serde_json::Value>) -> Option<f64> {
    v.and_then(|x| x.as_f64())
}

fn as_string(v: Option<&serde_json::Value>) -> Option<String> {
    v.and_then(|x| x.as_str()).map(|s| s.to_string())
}

fn parse_window(v: Option<&serde_json::Value>) -> Option<PlanWindow> {
    let obj = v?;
    if obj.is_null() {
        return None;
    }
    Some(PlanWindow {
        utilization: as_f64(obj.get("utilization")).unwrap_or(0.0),
        resets_at: as_string(obj.get("resets_at")),
    })
}

fn parse_limits(v: Option<&serde_json::Value>) -> Vec<PlanScopedLimit> {
    let Some(arr) = v.and_then(|x| x.as_array()) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|l| {
            let kind = as_string(l.get("kind"))?;
            // A scoped limit nests the model under scope.model.display_name.
            let scope_label = l
                .get("scope")
                .and_then(|s| s.get("model"))
                .and_then(|m| m.get("display_name"))
                .and_then(|d| d.as_str())
                .map(|s| s.to_string());
            Some(PlanScopedLimit {
                kind,
                group: as_string(l.get("group")).unwrap_or_default(),
                percent: as_f64(l.get("percent")).unwrap_or(0.0),
                severity: as_string(l.get("severity")).unwrap_or_else(|| "normal".to_string()),
                resets_at: as_string(l.get("resets_at")),
                scope_label,
                is_active: l
                    .get("is_active")
                    .and_then(|b| b.as_bool())
                    .unwrap_or(false),
            })
        })
        .collect()
}

fn parse_breakdown(v: Option<&serde_json::Value>) -> (Vec<BreakdownRow>, Option<String>) {
    let Some(obj) = v else {
        return (Vec::new(), None);
    };
    let as_of = as_string(obj.get("as_of"));
    let rows = obj
        .get("rows")
        .and_then(|r| r.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|row| {
                    let key = as_string(row.get("key"))?;
                    Some(BreakdownRow {
                        display_name: as_string(row.get("display_name"))
                            .unwrap_or_else(|| key.clone()),
                        key,
                        percent: as_f64(row.get("percent")).unwrap_or(0.0),
                    })
                })
                // A surface at 0 % is noise in a 4-row list.
                .filter(|r| r.percent > 0.0)
                .collect()
        })
        .unwrap_or_default();
    (rows, as_of)
}

fn shape(raw: &serde_json::Value, subscription_type: Option<String>) -> PlanLimits {
    let (breakdown, breakdown_as_of) = parse_breakdown(raw.get("seven_day_breakdown"));
    PlanLimits {
        subscription_type,
        five_hour: parse_window(raw.get("five_hour")),
        seven_day: parse_window(raw.get("seven_day")),
        limits: parse_limits(raw.get("limits")),
        breakdown,
        breakdown_as_of,
        extra_usage_enabled: raw
            .get("extra_usage")
            .and_then(|e| e.get("is_enabled"))
            .and_then(|b| b.as_bool())
            .unwrap_or(false),
        fetched_at: now_secs(),
        stale: false,
    }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

fn read_cache() -> Option<PlanLimits> {
    let path = cache_path()?;
    let raw = fs::read_to_string(&path).ok()?;
    serde_json::from_str::<PlanLimits>(&raw).ok()
}

fn write_cache(limits: &PlanLimits) {
    let Some(path) = cache_path() else { return };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(limits) {
        let _ = fs::write(&path, json);
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/// Fetches the plan gauges, honouring a short TTL cache.
///
/// `force` skips the TTL (the panel's manual refresh button). On a network or
/// auth failure the cached payload is returned with `stale = true`; only a
/// failure with nothing cached surfaces as an Err.
pub fn plan_limits_inner(force: bool) -> Result<PlanLimits, String> {
    let cached = read_cache();
    if !force {
        if let Some(c) = &cached {
            if now_secs().saturating_sub(c.fetched_at) < CACHE_TTL_SECS {
                return Ok(c.clone());
            }
        }
    }

    match fetch_live() {
        Ok(limits) => {
            write_cache(&limits);
            Ok(limits)
        }
        Err(e) => match cached {
            // Serving numbers a few minutes old beats blanking the panel.
            Some(mut c) => {
                c.stale = true;
                Ok(c)
            }
            None => Err(e),
        },
    }
}

fn fetch_live() -> Result<PlanLimits, String> {
    let (token, subscription_type) = read_oauth_token()?;

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("cliente HTTP: {e}"))?;

    let resp = client
        .get(USAGE_URL)
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-beta", OAUTH_BETA)
        .header("Content-Type", "application/json")
        .send()
        .map_err(|e| format!("GET {USAGE_URL}: {e}"))?;

    let status = resp.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(
            "token OAuth rechazado (401/403). Abre Claude Code para renovar la sesión.".to_string(),
        );
    }
    if !status.is_success() {
        return Err(format!("endpoint de uso devolvió HTTP {status}"));
    }

    let raw: serde_json::Value = resp
        .json()
        .map_err(|e| format!("respuesta de uso ilegible: {e}"))?;

    Ok(shape(&raw, subscription_type))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Trimmed copy of a real response, kept verbatim in shape so the parser
    /// is exercised against the field names the endpoint actually sends.
    fn sample() -> serde_json::Value {
        serde_json::json!({
            "five_hour": { "utilization": 7.0, "resets_at": "2026-09-21T19:10:00Z" },
            "seven_day": { "utilization": 27.0, "resets_at": "2026-09-25T01:00:00Z" },
            "seven_day_opus": null,
            "limits": [
                { "kind": "session", "group": "session", "percent": 7,
                  "severity": "normal", "resets_at": "2026-09-21T19:10:00Z",
                  "scope": null, "is_active": false },
                { "kind": "weekly_scoped", "group": "weekly", "percent": 16,
                  "severity": "normal", "resets_at": "2026-09-25T00:59:59Z",
                  "scope": { "model": { "id": null, "display_name": "Fable" } },
                  "is_active": false }
            ],
            "extra_usage": { "is_enabled": false, "user_disabled": true },
            "seven_day_breakdown": {
                "as_of": "2026-09-21T15:53:12Z",
                "rows": [
                    { "key": "claude_code", "display_name": "Claude Code", "percent": 78 },
                    { "key": "chat", "display_name": "Chats", "percent": 0 },
                    { "key": "cowork", "display_name": "Cowork", "percent": 22 }
                ]
            }
        })
    }

    #[test]
    fn shapes_the_two_windows() {
        let l = shape(&sample(), Some("max".into()));
        assert_eq!(l.five_hour.as_ref().unwrap().utilization, 7.0);
        assert_eq!(l.seven_day.as_ref().unwrap().utilization, 27.0);
        assert_eq!(l.subscription_type.as_deref(), Some("max"));
        assert!(!l.stale);
    }

    #[test]
    fn extracts_the_model_scope_label() {
        let l = shape(&sample(), None);
        let scoped = l.limits.iter().find(|x| x.kind == "weekly_scoped").unwrap();
        assert_eq!(scoped.scope_label.as_deref(), Some("Fable"));
        assert_eq!(scoped.percent, 16.0);
        // An unscoped limit must not invent a label.
        let session = l.limits.iter().find(|x| x.kind == "session").unwrap();
        assert!(session.scope_label.is_none());
    }

    #[test]
    fn drops_breakdown_rows_at_zero() {
        let l = shape(&sample(), None);
        assert_eq!(l.breakdown.len(), 2);
        assert!(l.breakdown.iter().all(|r| r.percent > 0.0));
        assert_eq!(l.breakdown[0].display_name, "Claude Code");
    }

    /// The endpoint is undocumented: a renamed or missing key must degrade
    /// one gauge, never poison the whole report.
    #[test]
    fn survives_a_payload_with_everything_missing() {
        let l = shape(&serde_json::json!({}), None);
        assert!(l.five_hour.is_none());
        assert!(l.seven_day.is_none());
        assert!(l.limits.is_empty());
        assert!(l.breakdown.is_empty());
        assert!(!l.extra_usage_enabled);
    }

    #[test]
    fn treats_an_explicitly_null_window_as_absent() {
        let raw = serde_json::json!({ "five_hour": null, "seven_day_opus": null });
        let l = shape(&raw, None);
        assert!(l.five_hour.is_none());
    }

    #[test]
    fn ignores_limit_entries_without_a_kind() {
        let raw = serde_json::json!({
            "limits": [ { "group": "weekly", "percent": 10 },
                        { "kind": "session", "group": "session", "percent": 3 } ]
        });
        let l = shape(&raw, None);
        assert_eq!(l.limits.len(), 1);
        assert_eq!(l.limits[0].kind, "session");
    }
}
