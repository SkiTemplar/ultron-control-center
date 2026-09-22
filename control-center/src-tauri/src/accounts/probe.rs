// Disk / process I/O for "Cuentas y modelos". Everything that touches the
// filesystem or spawns a CLI lives here; the actual parsing is delegated to
// `super::parse` (pure, unit-tested with synthetic fixtures).
//
// Two speeds, matching the two Tauri commands in `mod.rs`:
//   - the `*_fast` functions only read files already on disk (cheap, used by
//     `accounts_report`, which must never block on a slow CLI);
//   - `spawn_codex_models` / `spawn_antigravity_models` launch a process and
//     are only ever called from `accounts_refresh_models`, capped at 15s.

use super::parse;
use super::{AccessKind, AccountEntry, ModelAccess};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Hard wall-clock cap for a CLI probe. `run_mcp_health_check` in
/// `commands/misc_sub/mcps.rs` and `ai_router::exec::cli_timeout` are the
/// other two places a CLI gets spawned from this codebase; 15s matches the
/// task's own budget and comfortably covers `agy models` (~2.2s measured)
/// and `codex debug models` (~0.3s measured) with headroom for a cold start.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

pub(super) fn user_home() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
}

fn json_at(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn env_key(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

// ---------------------------------------------------------------------------
// Claude — file reads only, no process ever spawned for this provider.
// ---------------------------------------------------------------------------

pub(super) fn claude_account(home: &Path) -> AccountEntry {
    let cred_path = home.join(".claude").join(".credentials.json");
    let profile_path = home.join(".claude.json");
    let cred = json_at(&cred_path);
    let profile = json_at(&profile_path);
    let has_session = cred.is_some();
    let api_key = env_key("ANTHROPIC_API_KEY");

    let mut account = String::new();
    let mut account_source = String::new();
    for (candidate, path) in [(&cred, &cred_path), (&profile, &profile_path)] {
        if account.is_empty() {
            if let Some((email, field)) = candidate.as_ref().and_then(parse::find_email) {
                account = email;
                account_source = format!("{} ({field})", path.display());
            }
        }
    }

    // Claude Code only actually BILLS `ANTHROPIC_API_KEY` when its 20-char
    // tail is in `customApiKeyResponses.approved` (`~/.claude.json`) — a key
    // that's merely present in the environment but sits in `.rejected` (or
    // was never evaluated) is inert: the CLI still falls back to the
    // subscription. `oauthAccount` is the profile's own evidence of a
    // connected account, used alongside `has_session` (the credentials file)
    // since either is real proof a subscription is available to fall back to.
    let profile_ref = profile.as_ref();
    let key_approved = api_key
        .as_ref()
        .is_some_and(|k| profile_ref.is_some_and(|p| parse::claude_api_key_approved(p, k)));
    let has_oauth_account = profile_ref.is_some_and(|p| p.get("oauthAccount").is_some());
    let signed_in = has_session || has_oauth_account;

    let mut warnings = Vec::new();
    let access = if key_approved {
        warnings.push(
            "ANTHROPIC_API_KEY está definida y APROBADA: Claude Code facturará por API en vez \
             de usar la suscripción. Bórrala si quieres la suscripción."
                .to_string(),
        );
        AccessKind::ApiKey
    } else if let Some(_key) = api_key.as_ref() {
        if signed_in {
            warnings.push(
                "ANTHROPIC_API_KEY presente pero rechazada en Claude Code: se usa la \
                 suscripción (la usan otras herramientas, p. ej. el AI Router)."
                    .to_string(),
            );
            AccessKind::Subscription
        } else {
            warnings.push(
                "ANTHROPIC_API_KEY está definida: Claude Code facturará por API en vez de usar \
                 la suscripción. Bórrala si quieres la suscripción."
                    .to_string(),
            );
            AccessKind::ApiKey
        }
    } else if signed_in {
        AccessKind::Subscription
    } else {
        AccessKind::NoAccess
    };
    if has_session && account.is_empty() {
        warnings.push(
            "la CLI de Claude no expone el correo de la cuenta en su credencial.".to_string(),
        );
    }

    let cred_type = cred
        .as_ref()
        .and_then(|c| c.pointer("/claudeAiOauth/subscriptionType"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let cred_tier = cred
        .as_ref()
        .and_then(|c| c.pointer("/claudeAiOauth/rateLimitTier"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let (plan, plan_source) = if !cred_type.is_empty() {
        (
            parse::claude_plan_label(cred_type, cred_tier),
            format!("{} (claudeAiOauth.subscriptionType)", cred_path.display()),
        )
    } else {
        let profile_type = profile
            .as_ref()
            .and_then(|p| p.pointer("/oauthAccount/organizationType"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let profile_tier = profile
            .as_ref()
            .and_then(|p| p.pointer("/oauthAccount/organizationRateLimitTier"))
            .and_then(Value::as_str)
            .unwrap_or("");
        (
            parse::claude_plan_label(profile_type, profile_tier),
            format!("{} (oauthAccount.organizationType)", profile_path.display()),
        )
    };

    AccountEntry {
        provider: "claude".into(),
        label: "Claude".into(),
        account,
        account_source: if account_source.is_empty() {
            cred_path.display().to_string()
        } else {
            account_source
        },
        access,
        key_tail: api_key.map(|v| parse::key_tail(&v)).unwrap_or_default(),
        plan,
        plan_source,
        warnings,
    }
}

pub(super) fn claude_model_access(home: &Path) -> ModelAccess {
    let path = home.join(".claude.json");
    let v = json_at(&path).unwrap_or(Value::Null);
    let (allowed, denied) = parse::claude_model_access(&v);
    ModelAccess {
        provider: "claude".into(),
        allowed,
        denied,
        default_model: String::new(),
        source: path.display().to_string(),
        at: now_rfc3339(),
    }
}

// ---------------------------------------------------------------------------
// Codex — file reads for the report; `codex debug models` only on refresh.
// ---------------------------------------------------------------------------

/// Codex's `auth.json` carries the email and the plan claim inside the SAME
/// `id_token` JWT (nested at `tokens.id_token`, or bare `id_token` on older
/// CLI versions) — there is no separate plain-text email field. Returns
/// `(email, source, plan_claim)`.
fn codex_email_and_plan(auth: &Value) -> (String, String, Option<String>) {
    if let Some((email, field)) = parse::find_email(auth) {
        return (email, field, None);
    }
    for key in ["id_token", "tokens"] {
        let node = auth.get(key);
        let token = node
            .and_then(Value::as_str)
            .or_else(|| node?.get("id_token")?.as_str());
        let Some(token) = token else { continue };
        let plan = parse::codex_plan_from_jwt(token);
        if let Some(email) = parse::email_from_jwt(token) {
            return (email, format!("{key} (id_token)"), plan);
        }
        if plan.is_some() {
            return (String::new(), String::new(), plan);
        }
    }
    (String::new(), String::new(), None)
}

pub(super) fn codex_account(home: &Path) -> AccountEntry {
    let auth_path = home.join(".codex").join("auth.json");
    let auth = json_at(&auth_path).unwrap_or(Value::Null);
    let has_session = auth_path.exists();
    let (account, account_source, plan_claim) = codex_email_and_plan(&auth);
    let api_key = env_key("OPENAI_API_KEY");

    let mut warnings = Vec::new();
    if has_session && account.is_empty() {
        warnings
            .push("la CLI de Codex no expone el correo de la cuenta en su credencial.".to_string());
    }
    if has_session && api_key.is_some() {
        warnings.push(
            "hay sesión de ChatGPT Y una OPENAI_API_KEY definida: Codex usa la sesión, pero \
             cualquier otra herramienta que lea esa variable facturará por API."
                .to_string(),
        );
    }
    let access = if has_session {
        AccessKind::Subscription
    } else if api_key.is_some() {
        AccessKind::ApiKey
    } else {
        AccessKind::NoAccess
    };

    let (plan, plan_source) = match plan_claim {
        Some(p) => (
            parse::codex_plan_label(&p),
            format!("{} (id_token: chatgpt_plan_type)", auth_path.display()),
        ),
        None => (String::new(), String::new()),
    };

    AccountEntry {
        provider: "codex".into(),
        label: "Codex (ChatGPT)".into(),
        account,
        account_source: if account_source.is_empty() {
            auth_path.display().to_string()
        } else {
            format!("{} ({account_source})", auth_path.display())
        },
        access,
        key_tail: api_key.map(|v| parse::key_tail(&v)).unwrap_or_default(),
        plan,
        plan_source,
        warnings,
    }
}

pub(super) fn codex_model_access_from_disk(home: &Path) -> ModelAccess {
    let cache_path = home.join(".codex").join("models_cache.json");
    let config_path = home.join(".codex").join("config.toml");
    let allowed = json_at(&cache_path)
        .map(|v| parse::codex_model_access(&v))
        .unwrap_or_default();
    let default_model = std::fs::read_to_string(&config_path)
        .ok()
        .map(|t| parse::codex_default_model_from_toml(&t))
        .unwrap_or_default();
    ModelAccess {
        provider: "codex".into(),
        allowed,
        denied: Vec::new(),
        default_model,
        source: cache_path.display().to_string(),
        at: now_rfc3339(),
    }
}

/// Asks `codex debug models` to refresh `models_cache.json`, then re-reads
/// it from disk. Does not fail the whole report if the CLI is missing or the
/// call errors — the on-disk cache (possibly stale, possibly absent) is
/// still a valid, explicit answer.
pub(super) fn refresh_codex_models(home: &Path) -> ModelAccess {
    let _ = spawn_and_wait("codex", &["debug", "models"], PROBE_TIMEOUT);
    codex_model_access_from_disk(home)
}

// ---------------------------------------------------------------------------
// Antigravity — no session file exists anywhere on disk (verified); the only
// source is the CLI itself, so this provider has NO fast path.
// ---------------------------------------------------------------------------

/// `agy` on Windows is a WinGet "link" shim that is not always on PATH (this
/// machine: confirmed absent from PATH but present at the WinGet Links
/// folder). Resolution order: PATH first (covers machines where it IS on
/// PATH, and any non-Windows install), then the WinGet Links fallback the
/// task calls out explicitly.
fn resolve_agy_binary() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let resolved = crate::ai_router::exec::resolve_windows_cli_program("agy");
        if resolved != "agy" {
            return Some(PathBuf::from(resolved));
        }
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            let candidate = PathBuf::from(local_app_data)
                .join("Microsoft")
                .join("WinGet")
                .join("Links")
                .join("agy.exe");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        None
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Non-Windows: rely on PATH resolution done by `std::process::Command`
        // itself (no `.cmd`/WinGet shim concept off Windows).
        Some(PathBuf::from("agy"))
    }
}

fn spawn_and_wait(program: &str, args: &[&str], timeout: Duration) -> Option<String> {
    #[cfg(target_os = "windows")]
    let resolved = crate::ai_router::exec::resolve_windows_cli_program(program);
    #[cfg(not(target_os = "windows"))]
    let resolved = program.to_string();

    let mut cmd = std::process::Command::new(&resolved);
    cmd.args(args);
    let output = crate::ai_router::exec::run_with_timeout(cmd, timeout, None).ok()?;
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Whether `agy` is installed anywhere this module can find it (PATH or the
/// WinGet Links fallback). Does not imply a signed-in session.
pub(super) fn antigravity_installed() -> bool {
    resolve_agy_binary().is_some()
}

/// Runs `agy models` and returns its raw stdout, or `None` if the binary
/// can't be found or the call fails/times out.
pub(super) fn spawn_antigravity_models() -> Option<String> {
    let binary = resolve_agy_binary()?;
    let mut cmd = std::process::Command::new(&binary);
    cmd.arg("models");
    let output = crate::ai_router::exec::run_with_timeout(cmd, PROBE_TIMEOUT, None).ok()?;
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Last `max` bytes of a file as text. Antigravity's CLI log grows
/// unbounded; only the tail (most recent session) is ever relevant.
fn read_tail(path: &Path, max: u64) -> String {
    let Ok(data) = std::fs::read(path) else {
        return String::new();
    };
    let start = data
        .len()
        .saturating_sub(usize::try_from(max).unwrap_or(usize::MAX));
    String::from_utf8_lossy(&data[start..]).into_owned()
}

pub(super) fn antigravity_account(home: &Path) -> AccountEntry {
    let installed = antigravity_installed();
    let mut warnings = Vec::new();
    if !installed {
        warnings.push(
            "Antigravity no está instalada o no se encuentra su binario. Instálala desde \
             antigravity.google."
                .to_string(),
        );
    }
    let log = read_tail(
        &home.join(".gemini").join("antigravity-cli").join("cli.log"),
        64 * 1024,
    );
    let plan = parse::antigravity_account_kind(&log);
    AccountEntry {
        provider: "antigravity".into(),
        label: "Antigravity (agy)".into(),
        // Deliberately empty: no file on disk exposes which account is
        // signed in (verified on this machine), and `agy models`'s stdout
        // never carries an email either.
        account: String::new(),
        access: if installed {
            AccessKind::Subscription
        } else {
            AccessKind::NoAccess
        },
        account_source: if installed {
            "agy (la CLI no expone con qué cuenta se ha iniciado sesión)".into()
        } else {
            "agy no encontrada".into()
        },
        key_tail: String::new(),
        plan,
        plan_source: if log.is_empty() {
            String::new()
        } else {
            "antigravity-cli/cli.log (authMethod)".into()
        },
        warnings,
    }
}

/// Live probe (spawns `agy models`, capped at [`PROBE_TIMEOUT`]). Only
/// called from `accounts_refresh_models`.
pub(super) fn refresh_antigravity_models() -> (ModelAccess, bool) {
    let Some(stdout) = spawn_antigravity_models() else {
        return (
            ModelAccess {
                provider: "antigravity".into(),
                source: "agy no encontrada o no respondió".into(),
                at: now_rfc3339(),
                ..Default::default()
            },
            false,
        );
    };
    let needs_login = parse::antigravity_needs_login(&stdout);
    let allowed = parse::antigravity_models(&stdout);
    (
        ModelAccess {
            provider: "antigravity".into(),
            allowed,
            denied: Vec::new(),
            default_model: String::new(),
            source: "agy models".into(),
            at: now_rfc3339(),
        },
        needs_login,
    )
}
