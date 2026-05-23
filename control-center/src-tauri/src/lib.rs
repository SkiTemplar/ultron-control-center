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
mod alerts_admin;
mod auth;
mod backup_status;
mod button_prompts;
mod claude_sessions;
mod codex_fallback;
mod cost_watchdog;
mod features;
mod hooks_admin;
mod hotkeys;
mod in_app_shortcuts;
mod inbox;
mod installed_apps;
mod instructions;
mod kanban;
mod library;
mod logs;
mod maintenance;
mod mcps;
mod mem0;
mod plans;
mod plugins_info;
mod project_hotkeys;
mod projects;
mod pty;
mod rules;
mod diagnostics_native;
mod sessions;
mod settings;
mod skills;
mod system;
mod tabs;
mod toast_emit;
mod tray;
mod update_checker;
mod usage;

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
            commands::mcps::mcp_ping,
            // -- skills --
            commands::skills::list_skills,
            commands::skills::list_skills_legacy,
            commands::skills::skill_toggle,
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
            commands::agents::agents_pinned_load,
            commands::agents::agents_pinned_save,
            // -- rules --
            commands::rules::rules_list,
            commands::rules::rules_read,
            // -- maintenance / lifecycle --
            commands::maintenance::list_maintenance_commands,
            commands::maintenance::run_maintenance_command,
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
            commands::projects::project_claude_md_load,
            commands::projects::project_claude_md_save,
            // -- mem0 --
            commands::mem0::mem0_status,
            commands::mem0::mem0_search,
            commands::mem0::mem0_add,
            commands::mem0::mem0_delete,
            // -- sessions --
            commands::sessions::spawn_session,
            commands::sessions::run_inline,
            commands::sessions::list_claude_sessions,
            claude_sessions::project_sessions_list,
            // -- settings + backup --
            commands::settings::settings_read,
            commands::settings::settings_save,
            commands::settings::purge_legacy_autostart,
            commands::settings::get_backup_root,
            commands::settings::set_backup_root,
            commands::settings::backup_status,
            commands::settings::get_backup_sources,
            commands::settings::set_backup_sources,
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
            // -- plugin info (P7 + v2.2 multi-plugin) --
            commands::plugins_info::read_plugin_info,
            commands::plugins_info::list_all_plugins,
            commands::plugins_info::uninstall_plugin_cache,
            // -- pty (embedded terminal, P3) --
            commands::pty::pty_spawn,
            commands::pty::pty_write,
            commands::pty::pty_resize,
            commands::pty::pty_kill,
            commands::pty::pty_list,
            // -- library (P5 — GitHub search + install + per-project pin) --
            // v2.1: curated catalog feed. v2.2: live preview refresh.
            commands::library::library_search_github,
            commands::library::library_install_from_github,
            commands::library::read_curated_catalog,
            commands::library::catalog_fetch_previews,
            commands::library::agent_create,
            commands::library::skill_create,
            commands::library::library_pin_agent,
            commands::library::library_unpin_agent,
            commands::library::library_list_pinned,
            // -- kanban (P4) --
            commands::kanban::kanban_load,
            commands::kanban::kanban_save,
            commands::kanban::kanban_create_card,
            commands::kanban::kanban_update_card,
            commands::kanban::kanban_move_card,
            commands::kanban::kanban_delete_card,
            commands::kanban::kanban_dispatch_card,
            commands::kanban::kanban_migrate_existing,
            // -- tabs (P4) --
            commands::tabs::tabs_load,
            commands::tabs::tabs_save,
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
        ])
        .setup(|app| {
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ---------------------------------------------------------------------------
// Headless --run-diagnostic helpers (P6).
// ---------------------------------------------------------------------------

fn persist_headless(report: &diagnostics_native::DiagnosticReport) -> std::io::Result<()> {
    let dir = ultron_root()
        .map(|p| p.join("cockpit").join("diagnostics"))
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{}.json", report.timestamp));
    let body = serde_json::to_vec_pretty(report)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
    std::fs::write(path, body)
}

fn emit_alert_headless(report: &diagnostics_native::DiagnosticReport) -> std::io::Result<()> {
    let path = ultron_root()
        .map(|p| p.join("cockpit").join("alerts.jsonl"))
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
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
