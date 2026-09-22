// Pure parsing helpers for the "Cuentas y modelos" Settings section.
//
// Everything here takes an already-parsed `serde_json::Value` (or a plain
// string) and returns plain data — no filesystem, no process, no network.
// That is what makes these functions testable with synthetic fixtures and
// safe to call from both the fast `accounts_report` path and the
// process-spawning `accounts_refresh_models` path.
//
// Read-only, informational feature: nothing here selects a model or changes
// routing. See `control-center/src-tauri/src/accounts/mod.rs` for the
// module-level contract.

use regex::Regex;
use serde_json::Value;
use std::sync::OnceLock;

/// Paths tried, in order, to find an account email in a CLI credential blob.
/// Different CLIs (and different versions of the same CLI) name this field
/// differently, so several shapes are tried rather than picking one.
const EMAIL_PATHS: &[&[&str]] = &[
    &["email"],
    &["account", "email"],
    &["account", "email_address"],
    &["oauthAccount", "emailAddress"],
    &["claudeAiOauth", "emailAddress"],
    &["user", "email"],
];

/// Finds an email in `v` by walking [`EMAIL_PATHS`] in order. Returns the
/// email and the dotted path it was found at (for the UI's "source" field).
/// `None` when no known shape matches — never guesses.
#[must_use]
pub fn find_email(v: &Value) -> Option<(String, String)> {
    for path in EMAIL_PATHS {
        let mut cur = v;
        let mut matched = true;
        for segment in *path {
            match cur.get(segment) {
                Some(next) => cur = next,
                None => {
                    matched = false;
                    break;
                }
            }
        }
        if !matched {
            continue;
        }
        if let Some(s) = cur.as_str() {
            let s = s.trim();
            if !s.is_empty() {
                return Some((s.to_string(), path.join(".")));
            }
        }
    }
    None
}

/// Decodes the payload segment of a JWT WITHOUT verifying the signature.
/// Only ever used to read a non-sensitive display claim (plan name); the
/// token itself never leaves the caller's stack frame.
fn jwt_payload(token: &str) -> Option<Value> {
    use base64::Engine;
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim())
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// The email carried inside a Codex `id_token` payload, decoded WITHOUT
/// verifying the signature — the only offline source of the account email
/// (`codex login status` doesn't print it, confirmed 2026-09-22).
#[must_use]
pub fn email_from_jwt(token: &str) -> Option<String> {
    find_email(&jwt_payload(token)?).map(|(e, _)| e)
}

/// The `chatgpt_plan_type` claim from a Codex `id_token`, undecorated
/// ("free", "plus"...). `None` when the token is unparsable or lacks it.
#[must_use]
pub fn codex_plan_from_jwt(token: &str) -> Option<String> {
    let v = jwt_payload(token)?;
    v.get("https://api.openai.com/auth")
        .and_then(|a| a.get("chatgpt_plan_type"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Last 4 characters of an API key, for display. Keys of length <= 4 are
/// masked entirely — that short a value isn't a usable key, and printing it
/// verbatim would still be a needless leak.
#[must_use]
pub fn key_tail(key: &str) -> String {
    let trimmed = key.trim();
    let n = trimmed.chars().count();
    if n == 0 {
        return String::new();
    }
    if n <= 4 {
        return "•".repeat(n);
    }
    format!("…{}", trimmed.chars().skip(n - 4).collect::<String>())
}

/// Last N characters of a key — used ONLY as a transient comparison value
/// against `customApiKeyResponses` (never stored in a struct field, never
/// printed, never returned to a caller outside this comparison).
fn key_tail_n(key: &str, n: usize) -> String {
    let trimmed = key.trim();
    let len = trimmed.chars().count();
    if len <= n {
        trimmed.to_string()
    } else {
        trimmed.chars().skip(len - n).collect()
    }
}

/// Whether Claude Code will actually USE `key` instead of the subscription.
///
/// Claude Code keeps a `customApiKeyResponses` cache in `~/.claude.json`
/// with two arrays of the key's last-20-characters tail: `approved` and
/// `rejected`. It only bills the key when the tail is in `approved` — an
/// `ANTHROPIC_API_KEY` that's merely *set* in the environment but sits in
/// `rejected` (or in neither array) is inert: the CLI still falls back to
/// the subscription. Comparing by tail avoids ever needing the full key
/// here; the tail itself is discarded when this call returns.
#[must_use]
pub fn claude_api_key_approved(claude_json: &Value, key: &str) -> bool {
    let tail = key_tail_n(key, 20);
    claude_json
        .get("customApiKeyResponses")
        .and_then(|c| c.get("approved"))
        .and_then(Value::as_array)
        .is_some_and(|rows| rows.iter().any(|v| v.as_str() == Some(tail.as_str())))
}

/// Human label for a Claude subscription, using the same vocabulary the
/// Claude Code CLI itself uses in its credentials/profile caches.
#[must_use]
pub fn claude_plan_label(kind: &str, tier: &str) -> String {
    let k = kind.trim().to_lowercase();
    if k.is_empty() {
        return String::new();
    }
    let suffix = if k == "max" || k == "claude_max" {
        match tier.trim().to_lowercase().as_str() {
            t if t.contains("max_20x") => " 20x",
            t if t.contains("max_5x") => " 5x",
            _ => "",
        }
    } else {
        ""
    };
    let base = match k.as_str() {
        "enterprise" | "claude_enterprise" => "Claude Enterprise",
        "team" | "claude_team" => "Claude Team",
        "max" | "claude_max" => "Claude Max",
        "pro" | "claude_pro" => "Claude Pro",
        other => return format!("Claude ({other})"),
    };
    format!("{base}{suffix}")
}

/// Human label for a ChatGPT plan claim.
#[must_use]
pub fn codex_plan_label(raw: &str) -> String {
    let t = raw.trim().to_lowercase();
    if t.is_empty() || t == "unknown" {
        return String::new();
    }
    match t.as_str() {
        "free" => "ChatGPT Free".into(),
        "plus" => "ChatGPT Plus".into(),
        "pro" => "ChatGPT Pro".into(),
        "team" => "ChatGPT Team".into(),
        "business" => "ChatGPT Business".into(),
        "edu" => "ChatGPT Edu".into(),
        "enterprise" => "ChatGPT Enterprise".into(),
        other => format!("ChatGPT ({other})"),
    }
}

/// Account-kind label from Antigravity's `authMethod=` log marker. The
/// provider's own plan name (Free/Pro/Ultra) isn't exposed anywhere on
/// disk — only whether the session is a personal or a workspace account.
#[must_use]
pub fn antigravity_account_kind(log: &str) -> String {
    let mut last = "";
    for line in log.lines() {
        if let Some(rest) = line.split("authMethod=").nth(1) {
            let value = rest
                .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
                .next()
                .unwrap_or("");
            if !value.is_empty() {
                last = value;
            }
        }
    }
    match last.to_lowercase().as_str() {
        "consumer" => "Google (cuenta personal)".into(),
        "" | "unspecified" => String::new(),
        "business" | "enterprise" => "Google (cuenta de empresa)".into(),
        other => format!("Google ({other})"),
    }
}

/// Shape guard for a model id read from disk before it is ever shown in the
/// UI or handed to a command: alphanumeric/dot/dash/underscore, never
/// starting with `-` (which would otherwise be readable as a CLI flag).
#[must_use]
pub fn is_valid_model_id(id: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$").expect("static regex is valid")
    });
    re.is_match(id)
}

/// What `~/.claude.json` says this account may use: `additionalModelOptionsCache`
/// is the server's extra offer to this account; `modelAccessCache` carries
/// explicit entitlement rows (`entitled: false` is the only veto evidence
/// Claude Code leaves on disk). Returns `(allowed, denied)`, deduplicated and
/// sorted; anything in `denied` is removed from `allowed`.
#[must_use]
pub fn claude_model_access(claude_json: &Value) -> (Vec<String>, Vec<String>) {
    let mut allowed: Vec<String> = claude_json
        .get("additionalModelOptionsCache")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|r| r.get("value").and_then(Value::as_str))
                .map(str::trim)
                .filter(|s| !s.is_empty() && is_valid_model_id(s))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    let mut denied = Vec::new();
    if let Some(rows) = claude_json
        .get("modelAccessCache")
        .and_then(Value::as_array)
    {
        for row in rows {
            let Some(id) = row
                .get("apiName")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty() && is_valid_model_id(s))
            else {
                continue;
            };
            match row.get("entitled").and_then(Value::as_bool) {
                Some(false) => denied.push(id.to_string()),
                Some(true) => allowed.push(id.to_string()),
                None => {}
            }
        }
    }
    allowed.retain(|a| !denied.contains(a));
    allowed.sort();
    allowed.dedup();
    denied.sort();
    denied.dedup();
    (allowed, denied)
}

/// What `~/.codex/models_cache.json` (the server's per-account catalog)
/// offers, restricted to `visibility == "list"` and ordered by `priority`
/// ascending (lower = more capable, matching the CLI's own ordering). Rows
/// with `visibility: "hide"` (internal slugs like `gpt-reserve`) are not
/// selectable models and are excluded.
#[must_use]
pub fn codex_model_access(models_cache: &Value) -> Vec<String> {
    let mut rows: Vec<(i64, String)> = models_cache
        .get("models")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter(|m| m.get("visibility").and_then(Value::as_str) == Some("list"))
                .filter_map(|m| {
                    let slug = m
                        .get("slug")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty() && is_valid_model_id(s))?;
                    let priority = m
                        .get("priority")
                        .and_then(Value::as_i64)
                        .unwrap_or(i64::MAX);
                    Some((priority, slug.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    rows.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    rows.into_iter().map(|(_, slug)| slug).collect()
}

/// The default model configured in a Codex `config.toml`: the first
/// top-level `model = "..."` key, scanned only until the first `[section]`
/// header (profile/project-scoped `model =` keys further down are ignored —
/// they are not what a plain `codex` invocation uses).
#[must_use]
pub fn codex_default_model_from_toml(toml_text: &str) -> String {
    for line in toml_text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            break;
        }
        let Some(rest) = trimmed.strip_prefix("model") else {
            continue;
        };
        let rest = rest.trim_start();
        let Some(value) = rest.strip_prefix('=') else {
            continue;
        };
        let value = value.trim().trim_matches('"');
        if !value.is_empty() && is_valid_model_id(value) {
            return value.to_string();
        }
    }
    String::new()
}

/// Parses `agy models` output: one `id<TAB>label` per line. Lines without a
/// tab (the "Fetching available models..." adornment, or a future sign-in
/// prompt) are ignored rather than misread as an id.
#[must_use]
pub fn antigravity_models(tsv: &str) -> Vec<String> {
    tsv.lines()
        .filter_map(|l| l.split_once('\t'))
        .map(|(id, _)| id.trim().to_string())
        .filter(|id| is_valid_model_id(id))
        .collect()
}

/// Antigravity has no session file this module can read (verified: neither
/// `~/.antigravity` nor `%LOCALAPPDATA%\agy` hold one) — the only local
/// evidence of "no session" is `agy models` answering with no tab-separated
/// rows at all, or literally asking the user to sign in.
#[must_use]
pub fn antigravity_needs_login(cli_output: &str) -> bool {
    let has_rows = cli_output.lines().any(|l| l.contains('\t'));
    !has_rows || cli_output.to_lowercase().contains("please sign in")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn finds_email_in_known_cli_shapes() {
        for (v, expected) in [
            (json!({"email": "yo@ejemplo.com"}), "yo@ejemplo.com"),
            (json!({"account": {"email": "a@b.c"}}), "a@b.c"),
            (json!({"oauthAccount": {"emailAddress": "x@y.z"}}), "x@y.z"),
            (json!({"claudeAiOauth": {"emailAddress": "c@d.e"}}), "c@d.e"),
        ] {
            assert_eq!(find_email(&v).map(|(e, _)| e).as_deref(), Some(expected));
        }
    }

    #[test]
    fn never_invents_an_email() {
        for v in [
            json!({}),
            json!({"email": ""}),
            json!({"email": "   "}),
            json!({"token": "sk-secret"}),
            json!({"account": {"id": 42}}),
        ] {
            assert!(find_email(&v).is_none(), "invented an email from {v}");
        }
    }

    #[test]
    fn reads_the_plan_claim_from_a_synthetic_jwt() {
        use base64::Engine;
        let payload = json!({"https://api.openai.com/auth": {"chatgpt_plan_type": "plus"}});
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&payload).unwrap());
        let token = format!("header.{encoded}.signature");
        assert_eq!(codex_plan_from_jwt(&token).as_deref(), Some("plus"));
    }

    #[test]
    fn reads_the_email_carried_inside_a_synthetic_jwt() {
        use base64::Engine;
        let payload = json!({"email": "yo@ejemplo.com"});
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&payload).unwrap());
        let token = format!("header.{encoded}.signature");
        assert_eq!(email_from_jwt(&token).as_deref(), Some("yo@ejemplo.com"));
    }

    #[test]
    fn malformed_jwt_yields_no_plan_never_panics() {
        for token in ["", "not-a-jwt", "a.b", "a.!!!not-base64!!!.c"] {
            assert_eq!(codex_plan_from_jwt(token), None);
        }
    }

    #[test]
    fn key_tail_masks_short_keys_entirely() {
        assert_eq!(key_tail(""), "");
        assert_eq!(key_tail("abcd"), "••••");
        assert_eq!(key_tail("sk-abcdef1234"), "…1234");
    }

    /// Fixtures mirror the real shape confirmed on this machine (2026-09-22):
    /// `customApiKeyResponses.{approved,rejected}` are arrays of 20-char
    /// tails, and `oauthAccount` is a sibling top-level key.
    const SYNTHETIC_KEY: &str = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF"; // >20 chars

    #[test]
    fn api_key_approved_when_tail_is_in_the_approved_array() {
        let tail = key_tail_n(SYNTHETIC_KEY, 20);
        let v = json!({
            "customApiKeyResponses": {"approved": [tail], "rejected": []},
            "oauthAccount": {"emailAddress": "yo@ejemplo.com"}
        });
        assert!(claude_api_key_approved(&v, SYNTHETIC_KEY));
    }

    #[test]
    fn api_key_not_approved_when_tail_is_in_the_rejected_array() {
        let tail = key_tail_n(SYNTHETIC_KEY, 20);
        let v = json!({
            "customApiKeyResponses": {"approved": [], "rejected": [tail]},
            "oauthAccount": {"emailAddress": "yo@ejemplo.com"}
        });
        assert!(!claude_api_key_approved(&v, SYNTHETIC_KEY));
    }

    #[test]
    fn api_key_not_approved_when_claude_code_never_answered() {
        for v in [
            json!({}),
            json!({"customApiKeyResponses": {"approved": [], "rejected": []}}),
            json!({"customApiKeyResponses": {"approved": ["some-other-tail"], "rejected": []}}),
        ] {
            assert!(!claude_api_key_approved(&v, SYNTHETIC_KEY));
        }
    }

    #[test]
    fn claude_plan_label_reads_max_tier_suffix() {
        assert_eq!(
            claude_plan_label("max", "default_claude_max_5x"),
            "Claude Max 5x"
        );
        assert_eq!(
            claude_plan_label("max", "default_claude_max_20x"),
            "Claude Max 20x"
        );
        assert_eq!(claude_plan_label("pro", ""), "Claude Pro");
        assert_eq!(claude_plan_label("", ""), "");
        assert_eq!(claude_plan_label("weird_tier", ""), "Claude (weird_tier)");
    }

    #[test]
    fn codex_plan_label_covers_known_plans() {
        assert_eq!(codex_plan_label("plus"), "ChatGPT Plus");
        assert_eq!(codex_plan_label("unknown"), "");
        assert_eq!(codex_plan_label(""), "");
        assert_eq!(codex_plan_label("weird"), "ChatGPT (weird)");
    }

    #[test]
    fn model_id_shape_guard_rejects_flag_like_and_empty_ids() {
        assert!(is_valid_model_id("claude-opus-4-6"));
        assert!(is_valid_model_id("gpt-6-astra"));
        assert!(!is_valid_model_id("-rf"));
        assert!(!is_valid_model_id(""));
        assert!(!is_valid_model_id("has space"));
        assert!(!is_valid_model_id("semi;colon"));
    }

    #[test]
    fn claude_model_access_denied_wins_over_allowed() {
        let v = json!({
            "additionalModelOptionsCache": [
                {"value": "claude-fable-5-1", "label": "Fable 5.1"},
                {"value": "-not-a-model", "label": "bad"}
            ],
            "modelAccessCache": [
                {"apiName": "claude-opus-4-6", "entitled": true},
                {"apiName": "claude-mythos", "entitled": false}
            ]
        });
        let (allowed, denied) = claude_model_access(&v);
        assert!(allowed.contains(&"claude-fable-5-1".to_string()));
        assert!(allowed.contains(&"claude-opus-4-6".to_string()));
        assert!(!allowed.iter().any(|a| a.starts_with('-')));
        assert_eq!(denied, vec!["claude-mythos".to_string()]);
    }

    #[test]
    fn claude_model_access_on_empty_or_broken_json_is_empty_not_a_panic() {
        for v in [
            json!({}),
            Value::Null,
            json!({"additionalModelOptionsCache": "not-an-array"}),
        ] {
            let (allowed, denied) = claude_model_access(&v);
            assert!(allowed.is_empty());
            assert!(denied.is_empty());
        }
    }

    #[test]
    fn codex_model_access_excludes_hidden_and_sorts_by_priority() {
        let v = json!({
            "models": [
                {"slug": "gpt-6-astra", "visibility": "list", "priority": 2},
                {"slug": "gpt-6-sol", "visibility": "list", "priority": 1},
                {"slug": "gpt-reserve", "visibility": "hide", "priority": 0},
                {"slug": "-bad", "visibility": "list", "priority": 3}
            ]
        });
        let allowed = codex_model_access(&v);
        assert_eq!(
            allowed,
            vec!["gpt-6-sol".to_string(), "gpt-6-astra".to_string()]
        );
    }

    #[test]
    fn codex_default_model_reads_only_top_level_key() {
        let toml = "personality = \"pragmatic\"\nmodel = \"gpt-6-astra\"\n[profiles.other]\nmodel = \"gpt-5\"\n";
        assert_eq!(codex_default_model_from_toml(toml), "gpt-6-astra");
    }

    #[test]
    fn codex_default_model_absent_is_empty_not_invented() {
        assert_eq!(codex_default_model_from_toml(""), "");
        assert_eq!(
            codex_default_model_from_toml("[profiles.x]\nmodel = \"gpt-5\"\n"),
            ""
        );
    }

    #[test]
    fn antigravity_models_ignores_adornment_lines() {
        let tsv = "Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6\n";
        assert_eq!(
            antigravity_models(tsv),
            vec![
                "gemini-3.8-flash-high".to_string(),
                "claude-sonnet-4-6".to_string()
            ]
        );
    }

    #[test]
    fn antigravity_models_empty_output_is_empty() {
        assert!(antigravity_models("").is_empty());
        assert!(antigravity_models("Please sign in to continue.\n").is_empty());
    }

    #[test]
    fn antigravity_needs_login_detects_the_sign_in_prompt_and_empty_output() {
        assert!(antigravity_needs_login(""));
        assert!(antigravity_needs_login("Please sign in to continue.\n"));
        assert!(!antigravity_needs_login(
            "gemini-3.8-flash-high\tGemini 3.8 Flash\n"
        ));
    }

    /// Fixture captured verbatim from `agy models` on this machine
    /// (2026-09-22, session ya iniciada): header line + 14 tab-separated
    /// rows. `antigravity_models` must skip the header and keep every id.
    const AGY_MODELS_SIGNED_IN: &str = "Fetching available models...\n\
gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n\
gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\n\
gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n\
gemini-3.7-flash-high\tGemini 3.7 Flash (High)\n\
gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)\n\
gemini-3.7-flash-low\tGemini 3.7 Flash (Low)\n\
gemini-3.6-flash-high\tGemini 3.6 Flash (High)\n\
gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)\n\
gemini-3.6-flash-low\tGemini 3.6 Flash (Low)\n\
gemini-3.1-pro-high\tGemini 3.1 Pro (High)\n\
gemini-3.1-pro-low\tGemini 3.1 Pro (Low)\n\
claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n\
claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\n\
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n";

    /// Real "no session" output: a single `Error: ...` line, no tabs at all.
    const AGY_MODELS_SIGNED_OUT: &str =
        "Error: Please sign in to view available models. Launch the CLI without arguments to sign in.\n";

    #[test]
    fn antigravity_models_parses_the_real_signed_in_fixture() {
        let ids = antigravity_models(AGY_MODELS_SIGNED_IN);
        assert_eq!(ids.len(), 14);
        assert_eq!(ids[0], "gemini-3.8-flash-high");
        assert_eq!(ids[9], "gemini-3.1-pro-high");
        assert_eq!(ids[11], "claude-sonnet-4-6");
        assert_eq!(ids[13], "gpt-oss-120b-medium");
        assert!(!antigravity_needs_login(AGY_MODELS_SIGNED_IN));
    }

    #[test]
    fn antigravity_needs_login_on_the_real_signed_out_message() {
        assert!(antigravity_needs_login(AGY_MODELS_SIGNED_OUT));
        assert!(antigravity_models(AGY_MODELS_SIGNED_OUT).is_empty());
    }

    #[test]
    fn antigravity_account_kind_reads_the_last_auth_method() {
        assert_eq!(
            antigravity_account_kind("x authMethod=consumer y"),
            "Google (cuenta personal)"
        );
        assert_eq!(
            antigravity_account_kind("authMethod=business"),
            "Google (cuenta de empresa)"
        );
        assert_eq!(antigravity_account_kind(""), "");
    }
}
