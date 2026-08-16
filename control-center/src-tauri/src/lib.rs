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
mod claude_theme;
mod commands_registry;
mod cost_watchdog;
pub mod daemon_client; // cliente del daemon: una sola copia de los modelos
mod detach;
mod diagnostics_native;
mod env_keys;
mod features;
#[cfg(feature = "finance")]
mod finance;
mod handlers;
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
mod plugin_state;
mod plugins_info;
mod project_agents;
mod project_context;
mod project_hotkeys;
mod projects;
mod proxy;
mod tfg_heuristics;
// pty: runtime PTY interno (RunBatch kanban, delegate, tray, lifecycle). El
// terminal embebido y sus comandos Tauri (pty_spawn/pty_kill/pty_list) se
// retiraron 2026-07; NO borrar este modulo — sigue teniendo consumidores Rust.
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
mod tfg_lab; // Lab TFG — deteccion determinista de patrones de texto IA (docs/research)
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
/// The `ultron-memory` sidecar streams its JSON result on stdout (the IPC
/// channel the Node hooks parse); trace output must therefore go to stderr
/// or it would corrupt that channel. Sidecars call this from their `main()`.
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
        .invoke_handler(handlers::all())
        .setup(|app| {
            // Barrido de modelos inactivos (2026-08-15). La GUI tambien carga
            // E5 en su propio proceso cuando ejecuta un recall o el routing, y
            // se quedaba con ~1,5 GB tomados para el resto de la sesion (medido
            // con la app abierta y sin usar: 1.523 MB). Cada minuto se sueltan
            // los modelos que hayan pasado su ventana de inactividad; la
            // siguiente consulta los recarga.
            std::thread::spawn(|| loop {
                std::thread::sleep(std::time::Duration::from_secs(60));
                let soltados = crate::qdrant::release_idle_models();
                if !soltados.is_empty() {
                    tracing::info!(modelos = ?soltados, "modelos liberados por inactividad");
                }
            });

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
                // Primero el daemon: este probe es lo que le cargaba E5 a la GUI
                // en cada arranque (1.522 MB medidos el 2026-08-15 con la
                // ventana recien abierta y sin tocar nada). Hecho en el daemon,
                // el modelo se carga UNA vez para todo el sistema.
                if let Some(v) = crate::daemon_client::request(
                    "warm_catalog",
                    serde_json::json!({}),
                    std::time::Duration::from_secs(120),
                ) {
                    tracing::info!(respuesta = %v, "catalog warmed (daemon)");
                    return;
                }
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
