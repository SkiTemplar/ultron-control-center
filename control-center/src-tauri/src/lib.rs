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
// TODO(v15.5): wire `tauri-specta` to auto-generate
// `frontend/src/lib/bindings.ts` from the command signatures so frontend
// invokes are type-checked.

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
mod codex_fallback;
mod commands_registry;
mod cost_watchdog;
mod decisions;
mod detach;
mod diagnostics_native;
mod ecc_memory;
mod env_keys;
mod features;
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
mod mem0;
pub mod memory; // MemoryStore trait + adapters (KIRKARDO 21)
mod memory_status;
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
mod recall;
mod rules;
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
mod work_sessions;
mod workdays;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
            commands::misc::list_logs,
            commands::misc::tail_log,
            commands::misc::list_instruction_folders,
            commands::misc::instruction_path,
            commands::misc::claude_usage,
            commands::misc::compute_activity_timeline,
            commands::misc::compute_cost,
            commands::misc::open_folder_in_vscode,
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
            // -- skills --
            commands::skills::list_skills,
            commands::skills::list_skills_legacy,
            commands::skills::skill_toggle,
            commands::skills::skills_bulk_toggle,
            commands::skills::read_skill_md,
            commands::skills::create_skill,
            commands::skills::update_skill_md,
            commands::skills::delete_skill,
            // -- agents --
            commands::agents::list_agents,
            commands::agents::list_agents_legacy,
            commands::agents::read_agent_md,
            commands::agents::create_agent,
            commands::agents::update_agent_md,
            commands::agents::delete_agent,
            commands::agents::agent_toggle,
            commands::agents::agents_bulk_toggle,
            commands::agents::list_delegations,
            commands::agents::agents_pinned_load,
            commands::agents::agents_pinned_save,
            commands::agents::delegate_task_to_agent,
            commands::agents::delegate_task_launch,
            commands::agents::list_agent_workflows,
            commands::agents::list_active_hooks,
            // -- rules --
            commands::rules::rules_list,
            commands::rules::rules_read,
            commands::rules::rules_write,
            // -- commands registry (Library Commands tab — v2.5) --
            commands::commands_registry::list_all_slash_commands,
            // -- maintenance / lifecycle --
            commands::maintenance::list_maintenance_commands,
            commands::maintenance::run_maintenance_command,
            commands::maintenance::run_backup_now,
            commands::maintenance::run_app_lifecycle,
            commands::maintenance::is_developer_install,
            update_checker::check_for_updates,
            // -- projects + launcher --
            commands::projects::open_project_in_ide,
            commands::projects::list_projects,
            commands::projects::open_project,
            commands::projects::scan_projects,
            commands::projects::create_project,
            commands::projects::update_project,
            commands::projects::delete_project,
            commands::projects::set_default_provider,
            commands::projects::add_launcher_item,
            commands::projects::remove_launcher_item,
            commands::projects::reorder_launcher_items,
            commands::projects::launch_item,
            commands::projects::launch_all_items,
            // -- Qdrant status/embed (recall_semantic retired: legacy 384d path, Ola 0) --
            qdrant::qdrant_status,
            qdrant::qdrant_embed_query,
            // -- FINANCE: native read-only dashboard of the Bank/finanzas project --
            finance::finance_overview,
            finance::finance_sync,
            finance::finance_open_setup,
            // -- MEMORY CORE: health only (recall_hybrid retired Ola 0; memory_health still used by MemoryStatusCard) --
            commands::memory::memory_health,
            // -- MEMORY KERNEL Fase A3: one-shot ETL migration --
            commands::memory::memory_migrate,
            // -- MEMORY KERNEL Fase B: unified hybrid recall + dense reindex --
            commands::memory::recall,
            commands::memory::recall_inspect,
            commands::memory::memory_reindex,
            // -- MEMORY KERNEL: Memory Inbox + governance + Retrieval Inspector --
            commands::memory::memory_inbox_list,
            commands::memory::memory_candidate_approve,
            commands::memory::memory_inbox_approve_all,
            commands::memory::memory_candidate_reject,
            commands::memory::memory_candidate_edit,
            commands::memory::memory_item_edit,
            commands::memory::memory_item_relabel,
            commands::memory::memory_item_deprecate,
            commands::memory::memory_item_quarantine,
            commands::memory::memory_do_not_use,
            // H4: verifiable forget — permanent hard delete (SQLite + Qdrant + audit)
            commands::memory::memory_forget,
            commands::memory::memory_item_history,
            commands::memory::memory_item_pin,
            commands::memory::memory_item_unpin,
            commands::memory::memory_stats,
            // -- MEMORY KERNEL: Session Resume (minimal bounded context) --
            commands::memory::session_resume,
            // -- AUTO-ROUTING #7: agent/skill catalog index + semantic route --
            commands::memory::catalog_reindex,
            commands::memory::catalog_reindex_skills,
            commands::memory::catalog_search,
            // -- ORCHESTRATOR "Ultron": prompt -> intent -> workflow -> agent -> memory --
            orchestrator::orchestrate_prompt,
            // -- batches (.bat / .ps1 runner desde ~/.ultron/batches/) --
            commands::batches::list_batches,
            commands::batches::execute_batch,
            commands::batches::delete_batch_single,
            commands::batches::cleanup_old_batches,
            commands::batches::clear_all_batches,
            commands::batches::batches_list_queue,
            commands::batches::batches_requeue,
            commands::batches::batches_dismiss_queue,
            commands::batches::batches_enqueue_command,
            // -- project detach / reattach (ventanas independientes) --
            commands::detach::detach_project_window,
            commands::detach::reattach_project_window,
            commands::detach::is_project_detached,
            // -- OpenGL/vcpkg project scaffolder (v2.5.2 — replaces crear_proyecto.bat) --
            commands::opengl_project::create_opengl_project,
            // -- global notes (memory context pipeline) --
            commands::notes::notes_list_global,
            commands::notes::notes_load_global,
            commands::notes::notes_save_global,
            commands::notes::notes_delete_global,
            // -- ECC local knowledge graph (read-only display) --
            commands::ecc_memory::ecc_memory_read,
            commands::ecc_memory::bootstrap_ecc_memory,
            // -- local Knowledge Graph editor (Control Center-owned, v2.6 fb-047) --
            commands::kg::kg_read_graph,
            commands::kg::kg_create_entities,
            commands::kg::kg_delete_entity,
            commands::kg::kg_add_observations,
            commands::kg::kg_create_relations,
            commands::kg::kg_delete_relation,
            commands::kg::kg_search_nodes,
            // -- mem0 --
            commands::mem0::mem0_status,
            commands::mem0::mem0_search,
            commands::mem0::mem0_add,
            commands::mem0::mem0_delete,
            commands::mem0::mem0_diagnostics,
            commands::mem0::mem0_test_connection,
            commands::mem0::mem0_list_all,
            // -- memory status (Memory tab redesign) --
            commands::memory_status::memory_status_mem0,
            commands::memory_status::memory_status_ecc,
            commands::memory_status::memory_status_graphify,
            commands::memory_status::memory_status_files,
            commands::memory_status::memory_sync_mem0_manual,
            commands::memory_status::memory_graphify_index,
            // -- memory graph (unified search + tree snapshot) --
            commands::memory_graph::memory_unified_search,
            commands::memory_graph::memory_tree_snapshot,
            // -- sessions --
            commands::sessions::spawn_session,
            commands::sessions::run_inline,
            commands::sessions::list_claude_sessions,
            commands::sessions::list_workspaces,
            // -- session auto-tags (P1 2026-05-27) --
            sessions_tags::sessions_tags_load,
            sessions_tags::sessions_auto_tag,
            sessions_tags::sessions_bulk_auto_tag,
            // -- session recall (per-project + global) --
            commands::recall::recall_last_session,
            commands::recall::recall_last_session_global,
            // -- workdays (jornadas de trabajo, v2.7 completo) --
            commands::workdays::create_workday,
            commands::workdays::start_workday,
            commands::workdays::pause_workday,
            commands::workdays::resume_workday,
            commands::workdays::complete_workday,
            commands::workdays::archive_workday,
            commands::workdays::list_workdays,
            commands::workdays::get_workday_detail,
            commands::workdays::link_session,
            commands::workdays::link_task,
            commands::workdays::get_workday_metrics,
            commands::workdays::list_templates,
            commands::workdays::save_template,
            commands::workdays::update_goal,
            commands::workdays::workday_list,
            commands::workdays::workday_pending_link_record,
            commands::workdays::workday_drain_pending_links,
            commands::workdays::workday_auto_link_session,
            // v2.8 -- automatic workday surface
            commands::workdays::workday_auto_start_for_project,
            commands::workdays::workday_auto_for_session,
            commands::workdays::workday_append_context,
            commands::workdays::workday_record_kanban_event,
            commands::workdays::workday_today_timeline,
            commands::workdays::workday_history,
            commands::workdays::workday_active_today_for_project,
            // H29 + H30 (2026-05-27)
            commands::workdays::workday_wipe_all,
            commands::workdays::workday_day_view,
            // H31 + H32 (2026-05-27) — Goals CRUD + AI auto-fill + auto-update scheduler
            commands::workdays::workday_goals_add,
            commands::workdays::workday_goals_update,
            commands::workdays::workday_goals_delete,
            commands::workdays::workday_goals_auto_fill,
            commands::workdays::workday_ai_summary_generate,
            commands::workdays::workday_context_auto_append,
            commands::workdays::workday_active_id_today,
            commands::workdays::register_workday_autoupdate_task,
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
            // -- system / scheduled tasks --
            commands::system::list_scheduled_tasks,
            commands::system::run_scheduled_task,
            commands::system::system_info,
            commands::system::task_detail,
            commands::system::rich_system_info,
            commands::system::edit_scheduled_task,
            commands::system::delete_scheduled_task,
            // -- installed apps --
            commands::apps::list_installed_apps,
            commands::apps::open_app_folder,
            commands::apps::uninstall_app,
            commands::apps::appx_query,
            commands::apps::uninstall_bloatware_app,
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
            commands::event_log::open_event_viewer,
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
            commands::plugins_info::read_plugin_info,
            commands::plugins_info::list_all_plugins,
            commands::plugins_info::uninstall_plugin_cache,
            commands::plugins_info::check_plugin_updates,
            // v2.9.5 — SHA-aware bulk update check + AI changelog summary
            commands::plugins_info::plugin_check_updates_bulk,
            commands::plugins_info::plugin_changelog_summary,
            // -- pty (embedded terminal, P3) --
            commands::pty::pty_spawn,
            commands::pty::pty_kill,
            commands::pty::pty_list,
            migration::migrate_dry_run,
            // -- library (P5 — GitHub search + install + per-project pin) --
            // v2.1: curated catalog feed. v2.2: live preview refresh.
            commands::library::library_search_github,
            commands::library::library_install_from_github,
            commands::library::read_curated_catalog,
            commands::library::catalog_fetch_previews,
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
            commands::library::library_install_via_ai,
            // v2.9.8: catalog compat analysis + bulk install (card-1779825112840)
            commands::library::analyze_catalog_compat,
            // -- decision registry (KIRKARDO 24) --
            commands::decisions::decisions_add,
            commands::decisions::decisions_update,
            commands::decisions::decisions_list,
            commands::decisions::decisions_delete,
            commands::decisions::decisions_drain_pending,
            commands::decisions::decisions_search,
            commands::decisions::kanban_decisions_search,
            commands::decisions::decisions_reject_all_auto,
            commands::decisions::decisions_purge_noise,
            // -- kanban (P4) --
            commands::kanban::kanban_load,
            commands::kanban::kanban_save,
            commands::kanban::kanban_create_card,
            commands::kanban::kanban_update_card,
            commands::kanban::kanban_move_card,
            commands::kanban::kanban_delete_card,
            commands::kanban::kanban_dispatch_card,
            commands::kanban::kanban_migrate_existing,
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
            commands::button_prompts::get_button_prompt,
            // -- global hotkeys --
            commands::hotkeys::get_global_hotkey,
            commands::hotkeys::set_global_hotkey,
            commands::hotkeys::pause_global_hotkeys,
            commands::hotkeys::resume_global_hotkeys,
            // -- commands defined directly in their domain modules --
            codex_fallback::build_fallback_context,
            codex_fallback::build_fallback_prompt,
            codex_fallback::launch_codex_fallback,
            project_hotkeys::get_project_hotkeys,
            project_hotkeys::set_project_at_slot,
            project_hotkeys::clear_project_at_slot,
            in_app_shortcuts::get_in_app_shortcuts,
            in_app_shortcuts::set_in_app_shortcuts,
            features::read_features,
            features::save_features,
            // -- AI Router (zone -> provider routing, providers catalog, --
            // -- health checks, metrics, end-to-end zone test) --
            ai_router::ai_router_list_zones,
            ai_router::ai_router_get_zone,
            ai_router::ai_router_update_zone,
            ai_router::ai_router_list_providers,
            ai_router::ai_router_health,
            ai_router::ai_router_metrics,
            ai_router::ai_router_test,
            ai_router::ai_router_route,
            ai_router::ai_router_usage_summary,
            // P1 2026-05-27: key-aware routing — validate keys + disabled list
            ai_router::ai_router_validate_keys,
            ai_router::ai_router_disabled_providers,
            // -- quota watchdog (P0 2026-05-27 — 98% auto-fallback) --
            // -- proxy free-tier lifecycle (NVIDIA NIM via claude-code-proxy) --
            proxy::proxy_start,
            proxy::proxy_stop,
            proxy::proxy_health,
            proxy::proxy_state_enabled,
            proxy::proxy_set_enabled,
            // -- workflow YAML composability + SQLite run history (KIRKARDO 23 P2) --
            commands::workflows::workflow_record_run,
            commands::workflows::workflow_update_run,
            commands::workflows::workflow_get_runs,
            commands::workflows::workflow_set_state,
            commands::workflows::workflow_get_state,
            commands::workflows::workflow_load_user_defined,
        ])
        .setup(|app| {
            // v2.13 -> v2.14 data migration (meta.json + features.json ensure).
            // Best-effort: a failure must never block startup.
            {
                let report = crate::migration::run_migrations_inner(env!("CARGO_PKG_VERSION"));
                if report.migrated {
                    eprintln!(
                        "[ultron] migration v{}->v{}: {}",
                        report.from_version,
                        report.to_version,
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
                        eprintln!("[ultron] kanban migration: {e}");
                    }
                }
            }

            // T2 (2026-05-26): drain queued session<->workday links left by
            // the workday-session-linker hook when the Control Center was
            // offline. Idempotent and silent on a clean state.
            crate::workdays::drain_pending_links_at_startup();

            // KIRKARDO 23 P2: initialise the workflow-runs SQLite DB (WAL +
            // indices). Idempotent — no-op when table already exists.
            if let Err(e) = crate::workflow_runs::init_db() {
                eprintln!("[ultron] workflow_runs init_db failed: {e}");
            }

            // MEMORY KERNEL Fase A: initialise the canonical memory DB
            // (~/.ultron/brain.db): memory_items + memory_events +
            // memory_candidates + FTS5, and best-effort import of kg.jsonl.
            // This wiring was MISSING before — brain.db was born empty and the
            // "strong DB" stored nothing. Idempotent. Never panics.
            if let Err(e) = crate::memory::sqlite_store::SqliteStore::init() {
                eprintln!("[ultron] memory brain.db init failed: {e}");
            }

            // KIRKARDO 23 P2: migrate legacy workflows-old.json → YAML if present.
            crate::workflow_loader::migrate_legacy_json_if_present();

            // Persisted main toggle hotkey (Ctrl+Alt+U by default).
            let shortcut_handle = app.global_shortcut();
            let spec = hotkeys::load_hotkey_spec();
            let shortcut = hotkeys::parse_hotkey(&spec).unwrap_or_else(|e| {
                eprintln!(
                    "[ultron] persisted hotkey '{}' rejected: {} — falling back",
                    spec, e
                );
                Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyU)
            });
            if let Err(e) = shortcut_handle.register(shortcut) {
                eprintln!("[ultron] global shortcut register failed: {}", e);
            }

            // Per-project hotkeys — user-defined in Settings → Project
            // hotkeys, persisted at ~/.ultron/cockpit/project-hotkeys.json.
            // (The legacy auto-registered Ctrl+Alt+1..9 set was removed in
            // v15.5.21 — it collided with AltGr on international keyboards.)
            if let Err(e) = project_hotkeys::register_custom_hotkeys(app.handle()) {
                eprintln!("[ultron] custom project hotkeys init failed: {}", e);
            }

            // Tray + close-to-tray.
            if let Err(e) = tray::init_tray(app.handle()) {
                eprintln!("[ultron] tray init failed: {}", e);
            }

            // Quota watchdog — polls quota-state.json every 60 s and emits
            // quota:updated / quota:critical / quota:reset events so the
            // frontend can update the Usage quota card and Sidebar dot.

            // MEMORY CORE D2 — Qdrant auto-launch.
            // Probes http://127.0.0.1:6333/healthz; if Qdrant is not running,
            // spawns D:\Ultron\qdrant\qdrant.exe detached (CREATE_NO_WINDOW).
            // Never panics — a missing exe is logged and boot continues.
            std::thread::spawn(|| {
                qdrant_auto_launch();
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

/// Attempt to spawn `D:\Ultron\qdrant\qdrant.exe` detached with no console
/// window.  Returns the child handle on success, or logs and returns `None`.
#[cfg(target_os = "windows")]
fn spawn_qdrant_exe() -> Option<std::process::Child> {
    use std::os::windows::process::CommandExt;

    const QDRANT_EXE: &str = r"D:\Ultron\qdrant\qdrant.exe";
    const QDRANT_DIR: &str = r"D:\Ultron\qdrant";
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    if !std::path::Path::new(QDRANT_EXE).exists() {
        eprintln!(
            "[qdrant-autolaunch] exe not found at {QDRANT_EXE} — \
             Qdrant must be started manually or installed at that path."
        );
        return None;
    }

    match std::process::Command::new(QDRANT_EXE)
        .current_dir(QDRANT_DIR)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
    {
        Ok(child) => {
            eprintln!("[qdrant-autolaunch] spawned pid={}", child.id());
            Some(child)
        }
        Err(e) => {
            eprintln!("[qdrant-autolaunch] spawn failed: {e}");
            None
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn spawn_qdrant_exe() -> Option<std::process::Child> {
    eprintln!("[qdrant-autolaunch] non-Windows platform — skipping auto-launch.");
    None
}

/// Background task: probe Qdrant, launch if down, re-probe to confirm.
fn qdrant_auto_launch() {
    if qdrant_is_running() {
        eprintln!("[qdrant-autolaunch] already running — no action needed.");
        return;
    }

    eprintln!("[qdrant-autolaunch] not running — attempting auto-launch.");
    let _child = spawn_qdrant_exe();

    // Give Qdrant time to bind the port before re-probing.
    std::thread::sleep(std::time::Duration::from_secs(4));

    if qdrant_is_running() {
        eprintln!("[qdrant-autolaunch] Qdrant is now reachable at :6333.");
    } else {
        eprintln!(
            "[qdrant-autolaunch] Qdrant still not reachable after launch attempt. \
             Semantic recall will be unavailable until Qdrant starts."
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
