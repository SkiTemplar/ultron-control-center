// ULTRON Control Center — AI Router backend.
//
// Owns zone -> (provider, model) routing decisions plus a thin health-check
// + test-invocation layer over each upstream provider. The frontend lives in
// `src/components/AIRouter/` and talks to the seven `#[tauri::command]`
// wrappers declared at the bottom of this file.
//
// Module layout:
//   types.rs     — All domain types, storage path helpers, free_tier_daily_limit
//   seed.rs      — Seed data (seed_providers, seed_zones)
//   store.rs     — File I/O, CLI cache, load/save helpers, key-status helpers
//   health.rs    — Health-check cache (30s TTL) + HTTP client
//   exec.rs      — Retry/backoff, CLI invocation (direct spawn, stdin for codex), call_cli
//   providers.rs — Per-provider HTTP wrappers, try_assignment_call, metrics,
//                  bump_metrics, apply_metric_sample, route, primary_model_for_zone
//   tests.rs     — 46 unit tests (cfg(test) only)
//
// NOTE: #[tauri::command] functions are declared in this file (mod.rs) rather
// than in a sub-module because Tauri's generate_handler! macro requires the
// command symbols and their generated companions (__cmd__*, __tauri_command_name_*)
// to be resolvable at the path used in lib.rs (`ai_router::ai_router_list_zones`).
// A `pub use sub::fn` forward only moves the function symbol — not the
// macro-generated companions — causing "could not find __cmd__*" errors.

pub(crate) mod exec;
pub(crate) mod health;
pub(crate) mod providers;
pub(crate) mod seed;
pub(crate) mod store;
pub(crate) mod types;

#[cfg(test)]
mod tests;

// ---------------------------------------------------------------------------
// Public re-exports — only what external callers (other crate modules + lib.rs)
// actually reference as `crate::ai_router::*`.
// ---------------------------------------------------------------------------

// `route` is called by other crate modules (hooks_admin, cost_watchdog, …).
// `primary_model_for_zone` lost its last production caller when
// `agent_orchestration::delegate::resolve_cheap_model` was retired
// (2026-09-14, kanban "comandos huérfanos"); kept as ai_router's documented
// "what model would zone X use" primitive — exercised today only by
// `ai_router_tests::basics`.
#[cfg_attr(not(test), allow(unused_imports))]
pub use providers::{primary_model_for_zone, route};

// CLI_CACHE — exposed pub so the test in tests.rs can evict entries via
// `crate::ai_router::CLI_CACHE.lock()`.
#[cfg(test)]
pub use store::CLI_CACHE;

// Types used directly in this file's Tauri command bodies.
use types::{KeyValidation, Provider, ProviderKind};

// ---------------------------------------------------------------------------
// validate_agent — checks that an agent file exists on disk.
// Kept here rather than in a sub-module so existing doc-references resolve.
// ---------------------------------------------------------------------------

/// Returns `true` if `agent_id` corresponds to a known agent file in the
/// agents directory (`~/.claude/agents/<agent_id>.md`).
#[allow(dead_code)] // referenced in sessions.rs doc comments; not called directly
pub fn validate_agent(agent_id: &str) -> bool {
    if agent_id.is_empty() {
        return false;
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    let agents_dir = std::path::Path::new(&home).join(".claude").join("agents");
    let path = agents_dir.join(format!("{}.md", agent_id));
    path.exists()
}

// ---------------------------------------------------------------------------
// Tauri commands — declared here so generate_handler! in lib.rs resolves
// `ai_router::ai_router_*` directly (macro-generated companions included).
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn ai_router_list_providers() -> Result<Vec<Provider>, String> {
    store::load_providers()
}

#[tauri::command]
pub fn ai_router_validate_keys() -> Result<Vec<KeyValidation>, String> {
    let providers = store::load_providers()?;
    let validations = providers
        .iter()
        .map(|p| {
            if p.kind == ProviderKind::Cli {
                let cmd = p.cli_command.as_deref().unwrap_or("");
                let installed = !cmd.is_empty() && store::detect_cli(cmd);
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
                        Some(format!("CLI '{}' not found on PATH. {}", cmd, install_hint))
                    },
                };
            }

            if p.kind == ProviderKind::Local || p.key_env_var.is_empty() {
                return KeyValidation {
                    provider_id: p.id.clone(),
                    provider_label: p.name.clone(),
                    has_key: true,
                    source: "local".to_string(),
                    warning: None,
                };
            }

            match std::env::var(&p.key_env_var) {
                Ok(v) if !v.trim().is_empty() && !store::looks_like_placeholder(&v) => {
                    KeyValidation {
                        provider_id: p.id.clone(),
                        provider_label: p.name.clone(),
                        has_key: true,
                        source: "env".to_string(),
                        warning: None,
                    }
                }
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
