// ULTRON Control Center — Tauri backend
//
// v15.4 architectural split: every `#[tauri::command]` wrapper lives under
// `commands/<group>.rs` grouped by domain. This file owns runtime plumbing
// only — module declarations, the `ultron_root` helper, plugin setup,
// hotkey + tray registration, and the `generate_handler!` dispatcher.
//
// Adding a new command:
//   1. Implement the inner logic in the matching domain module
//      (`crate::projects`, `crate::skills`, ...).
//   2. Add a thin `#[tauri::command] pub async fn` wrapper to the matching
//      file in `commands/`.
//   3. Reference it in the grouped `generate_handler!` block below.
//
// Mejora futura (card kanban f2-comandos-sin-caller): tauri-specta para
// generar bindings.ts tipados desde las firmas de comandos.

mod activity_timeline;
mod agent_orchestration;
mod agents;
mod ai_router;
mod alerts_admin;
mod auth;
mod backup_status;
mod batches;
mod batches_queue;
mod button_prompts;
mod claude_sessions;
mod commands_registry;
mod cost_watchdog;
mod detach;
mod diagnostics_native;
mod env_keys;
mod features;
#[cfg(feature = "finance")]
mod finance;
mod hooks_admin;
mod hotkeys;
mod in_app_shortcuts;
mod installed_apps;
mod instructions;
mod kanban;
mod kg;
mod library;
mod logs;
mod maintenance;
mod mcps;
pub mod memory; // MemoryStore trait + adapters (KIRKARDO 21)
mod migration;
mod notes;
pub mod orchestrator; // Auto-routing #7 — intent -> workflow -> agent -> memory
mod plans;
mod plugins_info;
mod project_agents;
mod project_context;
mod project_hotkeys;
mod projects;
mod proxy;
mod pty;
pub mod qdrant;
mod rules;
pub mod serve; // ultron-memory serve — persistent E5-warm orchestrator daemon
mod sessions;
mod sessions_tags;
mod settings;
mod skills;
mod system;
mod tabs;
#[cfg(test)]
mod test_support;
mod toast_emit;
mod tray;
mod update_checker;
mod usage;
mod workflow_loader;
mod workflow_runs;

pub mod commands;

use std::path::PathBuf;

use tauri::{Emitter, Manager};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

// ---------------------------------------------------------------------------
// Shared helpers used across command groups
// ---------------------------------------------------------------------------

/// Absolute path to `~/.ultron`. Exposed at crate level so any command
/// group can resolve ULTRON-rooted paths without re-implementing the
/// HOME lookup.
pub(crate) fn ultron_root() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|h| h.join(".ultron"))
        .ok_or_else(|| "No HOME dir".to_string())
}

/// Show / hide the main webview window. Bound to the user's main toggle
/// hotkey (default Ctrl+Alt+U) via the global-shortcut plugin handler.
fn toggle_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        match window.is_visible() {
            Ok(true) => {
                let _ = window.hide();
            }
            _ => {
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/// Initialise the global `tracing` subscriber once for the GUI process.
///
/// cat15 observability: structured logging app-wide. Honours `RUST_LOG`
/// (e.g. `RUST_LOG=control_center=debug,ai_router=trace`); defaults to `info`
/// when unset. `try_init` is used so a second call (tests, re-entry) is a
/// no-op instead of a panic, and so a sidecar that already installed a
/// subscriber is never clobbered.
pub fn init_tracing() {
    init_tracing_inner(false);
}

/// Same as [`init_tracing`] but writes to **stderr**, leaving stdout clean.
///
/// The `ultron-memory` / `ultron-embed` sidecars stream their JSON result on
/// stdout (the IPC channel the Node hooks parse); trace output must therefore
/// go to stderr or it would corrupt that channel. Sidecars call this from
/// their `main()`.
pub fn init_tracing_stderr() {
    init_tracing_inner(true);
}

fn init_tracing_inner(to_stderr: bool) {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let builder = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(true);
    if to_stderr {
        let _ = builder.with_writer(std::io::stderr).try_init();
    } else {
        let _ = builder.try_init();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();

    // Load .env files so users can store provider API keys in dotfiles
    // instead of exporting to the shell. Order: ~/.ultron/.env (preferred),
    // ~/.ultron/control-center/.env, then cwd/.env. First hit wins per key
    // (dotenvy::from_filename does not override pre-existing env vars).
    if let Some(home) = dirs::home_dir() {
        let _ = dotenvy::from_filename(home.join(".ultron").join(".env"));
        let _ = dotenvy::from_filename(home.join(".ultron").join("control-center").join(".env"));
    }
    let _ = dotenvy::dotenv();

    // Headless mode: when invoked with --run-diagnostic, run all checks,
    // persist to ~/.ultron/cockpit/diagnostics/<ts>.json, emit alert if
    // severity >= error, and exit without UI. Used by the daily
    // ULTRON-Daily-Diagnostic scheduled task (see commands/diagnostics_native).
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--run-diagnostic") {
        let report = diagnostics_native::run_full_diagnostic_native();
        let _ = persist_headless(&report);
        if matches!(report.max_severity, diagnostics_native::Severity::Error) {
            let _ = emit_alert_headless(&report);
        }
        std::process::exit(0);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        // v15.3 auto-updater: the plugin reads `plugins.updater.endpoints`
        // and `plugins.updater.pubkey` from tauri.conf.json and exposes the
        // JS-side `check()` / `downloadAndInstall()` API used by Settings
        // -> App lifecycle -> "Check for updates". The companion process
        // plugin exposes `relaunch()` for the post-install restart prompt.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--from-autostart"]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        if project_hotkeys::handle_shortcut(app, shortcut, event.state()) {
                            return;
                        }
                        toggle_window(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            // -- misc / system status --
            commands::misc::ultron_root_str,
            commands::misc::home_dir_str,
            commands::misc::instruction_path,
            commands::misc::claude_usage,
            // -- external editor (v2.6 Library redesign) --
            commands::external_editor::open_in_vscode,
            commands::external_editor::read_text_file,
            // -- alerts / changelog --
            commands::alerts::read_alerts,
            commands::alerts::delete_alert_entries,
            commands::alerts::read_changelog,
            commands::alerts::record_ui_alert,
            // -- MCPs --
            commands::mcps::list_mcps,
            commands::mcps::run_mcp_health_check,
            commands::mcps::add_mcp,
            commands::mcps::update_mcp,
            commands::mcps::delete_mcp,
            commands::mcps::generate_mcp_from_prompt,
            commands::mcps::mcp_ping,
            commands::mcps::mcp_set_disabled,
            // -- skills --
            commands::skills::list_skills,
            commands::skills::list_skills_legacy,
            commands::skills::skill_toggle,
            commands::skills::skills_bulk_toggle,
            commands::skills::update_skill_md,
            // -- agents --
            commands::agents::list_agents,
            commands::agents::update_agent_md,
            commands::agents::agent_toggle,
            commands::agents::agents_bulk_toggle,
            commands::agents::list_delegations,
            // -- rules --
            commands::rules::rules_list,
            commands::rules::rules_write,
            // -- commands registry (Library Commands tab — v2.5) --
            commands::commands_registry::list_all_slash_commands,
            // -- maintenance / lifecycle --
            commands::maintenance::list_maintenance_commands,
            commands::maintenance::run_maintenance_command,
            commands::maintenance::run_backup_now,
            commands::maintenance::run_app_lifecycle,
            update_checker::check_for_updates,
            // -- projects + launcher --
            commands::projects::open_project_in_ide,
            commands::projects::list_projects,
            commands::projects::open_project,
            commands::projects::scan_projects,
            commands::projects::touch_project,
            commands::projects::create_project,
            commands::projects::update_project,
            commands::projects::delete_project,
            commands::projects::set_default_provider,
            commands::projects::add_launcher_item,
            commands::projects::remove_launcher_item,
            commands::projects::launch_item,
            commands::projects::launch_all_items,
            // -- Qdrant status/embed (recall_semantic retired: legacy 384d path, Ola 0) --
            // -- FINANCE: native read-only dashboard of the Bank/finanzas project --
            // Requires --features finance (local-only; finance.rs excluded from public repo).
            #[cfg(feature = "finance")]
            finance::finance_overview,
            #[cfg(feature = "finance")]
            finance::finance_sync,
            #[cfg(feature = "finance")]
            finance::finance_open_setup,
            // -- MEMORY CORE: health only (recall_hybrid retired Ola 0; memory_health still used by MemoryStatusCard) --
            commands::memory::memory_health,
            // -- MEMORY KERNEL Fase A3: one-shot ETL migration --
            // -- MEMORY KERNEL Fase B: unified hybrid recall + dense reindex --
            // -- MEMORY KERNEL: Memory Inbox + governance + Retrieval Inspector --
            commands::memory::memory_inbox_list,
            commands::memory::memory_candidate_approve,
            commands::memory::memory_inbox_approve_all,
            // Auto-approve policy: persisted toggle + guarded bulk promote of clean ones.
            commands::memory::memory_auto_approve_get,
            commands::memory::memory_auto_approve_set,
            commands::memory::memory_inbox_approve_clean,
            commands::memory::memory_candidate_reject,
            commands::memory::memory_candidate_edit,
            commands::memory::memory_item_deprecate,
            // H4: verifiable forget — permanent hard delete (SQLite + Qdrant + audit)
            commands::memory::memory_forget,
            // Bulk-deprecate active items by type (purge bloat, e.g. codebase_fact)
            // FRENTE 5: Memory Browser — paginated list + bulk deprecate by type
            commands::memory::memory_items_list,
            commands::memory::memory_items_deprecate_by_type,
            commands::memory::memory_item_pin,
            commands::memory::memory_item_unpin,
            commands::memory::memory_stats,
            // -- MEMORY KERNEL: Session Resume (minimal bounded context) --
            // -- AUTO-ROUTING #7: agent/skill catalog index + semantic route --
            // -- ORCHESTRATOR "Ultron": prompt -> intent -> workflow -> agent -> memory --
            orchestrator::orchestrate_prompt,
            // -- Live Session Monitor: actividad en vivo (routing + orquestacion + agentes) --
            commands::live_session::live_session_feed,
            // -- Gestor multi-sesion: lee ~/.claude/projects/*.jsonl (estado/modelo/context%) --
            commands::session_manager::list_active_sessions,
            // -- batches (.bat / .ps1 runner desde ~/.ultron/batches/) --
            commands::batches::list_batches,
            commands::batches::execute_batch,
            commands::batches::delete_batch_single,
            commands::batches::clear_all_batches,
            commands::batches::batches_list_queue,
            commands::batches::batches_requeue,
            commands::batches::batches_dismiss_queue,
            // -- project detach / reattach (ventanas independientes) --
            commands::detach::detach_project_window,
            // -- OpenGL/vcpkg project scaffolder (v2.5.2 — replaces crear_proyecto.bat) --
            commands::opengl_project::create_opengl_project,
            // -- global notes (memory context pipeline) --
            commands::notes::notes_list_global,
            commands::notes::notes_load_global,
            commands::notes::notes_save_global,
            commands::notes::notes_delete_global,
            // -- local Knowledge Graph editor (Control Center-owned, v2.6 fb-047) --
            // kg commands des-registrados (Fase 3 pendiente): lógica conservada en commands/memory/memory_graph.rs y src/kg.rs
            // -- memory graph (unified search + tree snapshot) --
            // memory_graph commands des-registrados (Fase 3 pendiente): lógica conservada en commands/memory/memory_graph.rs
            // -- sessions --
            commands::sessions::spawn_session,
            commands::sessions::list_claude_sessions,
            commands::sessions::list_workspaces,
            // -- session auto-tags (P1 2026-05-27) --
            sessions_tags::sessions_bulk_auto_tag,
            // -- settings + backup --
            commands::settings::settings_read,
            commands::settings::settings_save,
            commands::settings::purge_legacy_autostart,
            commands::settings::get_backup_root,
            commands::settings::set_backup_root,
            commands::settings::backup_status,
            commands::settings::get_backup_sources,
            commands::settings::set_backup_sources,
            commands::settings::get_backup_schedule,
            commands::settings::set_backup_schedule,
            // -- API keys (Windows setx, User scope) --
            commands::settings::set_env_vars_keys,
            commands::settings::get_env_keys_status,
            // -- GitHub token (persiste en ~/.ultron/.env via dotenvy) --
            commands::settings::set_github_token,
            // -- system / scheduled tasks --
            // -- installed apps --
            commands::apps::list_installed_apps,
            commands::apps::open_app_folder,
            commands::apps::uninstall_app,
            commands::apps::categorize_apps_with_ai,
            // -- auth + lifecycle --
            commands::lifecycle::auth_status,
            commands::lifecycle::close_control_center,
            // -- diagnostics (native, P6) --
            commands::diagnostics_native::run_diagnostic_native,
            commands::diagnostics_native::analyze_diagnostic_with_ai,
            commands::diagnostics_native::diagnostic_history_list,
            commands::diagnostics_native::diagnostic_history_read,
            commands::diagnostics_native::diagnostic_schedule_get,
            commands::diagnostics_native::diagnostic_schedule_set,
            commands::diagnostics_native::diagnostics_run,
            // -- windows event log (system/diagnostics + dashboard crash card) --
            commands::event_log::event_log_recent,
            // -- plans --
            commands::plans::list_plans,
            commands::plans::patch_plan_status,
            commands::plans::add_plan,
            commands::plans::update_plan,
            commands::plans::delete_plan,
            commands::plans::clean_resolved_plans,
            commands::plans::auto_archive_resolved_plans,
            // -- hooks --
            commands::hooks::list_hooks,
            commands::hooks::add_hook,
            commands::hooks::update_hook,
            commands::hooks::toggle_hook,
            commands::hooks::delete_hook,
            commands::hooks::test_hook,
            commands::hooks::recent_hook_fires,
            commands::hooks::request_hook_via_ai,
            commands::hooks::hooks_last_fired,
            commands::hooks::analyze_hook_name,
            commands::hooks::bulk_analyze_hook_names,
            commands::hooks::get_hook_names_cache,
            commands::hooks::get_hook_descriptions,
            // -- plugin info (P7 + v2.2 multi-plugin) --
            commands::plugins_info::list_all_plugins,
            commands::plugins_info::uninstall_plugin_cache,
            // v2.9.5 — SHA-aware bulk update check + AI changelog summary
            commands::plugins_info::plugin_check_updates_bulk,
            commands::plugins_info::plugin_changelog_summary,
            // -- pty (embedded terminal, P3) --
            commands::pty::pty_spawn,
            commands::pty::pty_kill,
            commands::pty::pty_list,
            // -- library (P5 — GitHub search + install + per-project pin) --
            // v2.1: curated catalog feed. v2.2: live preview refresh.
            commands::library::library_search_github,
            commands::library::library_install_from_github,
            // v2.6.1: GitHub repo discovery for Catalog tab.
            commands::library::github_search_repos,
            commands::library::github_search_trending,
            commands::library::agent_create,
            commands::library::skill_create,
            commands::library::library_pin_agent,
            commands::library::library_unpin_agent,
            commands::library::library_list_pinned,
            // v2.6 (v27-f14): sibling-file listing for Skills/Agents detail.
            commands::library::list_skill_files,
            // v2.9.5: AI-driven install (P1 Library>Catalog)
            // v2.9.8: catalog compat analysis + bulk install (card-1779825112840)
            // FRENTE 7: analizar repo local + integrar al routing/memoria
            commands::library::analyze_local_repo,
            // -- git ops por proyecto --
            commands::projects::git_pull,
            commands::projects::git_push,
            commands::projects::git_init,
            commands::projects::git_fetch,
            commands::projects::git_repo_state,
            // micro GitHub Desktop: changed files, per-file diff, stage, commit, log
            commands::projects::git_changes,
            commands::projects::git_diff_file,
            commands::projects::git_stage,
            commands::projects::git_unstage,
            commands::projects::git_commit,
            commands::projects::git_log_full,
            commands::projects::codegraph_is_indexed,
            commands::projects::codegraph_summary,
            commands::projects::codegraph_init_project,
            // -- kanban (P4) --
            commands::kanban::kanban_load,
            commands::kanban::kanban_create_card,
            commands::kanban::kanban_update_card,
            commands::kanban::kanban_move_card,
            commands::kanban::kanban_delete_card,
            commands::kanban::kanban_dispatch_card,
            commands::kanban::kanban_archive_done,
            commands::kanban::kanban_list_archives,
            commands::kanban::kanban_load_archive,
            commands::kanban::kanban_add_column,
            commands::kanban::kanban_delete_column,
            commands::kanban::kanban_rename_column,
            commands::kanban::kanban_reorder_columns,
            // -- tabs (P4) --
            commands::tabs::tabs_load,
            commands::tabs::tabs_save,
            // -- button prompts catalog --
            commands::button_prompts::list_button_prompts,
            commands::button_prompts::update_button_prompt,
            commands::button_prompts::reset_button_prompt,
            // -- global hotkeys --
            commands::hotkeys::get_global_hotkey,
            commands::hotkeys::set_global_hotkey,
            // -- commands defined directly in their domain modules --
            in_app_shortcuts::get_in_app_shortcuts,
            features::read_features,
            features::save_features,
            // -- AI Router (zone -> provider routing, providers catalog, --
            // -- health checks, metrics, end-to-end zone test) --
            ai_router::ai_router_list_zones,
            ai_router::ai_router_save_zone,
            ai_router::ai_router_list_providers,
            ai_router::ai_router_health,
            ai_router::ai_router_metrics,
            ai_router::ai_router_usage_summary,
            // P1 2026-05-27: key-aware routing — validate keys + disabled list
            ai_router::ai_router_validate_keys,
            // -- quota watchdog (P0 2026-05-27 — 98% auto-fallback) --
            // -- proxy free-tier lifecycle (NVIDIA NIM via claude-code-proxy) --
            proxy::proxy_health,
            proxy::proxy_state_enabled,
            proxy::proxy_set_enabled,
            // -- workflow YAML composability + SQLite run history (KIRKARDO 23 P2) --
        ])
        .setup(|app| {
            // v2.13 -> v2.14 data migration (meta.json + features.json ensure).
            // Best-effort: a failure must never block startup.
            {
                let report = crate::migration::run_migrations_inner(env!("CARGO_PKG_VERSION"));
                if report.migrated {
                    tracing::info!(
                        from = %report.from_version,
                        to = %report.to_version,
                        "data migration applied: {}",
                        report.actions.join(" | ")
                    );
                }
            }

            // P4 migration: ensure every known project has a kanban.json.
            // Idempotent — no-op if files already exist.
            {
                if let Ok(projects) = crate::projects::list_projects_inner() {
                    let ids: Vec<String> = projects.iter().map(|p| p.id.clone()).collect();
                    if let Err(e) = crate::kanban::migrate_all_projects(&ids) {
                        tracing::error!(error = %e, "kanban migration failed");
                    }
                }
            }

            // KIRKARDO 23 P2: initialise the workflow-runs SQLite DB (WAL +
            // indices). Idempotent — no-op when table already exists.
            if let Err(e) = crate::workflow_runs::init_db() {
                tracing::error!(error = %e, "workflow_runs init_db failed");
            }

            // MEMORY KERNEL Fase A: initialise the canonical memory DB
            // (~/.ultron/brain.db): memory_items + memory_events +
            // memory_candidates + FTS5, and best-effort import of kg.jsonl.
            // This wiring was MISSING before — brain.db was born empty and the
            // "strong DB" stored nothing. Idempotent. Never panics.
            if let Err(e) = crate::memory::sqlite_store::SqliteStore::init() {
                tracing::error!(error = %e, "memory brain.db init failed");
            }

            // KIRKARDO 23 P2: migrate legacy workflows-old.json → YAML if present.
            crate::workflow_loader::migrate_legacy_json_if_present();

            // Persisted main toggle hotkey (Ctrl+Alt+U by default).
            let shortcut_handle = app.global_shortcut();
            let spec = hotkeys::load_hotkey_spec();
            let shortcut = hotkeys::parse_hotkey(&spec).unwrap_or_else(|e| {
                tracing::warn!(
                    hotkey = %spec, error = %e,
                    "persisted hotkey rejected — falling back to Ctrl+Alt+U"
                );
                Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyU)
            });
            if let Err(e) = shortcut_handle.register(shortcut) {
                tracing::error!(error = %e, "global shortcut register failed");
            }

            // Per-project hotkeys — user-defined in Settings → Project
            // hotkeys, persisted at ~/.ultron/cockpit/project-hotkeys.json.
            // (The legacy auto-registered Ctrl+Alt+1..9 set was removed in
            // v15.5.21 — it collided with AltGr on international keyboards.)
            if let Err(e) = project_hotkeys::register_custom_hotkeys(app.handle()) {
                tracing::error!(error = %e, "custom project hotkeys init failed");
            }

            // Tray + close-to-tray.
            if let Err(e) = tray::init_tray(app.handle()) {
                tracing::error!(error = %e, "tray init failed");
            }

            // Quota watchdog — polls quota-state.json every 60 s and emits
            // quota:updated / quota:critical / quota:reset events so the
            // frontend can update the Usage quota card and Sidebar dot.

            // MEMORY CORE D2 — Qdrant auto-launch.
            // Probes http://127.0.0.1:6333/healthz; if Qdrant is not running,
            // spawns the configured Qdrant binary detached (CREATE_NO_WINDOW).
            // Never panics — a missing exe is logged and boot continues.
            std::thread::spawn(|| {
                qdrant_auto_launch();
            });

            // Auto-warm the agent/skill catalog off the startup thread so skills
            // compete in the semantic router without a manual reindex. Best-effort:
            // errors are logged, never fatal (router falls back to whatever is
            // already indexed). Runs once per launch; the internal probe skips the
            // re-embed when the collection is already warm.
            tauri::async_runtime::spawn_blocking(|| {
                match crate::memory::catalog::maybe_warm_catalog() {
                    Ok((n, errs)) if n > 0 => {
                        tracing::info!(entities = n, errors = errs, "catalog warmed");
                    }
                    Ok(_) => {} // already warm — nothing to do
                    Err(e) => tracing::warn!(error = %e, "catalog warm skipped"),
                }
            });

            // v15.4.2 — fire a startup update check. We spawn it on a
            // background thread + sleep 6s so the webview has time to
            // paint and the event listener is wired before we emit.
            // Network failures stay silent (no banner on transient
            // errors); only a real `has_update == true` triggers
            // `update-available` on the frontend.
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(6));
                let info = update_checker::check_for_updates_inner();
                if info.has_update {
                    let _ = app_handle.emit("update-available", &info);
                }
            });

            Ok(())
        })
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // Matar el proxy al cerrar para no dejar :8082 huerfano.
                // Cubre el caso normal (cierre de ventana principal).
                let _ = proxy::proxy_stop_inner();
            }
        })
        .build(tauri::generate_context!())
        .expect("error building tauri application")
        .run(|_app, event| {
            // RunEvent::Exit cubre los casos que WindowEvent::Destroyed no
            // alcanza: Alt+F4 en ventana secundaria, kill desde el tray,
            // panic en el hilo principal, exit() desde cualquier comando.
            // Llamar proxy_stop_inner() es idempotente — si ya fue detenido
            // por on_window_event no hace nada.
            if let tauri::RunEvent::Exit = event {
                let _ = proxy::proxy_stop_inner();
            }
        });
}

// ---------------------------------------------------------------------------
// Qdrant auto-launch (MEMORY CORE D2)
// ---------------------------------------------------------------------------

/// Probe Qdrant at `http://127.0.0.1:6333/healthz`.  Returns `true` when
/// Qdrant responds with HTTP 2xx within the given timeout.
fn qdrant_is_running() -> bool {
    let Ok(client) = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
    else {
        return false;
    };
    client
        .get("http://127.0.0.1:6333/healthz")
        .send()
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// Attempt to spawn the bundled Qdrant binary detached with no console
/// window.  The executable path is read from `ULTRON_QDRANT_EXE` (its working
/// dir from `ULTRON_QDRANT_DIR`), falling back to a portable location under
/// `%USERPROFILE%\.ultron\qdrant-native\`.  Returns the child handle on
/// success, or logs and returns `None`.
#[cfg(target_os = "windows")]
fn spawn_qdrant_exe() -> Option<std::process::Child> {
    use std::os::windows::process::CommandExt;

    let home = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".to_string());
    let qdrant_exe = std::env::var("ULTRON_QDRANT_EXE")
        .unwrap_or_else(|_| format!(r"{home}\.ultron\qdrant-native\qdrant.exe"));
    let qdrant_dir = std::env::var("ULTRON_QDRANT_DIR")
        .unwrap_or_else(|_| format!(r"{home}\.ultron\qdrant-native"));
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    if !std::path::Path::new(&qdrant_exe).exists() {
        tracing::warn!(
            path = %qdrant_exe,
            "qdrant-autolaunch: exe not found — start Qdrant manually or set ULTRON_QDRANT_EXE"
        );
        return None;
    }

    match std::process::Command::new(&qdrant_exe)
        .current_dir(&qdrant_dir)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
    {
        Ok(child) => {
            tracing::info!(pid = child.id(), "qdrant-autolaunch: spawned");
            Some(child)
        }
        Err(e) => {
            tracing::error!(error = %e, "qdrant-autolaunch: spawn failed");
            None
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn spawn_qdrant_exe() -> Option<std::process::Child> {
    tracing::info!("qdrant-autolaunch: non-Windows platform — skipping");
    None
}

/// Background task: probe Qdrant, launch if down, re-probe to confirm.
fn qdrant_auto_launch() {
    if qdrant_is_running() {
        tracing::debug!("qdrant-autolaunch: already running — no action needed");
        return;
    }

    tracing::info!("qdrant-autolaunch: not running — attempting launch");
    let _child = spawn_qdrant_exe();

    // Give Qdrant time to bind the port before re-probing.
    std::thread::sleep(std::time::Duration::from_secs(4));

    if qdrant_is_running() {
        tracing::info!("qdrant-autolaunch: reachable at :6333");
    } else {
        tracing::warn!(
            "qdrant-autolaunch: still unreachable after launch — semantic recall unavailable"
        );
    }
}

// ---------------------------------------------------------------------------
// Headless --run-diagnostic helpers (P6).
// ---------------------------------------------------------------------------

fn persist_headless(report: &diagnostics_native::DiagnosticReport) -> std::io::Result<()> {
    let dir = ultron_root()
        .map(|p| p.join("cockpit").join("diagnostics"))
        .map_err(std::io::Error::other)?;
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{}.json", report.timestamp));
    let body =
        serde_json::to_vec_pretty(report).map_err(|e| std::io::Error::other(e.to_string()))?;
    std::fs::write(path, body)
}

fn emit_alert_headless(report: &diagnostics_native::DiagnosticReport) -> std::io::Result<()> {
    let path = ultron_root()
        .map(|p| p.join("cockpit").join("alerts.jsonl"))
        .map_err(std::io::Error::other)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    let line = serde_json::json!({
        "kind": "diagnostic",
        "severity": "error",
        "timestamp": report.timestamp,
        "summary": "Diagnostic flagged error severity",
    });
    writeln!(f, "{}", line)?;
    Ok(())
}
