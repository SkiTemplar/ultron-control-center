// "Cuentas y modelos" — Settings section for the AI CLIs installed on this
// machine (claude, codex, antigravity). READ-ONLY and informational: this
// module never selects a model or changes routing (`ai_router::store` is
// untouched). It exists so the user can tell, at a glance, which account is
// signed in to each CLI, whether a stray env var is about to bill an API
// instead of using the subscription, and which model ids that subscription
// actually unlocks.
//
// WHAT IS READ AND WHAT IS NOT (read this before touching a probe):
//   * claude  — `~/.claude.json` (`additionalModelOptionsCache` is what the
//     server offers THIS account; `modelAccessCache` carries explicit
//     denials) plus, from the credentials file, ONLY `subscriptionType` and
//     `rateLimitTier`. No token from either file is ever read into a
//     variable that leaves `probe::claude_account`.
//   * codex — `~/.codex/models_cache.json` (the server's per-account
//     catalog) plus the `chatgpt_plan_type` claim decoded from the
//     `id_token` JWT WITHOUT verifying its signature — used only to display
//     a plan word, never to authorize anything. The token string itself is
//     never returned or logged.
//   * antigravity — `agy models` is the ONLY source; no session file exists
//     on disk for this CLI (verified on this machine: neither
//     `~/.antigravity` nor the AppData `agy` folder hold one).
//
// DEGRADATION IS MANDATORY: a missing CLI, a signed-out session, or a
// corrupt JSON file must produce an explicit state in the UI, never an
// empty section or a Tauri command that returns an error. See `AccessKind`
// and `AccountEntry::warnings`.

mod parse;
mod probe;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// How a provider is currently being accessed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccessKind {
    /// Logged-in session (subscription). Does not spend API credit.
    Subscription,
    /// API key: billed per token.
    ApiKey,
    /// Neither a session nor a key.
    #[default]
    NoAccess,
}

/// One CLI provider's account state, as shown in the UI.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AccountEntry {
    pub provider: String,
    pub label: String,
    /// Email or account identifier. Empty when the CLI doesn't expose one —
    /// that is a valid answer, never guessed.
    pub account: String,
    /// File + field (or CLI command) the account/email came from, so the
    /// user can verify it by hand.
    pub account_source: String,
    pub access: AccessKind,
    /// Last 4 characters of an API key, when `access == ApiKey`. Never more.
    pub key_tail: String,
    /// Human plan label ("Claude Max 5x", "ChatGPT Plus"). Empty = unknown,
    /// which is honest — no CLI here has a command that states it plainly.
    pub plan: String,
    pub plan_source: String,
    pub warnings: Vec<String>,
}

/// What a provider's subscription/session currently allows.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ModelAccess {
    pub provider: String,
    pub allowed: Vec<String>,
    pub denied: Vec<String>,
    /// Codex only: the `model =` key from `config.toml`.
    pub default_model: String,
    pub source: String,
    /// RFC 3339 timestamp of the probe.
    pub at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AccountsReport {
    pub accounts: Vec<AccountEntry>,
    pub models: Vec<ModelAccess>,
    /// Distinct emails found across providers, in order of first appearance.
    pub distinct_emails: Vec<String>,
    /// System-wide warnings (e.g. more than one distinct email connected).
    pub warnings: Vec<String>,
}

// ---------------------------------------------------------------------------
// Disk cache for the antigravity model list (the only provider that needs a
// process spawn to answer at all) — `accounts_report` reads this cache
// instead of ever spawning `agy`; only `accounts_refresh_models` writes it.
// ---------------------------------------------------------------------------

const MODELS_CACHE_FILE: &str = "models-cache.json";

fn accounts_cache_dir() -> Option<PathBuf> {
    crate::ultron_root()
        .ok()
        .map(|r| r.join("cockpit").join("accounts"))
}

fn read_antigravity_cache() -> ModelAccess {
    accounts_cache_dir()
        .and_then(|dir| std::fs::read_to_string(dir.join(MODELS_CACHE_FILE)).ok())
        .and_then(|text| serde_json::from_str::<ModelAccess>(&text).ok())
        .unwrap_or_else(|| ModelAccess {
            provider: "antigravity".into(),
            source: "sin sondear todavía — pulsa «Actualizar modelos»".into(),
            ..Default::default()
        })
}

fn write_antigravity_cache(models: &ModelAccess) {
    let Some(dir) = accounts_cache_dir() else {
        return;
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    if let Ok(text) = serde_json::to_string_pretty(models) {
        let _ = std::fs::write(dir.join(MODELS_CACHE_FILE), text);
    }
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

fn distinct_emails(accounts: &[AccountEntry]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for a in accounts {
        let email = a.account.trim();
        if email.is_empty() || !email.contains('@') {
            continue;
        }
        if !out.iter().any(|e| e.eq_ignore_ascii_case(email)) {
            out.push(email.to_string());
        }
    }
    out
}

fn assemble(accounts: Vec<AccountEntry>, models: Vec<ModelAccess>) -> AccountsReport {
    let emails = distinct_emails(&accounts);
    let mut warnings = Vec::new();
    if emails.len() > 1 {
        warnings.push(format!(
            "Hay {} correos distintos conectados ({}). Comprueba cuál usa cada proveedor antes \
             de trabajar.",
            emails.len(),
            emails.join(", ")
        ));
    }
    AccountsReport {
        accounts,
        models,
        distinct_emails: emails,
        warnings,
    }
}

/// Fast path: file reads only, never spawns a process. Antigravity's model
/// list comes from the on-disk cache (possibly empty on first run).
fn build_report_fast() -> AccountsReport {
    let home = probe::user_home();
    let accounts = vec![
        probe::claude_account(&home),
        probe::codex_account(&home),
        probe::antigravity_account(&home),
    ];
    let models = vec![
        probe::claude_model_access(&home),
        probe::codex_model_access_from_disk(&home),
        read_antigravity_cache(),
    ];
    assemble(accounts, models)
}

/// Slow path: re-probes codex (`codex debug models`, cheap) and antigravity
/// (`agy models`, the only source for that provider), each capped at 15s
/// inside `probe`. Persists the antigravity result so the next
/// `accounts_report` doesn't have to spawn anything.
fn build_report_refreshed() -> AccountsReport {
    let home = probe::user_home();
    let mut accounts = vec![
        probe::claude_account(&home),
        probe::codex_account(&home),
        probe::antigravity_account(&home),
    ];
    let (antigravity_models, needs_login) = probe::refresh_antigravity_models();
    if needs_login {
        if let Some(entry) = accounts.iter_mut().find(|a| a.provider == "antigravity") {
            entry.access = AccessKind::NoAccess;
            entry
                .warnings
                .push("sin sesión: ejecuta `agy` en una terminal para iniciar sesión.".to_string());
        }
    }
    write_antigravity_cache(&antigravity_models);

    let models = vec![
        probe::claude_model_access(&home),
        probe::refresh_codex_models(&home),
        antigravity_models,
    ];
    assemble(accounts, models)
}

// ---------------------------------------------------------------------------
// Public entry points — sync, blocking. The `#[tauri::command]` wrappers
// live in `commands/misc_sub/accounts.rs` (v15.4 convention: business logic
// in the domain module, thin async wrapper in `commands/`) and are
// responsible for the `spawn_blocking` hop.
// ---------------------------------------------------------------------------

/// Fast, read-only report: file reads only, no process spawned. Safe to call
/// every time the Settings section mounts.
#[must_use]
pub fn report() -> AccountsReport {
    build_report_fast()
}

/// "Actualizar modelos" button: re-probes codex and antigravity via their
/// CLIs (15s cap each, see `probe::PROBE_TIMEOUT`) and refreshes the on-disk
/// cache. BLOCKING — callers must run this off the async runtime.
#[must_use]
pub fn refresh_models() -> AccountsReport {
    build_report_refreshed()
}

#[cfg(test)]
mod manual_verification {
    use super::*;

    /// Not part of CI (`#[ignore]`): runs the REAL report against whatever
    /// CLIs are installed on the machine running the test, and prints it
    /// with every email masked to its first character (`r***@dominio`).
    /// Run explicitly with:
    ///   cargo test --features qdrant -p control-center --lib \
    ///     accounts::manual_verification::print_real_report_masked -- --ignored --nocapture
    fn mask(email: &str) -> String {
        match email.split_once('@') {
            Some((user, domain)) if !user.is_empty() => {
                format!("{}***@{domain}", &user[..1])
            }
            _ => String::new(),
        }
    }

    #[test]
    #[ignore = "hits this machine's real CLI config files/binaries — run manually"]
    fn print_real_report_masked() {
        let r = report();
        println!("--- accounts::report() (correos enmascarados) ---");
        for a in &r.accounts {
            println!(
                "[{}] label={:?} account={:?} access={:?} plan={:?} plan_source={:?} key_tail={:?} warnings={:?}",
                a.provider,
                a.label,
                mask(&a.account),
                a.access,
                a.plan,
                a.plan_source,
                a.key_tail,
                a.warnings,
            );
        }
        for m in &r.models {
            println!(
                "[{}] allowed={} denied={} default_model={:?} source={:?}",
                m.provider,
                m.allowed.len(),
                m.denied.len(),
                m.default_model,
                m.source,
            );
        }
        println!(
            "distinct_emails={} warnings={:?}",
            r.distinct_emails.len(),
            r.warnings
        );
    }
}
