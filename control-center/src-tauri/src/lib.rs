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
mod agents;
mod ai_router;
mod alerts_admin;
mod auth;
mod backup_status;
mod button_prompts;
mod claude_sessions;
mod codex_fallback;
mod cost_watchdog;
mod features;
mod full_diagnostic;
mod gaming;
mod hooks_admin;
mod hotkeys;
mod in_app_shortcuts;
mod inbox;
mod installed_apps;
mod instructions;
mod logs;
mod maintenance;
mod mcps;
mod memory;
mod memory_graph;
mod memory_highlights;
mod mode;
mod news;
mod personal;
mod plans;
mod project_hotkeys;
mod projects;
mod self_improve;
mod sessions;
mod settings;
mod skills;
mod system;
mod system_diagnose;
mod toast_emit;
mod tray;
mod usage;
mod version_drift;

mod commands;

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
                        if hotkeys::is_inbox_shortcut(shortcut) {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.emit("open-inbox", ());
                            }
                            return;
                        }
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
            commands::misc::ultron_status,
            commands::misc::qdrant_health,
            commands::misc::list_logs,
            commands::misc::tail_log,
            commands::misc::list_instruction_folders,
            commands::misc::instruction_path,
            commands::misc::claude_usage,
            commands::misc::compute_activity_timeline,
            commands::misc::compute_cost,
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
            // -- skills --
            commands::skills::list_skills,
            commands::skills::read_skill_md,
            commands::skills::create_skill,
            commands::skills::update_skill_md,
            commands::skills::delete_skill,
            commands::skills::get_skill_findings,
            commands::skills::allow_skill_manually,
            // -- agents --
            commands::agents::list_agents,
            commands::agents::read_agent_md,
            commands::agents::create_agent,
            commands::agents::update_agent_md,
            commands::agents::delete_agent,
            commands::agents::get_agent_findings,
            commands::agents::allow_agent_manually,
            // -- maintenance / lifecycle --
            commands::maintenance::list_maintenance_commands,
            commands::maintenance::run_maintenance_command,
            commands::maintenance::run_detect_gaps,
            commands::maintenance::run_app_lifecycle,
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
            // -- memory --
            commands::memory::memory_status,
            commands::memory::brain_query,
            commands::memory::read_vault_note,
            commands::memory::memory_action,
            commands::memory::list_recent_vault_notes,
            // -- sessions --
            commands::sessions::spawn_session,
            commands::sessions::run_inline,
            commands::sessions::list_claude_sessions,
            // -- settings + backup --
            commands::settings::settings_read,
            commands::settings::settings_save,
            commands::settings::purge_legacy_autostart,
            commands::settings::get_backup_root,
            commands::settings::set_backup_root,
            commands::settings::backup_status,
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
            // -- gaming --
            commands::gaming::detect_running_games,
            commands::gaming::list_killable_processes,
            commands::gaming::kill_processes,
            commands::gaming::windows_tweaks_status,
            commands::gaming::windows_tweak_set,
            // -- auth + ULTRON mode --
            commands::lifecycle::auth_status,
            commands::lifecycle::get_ultron_mode,
            commands::lifecycle::set_ultron_mode,
            commands::lifecycle::reset_mode_to_autodetect,
            commands::lifecycle::close_control_center,
            // -- AI router --
            commands::ai_router::read_ai_router,
            commands::ai_router::save_ai_router,
            commands::ai_router::resolve_zone_for_prompt,
            // -- news --
            commands::news::list_news,
            commands::news::generate_news,
            commands::news::generate_news_session,
            commands::news::delete_news,
            commands::news::read_news_html,
            commands::news::summarize_news,
            // -- diagnostics + doctor --
            commands::diagnostics::run_full_diagnostic,
            commands::diagnostics::apply_auto_fix,
            commands::diagnostics::run_diagnose,
            commands::diagnostics::diagnose_with_ai,
            commands::diagnostics::self_improve_report,
            commands::diagnostics::run_codex_adversarial_review,
            commands::diagnostics::run_doctor,
            // -- personal profile --
            commands::personal::read_personal_profile,
            commands::personal::save_personal_profile,
            commands::personal::read_personal_known,
            commands::personal::request_personal_analysis,
            commands::personal::read_personal_sample,
            commands::personal::train_personal_style,
            commands::personal::generate_style_sample,
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
            // -- inbox quick-capture --
            commands::inbox::append_inbox,
            commands::inbox::list_inbox,
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
            toast_emit::get_toast_enabled,
            toast_emit::set_toast_enabled,
            memory_graph::compute_memory_graph,
            codex_fallback::build_fallback_context,
            codex_fallback::build_fallback_prompt,
            codex_fallback::launch_codex_fallback,
            project_hotkeys::project_at_slot,
            project_hotkeys::get_project_hotkeys,
            project_hotkeys::set_project_at_slot,
            project_hotkeys::clear_project_at_slot,
            in_app_shortcuts::get_in_app_shortcuts,
            in_app_shortcuts::set_in_app_shortcuts,
            features::read_features,
            features::save_features,
            memory_highlights::compute_memory_highlights,
            memory_highlights::compute_memory_link_graph,
            memory_highlights::mark_orphan_for_review,
        ])
        .setup(|app| {
            // Persisted main toggle hotkey (Ctrl+Alt+U by default).
            let shortcut_handle = app.global_shortcut();
            let spec = hotkeys::load_hotkey_spec();
            let shortcut = hotkeys::parse_hotkey(&spec).unwrap_or_else(|e| {
                eprintln!("[ultron] persisted hotkey '{}' rejected: {} — falling back", spec, e);
                Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyU)
            });
            if let Err(e) = shortcut_handle.register(shortcut) {
                eprintln!("[ultron] global shortcut register failed: {}", e);
            }

            // Inbox quick-capture hotkey (Ctrl+Alt+I).
            if let Err(e) = hotkeys::register_inbox_shortcut(app.handle()) {
                eprintln!("[ultron] inbox hotkey register failed: {}", e);
            }

            // Project slot hotkeys (Ctrl+Alt+1..9).
            if let Err(e) = project_hotkeys::register_project_hotkeys(app.handle()) {
                eprintln!("[ultron] project hotkeys init failed: {}", e);
            }

            // Custom per-project hotkeys defined in Settings →
            // Project hotkeys, persisted at
            // ~/.ultron/cockpit/project-hotkeys.json.
            if let Err(e) = project_hotkeys::register_custom_hotkeys(app.handle()) {
                eprintln!("[ultron] custom project hotkeys init failed: {}", e);
            }

            // Tray + close-to-tray.
            if let Err(e) = tray::init_tray(app.handle()) {
                eprintln!("[ultron] tray init failed: {}", e);
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
