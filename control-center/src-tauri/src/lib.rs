// ULTRON Control Center — Tauri backend
//
// v15.4 architectural split: every `#[tauri::command]` wrapper lives under
// `commands/<group>.rs` grouped by domain. This file owns runtime plumbing
// only — module declarations, the `ultron_root` helper, plugin setup and
// hotkey + tray registration. The `generate_handler!` dispatcher lives in
// `handlers.rs`.
//
// Adding a new command:
//   1. Implement the inner logic in the matching domain module
//      (`crate::projects`, `crate::skills`, ...).
//   2. Add a thin `#[tauri::command] pub async fn` wrapper to the matching
//      file in `commands/`.
//   3. Reference it in the grouped `generate_handler!` block of
//      `handlers.rs`.
//
// Mejora futura (card kanban f2-comandos-sin-caller): tauri-specta para
// generar bindings.ts tipados desde las firmas de comandos.

mod accounts; // Settings > Cuentas y modelos: read-only CLI account/model report
mod activity_timeline;
mod agent_orchestration;
mod agents;
mod ai_router;
mod alerts_admin;
mod auth;
mod backup_status;
mod batches;
mod batches_queue;
pub mod build_stamp; // SHA + dirty embebidos por build.rs (`ultron-memory version`, doctor)
mod button_prompts;
mod claude_sessions;
mod claude_theme;
mod commands_registry;
pub mod daemon_client; // cliente del daemon: una sola copia de los modelos
mod detach;
mod diagnostics_native;
mod env_keys;
mod env_path; // PATH del proceso completado con el del registro (app lanzada desde el Explorador)
mod features;
#[cfg(feature = "finance")]
// Módulo local opcional, ausente en los worktrees del repositorio público.
#[rustfmt::skip]
mod finance;
mod handlers;
mod hooks_admin;
mod hotkeys;
mod in_app_shortcuts;
mod installed_apps;
mod instructions;
mod kanban;
mod library;
mod main_watchdog; // latido del hilo principal: apunta los bloqueos en logs/ui-stalls.jsonl
mod maintenance;
// Piloto MCP de la GUI (solo desarrollo, docs/MCP-TAURI-PILOTO.md). Doble
// cerrojo: feature opcional fuera de `default` + debug_assertions. Si alguien
// activa la feature en release, la compilacion se aborta aqui.
#[cfg(all(feature = "mcp-bridge", debug_assertions))]
mod mcp_bridge;
#[cfg(all(feature = "mcp-bridge", not(debug_assertions)))]
compile_error!(
    "la feature mcp-bridge expone ejecucion de JS e IPC por WebSocket: solo se permite en builds de desarrollo (debug_assertions)"
);
mod mascot; // mascota de escritorio + puente del MCP de escritorio (tools/ultron-desktop-mcp)
mod mcps;
pub mod memory; // MemoryStore trait + adapters (KIRKARDO 21)
mod migration;
mod notes;
mod ollama; // modelo local (autocompletado): motor del editor, desde la bandeja y AI Router
pub mod orchestrator; // Auto-routing #7 — intent -> workflow -> agent -> memory
mod plan_limits; // cuota del plan Anthropic (ventana 5h / semanal) para la pestana Usage
mod plans;
mod plugin_state;
mod plugins_info;
mod project_context;
mod project_hotkeys;
mod projects;
mod proxy;
mod tfg_heuristics;
mod tfg_heuristics_densidad;
// pty: runtime PTY interno. Consumidores: ULTRON Sessions (sesiones/gestor.rs,
// único llamante de pty::spawn_with) y el cierre de la app (kill_all_inner).
// El RunBatch del kanban se retiró el 2026-10-17 y el terminal embebido
// (pty_spawn/pty_kill/pty_list) en 2026-07; NO borrar este módulo.
mod pty;
pub mod qdrant;
mod rules;
pub mod serve; // ultron-memory serve — persistent E5-warm orchestrator daemon
               // Ventana «ULTRON Sesiones»: PTY de claude, seguidor de transcripts, puente HTTP
               // loopback del mod ultron-puente, adjuntos y Codex (docs/sesiones/CONTRATO.md).
mod sesiones;
mod sessions;
mod sessions_tags;
mod settings;
mod skills;
mod system;
mod tabs;
#[cfg(test)]
mod tao_patch_tests;
#[cfg(test)]
mod test_support;
mod tfg_lab; // Lab TFG — deteccion determinista de patrones de texto IA (docs/research)
mod toast_emit;
mod tools; // Settings > Herramientas: estado read-only de las CLIs standalone (markitdown, rumdl, mmdc, glow, agy, codex)
mod tray;
mod turn_off;
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
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    if to_stderr {
        let _ = tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_target(true)
            .with_writer(std::io::stderr)
            .try_init();
        return;
    }
    // GUI: consola (desarrollo) y fichero diario en la carpeta de logs, que
    // en release es el único rastro (`windows_subsystem`; `seguridad-robustez:F11`).
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer().with_target(true))
        .with(logs::capa_fichero())
        .try_init();
    logs::instalar_panic_hook();
}

/// Identificador de la app (`identifier` de `tauri.conf.json`): nombre de su
/// carpeta en `%LOCALAPPDATA%`.
const APP_IDENTIFIER: &str = "io.github.skitemplar.ultron";

/// Carpeta de logs de la app: `%LOCALAPPDATA%/<identifier>/logs`.
pub(crate) fn logs_dir() -> Option<PathBuf> {
    dirs::data_local_dir().map(|d| d.join(APP_IDENTIFIER).join("logs"))
}

/// Logs en fichero y panic hook de la GUI (§8.3 paso 7).
mod logs {
    use std::io::Write;
    use std::sync::OnceLock;

    use tracing_appender::non_blocking::WorkerGuard;
    use tracing_appender::rolling::{RollingFileAppender, Rotation};
    use tracing_subscriber::registry::LookupSpan;
    use tracing_subscriber::Layer;

    /// Días de logs que se conservan.
    const DIAS: usize = 7;

    /// El guardia vacía el hilo del escritor no bloqueante: vive lo que el
    /// proceso.
    static GUARDIA: OnceLock<WorkerGuard> = OnceLock::new();

    /// Capa de `tracing` que escribe en `ultron.<fecha>.log` (rotación
    /// diaria, 7 ficheros). `None` si no hay carpeta o no se puede crear: la
    /// app arranca igual y lo deja en la consola.
    pub fn capa_fichero<S>() -> Option<Box<dyn Layer<S> + Send + Sync>>
    where
        S: tracing::Subscriber + for<'a> LookupSpan<'a>,
    {
        let dir = super::logs_dir()?;
        let appender = RollingFileAppender::builder()
            .rotation(Rotation::DAILY)
            .filename_prefix("ultron")
            .filename_suffix("log")
            .max_log_files(DIAS)
            .build(&dir);
        let appender = match appender {
            Ok(a) => a,
            Err(e) => {
                eprintln!("logs en fichero desactivados ({}): {e}", dir.display());
                return None;
            }
        };
        let (escritor, guardia) = tracing_appender::non_blocking(appender);
        let _ = GUARDIA.set(guardia);
        Some(
            tracing_subscriber::fmt::layer()
                .with_writer(escritor)
                .with_ansi(false)
                .with_target(true)
                .boxed(),
        )
    }

    /// Panic hook: deja el pánico (hilo, ubicación y mensaje) en
    /// `panic.log` de la carpeta de logs y en `tracing`, y después llama al
    /// hook anterior.
    pub fn instalar_panic_hook() {
        let previo = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let linea = describir(info);
            tracing::error!(panico = %linea, "pánico");
            if let Some(dir) = super::logs_dir() {
                escribir_panico(&dir.join("panic.log"), &linea);
            }
            previo(info);
        }));
    }

    pub(super) fn describir(info: &std::panic::PanicHookInfo<'_>) -> String {
        let hilo = std::thread::current()
            .name()
            .unwrap_or("sin nombre")
            .to_string();
        let donde = info
            .location()
            .map_or_else(String::new, |l| format!("{}:{}", l.file(), l.line()));
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "pánico sin mensaje".to_string());
        format!(
            "{} hilo={hilo} en {donde}: {msg}",
            chrono::Local::now().to_rfc3339()
        )
    }

    pub(super) fn escribir_panico(path: &std::path::Path, linea: &str) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let r = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .and_then(|mut f| writeln!(f, "{linea}"));
        // Con `windows_subsystem = "windows"` stderr no llega a ningún sitio:
        // el fallo va a tracing, que sí queda en el fichero de log.
        if let Err(e) = r {
            tracing::error!(fichero = %path.display(), error = %e, "no se pudo anotar el pánico");
        }
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn el_identificador_coincide_con_tauri_conf() {
            let conf: serde_json::Value =
                serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
            assert_eq!(
                conf["identifier"].as_str(),
                Some(super::super::APP_IDENTIFIER)
            );
        }

        #[test]
        fn el_panico_queda_en_el_fichero() {
            let dir = tempfile::tempdir().expect("tmp");
            let p = dir.path().join("logs").join("panic.log");
            super::escribir_panico(&p, "linea uno");
            super::escribir_panico(&p, "linea dos");
            let t = std::fs::read_to_string(&p).expect("leer");
            assert_eq!(
                t.lines().collect::<Vec<_>>(),
                vec!["linea uno", "linea dos"]
            );
        }

        #[test]
        fn describir_incluye_mensaje_y_ubicacion() {
            let visto = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
            let v2 = visto.clone();
            let previo = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                if let Ok(mut g) = v2.lock() {
                    *g = super::describir(info);
                }
            }));
            let r = std::panic::catch_unwind(|| panic!("fallo de prueba"));
            std::panic::set_hook(previo);
            assert!(r.is_err());
            let linea = visto.lock().expect("visto").clone();
            assert!(linea.contains("fallo de prueba"), "{linea}");
            assert!(linea.contains("lib.rs:"), "{linea}");
        }
    }
}

pub fn run() {
    init_tracing();
    build_stamp::log_app_stamp();
    mascot::win::disable_ghosting();
    env_path::refresh_from_registry();

    // Load .env files so users can store provider API keys in dotfiles
    // instead of exporting to the shell. Order: ~/.ultron/.env (preferred),
    // ~/.ultron/control-center/.env, then cwd/.env. First hit wins per key
    // (dotenvy::from_filename does not override pre-existing env vars).
    if let Some(home) = dirs::home_dir() {
        let _ = dotenvy::from_filename(home.join(".ultron").join(".env"));
        let _ = dotenvy::from_filename(home.join(".ultron").join("control-center").join(".env"));
    }
    let _ = dotenvy::dotenv();
    // La URL privada del calendario no se queda en el entorno: los hijos lo heredan.
    mascot::calendar_fetch::scrub_process_env();

    // Headless mode: when invoked with --run-diagnostic, run all checks,
    // persist to ~/.ultron/cockpit/diagnostics/<ts>.json, emit alert if
    // severity >= error, and exit without UI. Used by the daily
    // ULTRON-Daily-Diagnostic scheduled task (see commands/diagnostics_native).
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--run-diagnostic") {
        let report = diagnostics_native::run_full_diagnostic_native();
        let _ = persist_headless(&report);
        let _ = alerts_admin::migrate_orphan_cockpit_alerts();
        if matches!(report.max_severity, diagnostics_native::Severity::Error) {
            let _ = emit_alert_headless(&report);
        }
        std::process::exit(0);
    }

    let builder = tauri::Builder::default()
        // Debe ser el primer plugin. Una segunda copia (p.ej. el autostart
        // lanzado con la app ya abierta a mano: medido 2026-09-16, dos
        // control-center.exe de ~1,6 GB cada uno) sale al instante; si la
        // abrió el usuario, se enfoca la ventana de la copia viva.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // `--sesiones` / `--sesiones-cwd <ruta>` (sesiones/abrir_carpeta.rs).
            let pide_sesiones = sesiones::abrir_carpeta::atender(app, &argv);
            if !pide_sesiones && !argv.iter().any(|a| a == "--from-autostart") {
                tray::focus_main_window(app);
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        // Auto-updater: registered but DORMANT. tauri.conf.json carries a
        // placeholder pubkey, capabilities grant no updater:* permission and
        // nothing calls it from JS or Rust. Update checks go through
        // update_checker.rs (`check_for_updates`, UpdateBanner). Kept only
        // as the reactivation path in docs/RELEASE-PROCESS.md; a post-install
        // restart would use `AppHandle::restart()` (the process plugin was
        // removed).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--from-autostart"]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        if mascot::screens::handle_shortcut(app, shortcut) {
                            return;
                        }
                        if project_hotkeys::handle_shortcut(app, shortcut, event.state()) {
                            return;
                        }
                        toggle_window(app);
                    }
                })
                .build(),
        );
    #[cfg(all(feature = "mcp-bridge", debug_assertions))]
    let builder = mcp_bridge::attach(builder);
    let builder = sesiones::ventana::registrar_protocolos(builder);
    builder
        .invoke_handler(handlers::all())
        .setup(|app| {
            #[cfg(all(feature = "mcp-bridge", debug_assertions))]
            mcp_bridge::grant_capability(app)?;

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

            // Migraciones de datos, FUERA del hilo que crea la ventana
            // (2026-09-22). El comentario de abajo decía «best-effort: a
            // failure must never block startup» — correcto sobre el error y
            // mudo sobre el TIEMPO, que era el problema: eran el último punto
            // pesado que quedaba síncrono dentro de `.setup()`, mientras todo
            // lo demás (barrido de modelos, Qdrant, voz, warm del catálogo)
            // ya corría en un hilo.
            //
            // POR QUÉ SE PUEDE MOVER, y qué se ha comprobado antes de
            // hacerlo: ninguna de las dos escribe algo que otro tenga que
            // encontrar ya hecho, porque los dos lectores se curan solos con
            // EXACTAMENTE lo mismo que escribiría la migración:
            //   * `features.json` -> `features::read_features_inner()` cae a
            //     `Features::default()` cuando el fichero no está, que es el
            //     contenido que crea la migración;
            //   * `kanban.json`   -> `kanban::board_io::load()` crea el
            //     tablero por defecto y lo guarda si falta.
            //   * `meta.json` no lo lee nadie más que la propia migración.
            // Por eso no hay ninguna bandera «migrando» que consultar: no
            // existe un comando capaz de ver un estado a medias, y una
            // bandera que nadie mira sería código sin consumidor (mandamiento
            // 12). Las dos se quedan en el MISMO hilo y en el MISMO orden,
            // por si alguna vez dejan de ser independientes.
            std::thread::spawn(|| {
                // v2.13 -> v2.14 data migration (meta.json + features.json ensure).
                // Best-effort: a failure must never block startup.
                let report = crate::migration::run_migrations_inner(env!("CARGO_PKG_VERSION"));
                if report.migrated {
                    tracing::info!(
                        from = %report.from_version,
                        to = %report.to_version,
                        "data migration applied: {}",
                        report.actions.join(" | ")
                    );
                }

                // P4 migration: ensure every known project has a kanban.json.
                // Idempotent — no-op if files already exist.
                if let Ok(projects) = crate::projects::list_projects_inner() {
                    let ids: Vec<String> = projects.iter().map(|p| p.id.clone()).collect();
                    if let Err(e) = crate::kanban::migrate_all_projects(&ids) {
                        tracing::error!(error = %e, "kanban migration failed");
                    }
                }
            });

            // KIRKARDO 23 P2: initialise the workflow-runs SQLite DB (WAL +
            // indices). Idempotent — no-op when table already exists.
            if let Err(e) = crate::workflow_runs::init_db() {
                tracing::error!(error = %e, "workflow_runs init_db failed");
            }

            // MEMORY KERNEL Fase A: initialise the canonical memory DB
            // (~/.ultron/brain.db): memory_items + memory_events +
            // memory_candidates + FTS5.
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

            // Sesiones: sink de eventos, puente HTTP (puerto dinámico y token
            // por arranque) y seguidor de transcripts, todo en hilos propios.
            sesiones::init(app.handle().clone());
            main_watchdog::start(app.handle().clone());
            // Acceso directo «ULTRON Sessions»: solo esa ventana; el Control
            // Center queda en la bandeja.
            // `--sesiones-cwd <ruta>` abre además una sesión en esa carpeta.
            let launch_args: Vec<String> = std::env::args().collect();
            if sesiones::abrir_carpeta::peticion_de(&launch_args).is_some() {
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.hide();
                }
                sesiones::abrir_carpeta::atender(app.handle(), &launch_args);
            }

            // Tray + close-to-tray.
            if let Err(e) = tray::init_tray(app.handle()) {
                tracing::error!(error = %e, "tray init failed");
            }

            // Mascota de escritorio (ventana «mascot») + puente local del MCP
            // de escritorio. Best-effort: un fallo se registra y no bloquea.
            mascot::init(app.handle());

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
            // compete in the semantic router without a manual reindex. Daemon
            // first (the E5 probe cost the GUI 1.522 MB on 2026-08-15), local
            // fallback; skipped entirely with ULTRON_DENSE=0. Best-effort: see
            // memory/catalog_warm.rs.
            tauri::async_runtime::spawn_blocking(crate::memory::catalog_warm::warm_at_startup);

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
        .on_window_event(|window, event| {
            // Solo la ventana principal: este manejador ve TODAS las ventanas,
            // y cerrar la de la mascota (Settings -> Mascota) o un proyecto
            // desacoplado no debe tumbar el proxy de la app.
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    // Matar el proxy al cerrar para no dejar :8082 huerfano.
                    // Cubre el caso normal (cierre de ventana principal).
                    let _ = proxy::proxy_stop_inner();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error building tauri application")
        .run(|app, event| {
            // Salida con sesiones trabajando o con cola: la primera petición
            // se retiene y avisa en Sessions; la segunda, en 15 s, sale
            // (sesiones/proteccion.rs). Restart (actualizador) no se puede
            // retener.
            if let tauri::RunEvent::ExitRequested { api, .. } = &event {
                if !sesiones::proteccion::permitir_salida(app) {
                    api.prevent_exit();
                }
                return;
            }
            // RunEvent::Exit cubre los casos que WindowEvent::Destroyed no
            // alcanza: Alt+F4 en ventana secundaria, kill desde el tray,
            // panic en el hilo principal, exit() desde cualquier comando y el
            // apagado de Windows (WM_ENDSESSION, sin ExitRequested previo).
            //
            // Pánico conocido de tao 0.35 al apagar Windows («cannot move
            // state from Destroyed», runner.rs:371): en WM_ENDSESSION tao
            // llama a loop_destroyed() dentro del wndproc (este Exit), pero el
            // bucle de mensajes sigue vivo y el siguiente mensaje (un evento de
            // usuario o PROCESS_NEW_EVENTS) intenta salir del estado
            // Destroyed. Los cuatro pánicos registrados (10-15 a 10-22)
            // coinciden al segundo con un evento 1074 (apagado) del registro
            // System. Llega después de que este bloque termine, así que no se
            // pierde el volcado ni quedan PTY vivos; no es código nuestro y
            // tauri-runtime-wry 2.11 fija tao 0.35. Detalle y workaround en
            // papercuts.md.
            if let tauri::RunEvent::Exit = event {
                // El proxy se para también en WindowEvent::Destroyed: aquí
                // puede no quedar nada que parar, y un fallo no detiene la
                // salida, pero queda en el log.
                if let Err(e) = proxy::proxy_stop_inner() {
                    tracing::warn!(error = %e, "no se pudo parar el proxy al salir");
                }
                // Antes de matar los PTY: abiertas.json con la cola de los
                // últimos ~500 ms (el hilo escritor espera calma).
                sesiones::persistencia::volcar_ya();
                // PTY de Sessions (árbol entero por Job Object) y motores
                // externos (Codex, Gemini) lanzados desde Sessions.
                pty::kill_all_inner();
                sesiones::motor::matar_todos();
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

    // Qdrant defaults to binding 0.0.0.0 when it finds no config, and it looks
    // for `config/config.yaml` relative to the working directory — not the
    // `config.yaml` that sits next to the binary. Spawning with no arguments
    // therefore published the whole vector store (ultron_memory included, no
    // API key) on every network interface. Found live on 2026-09-21: the
    // collections answered from the LAN address on a public-profile network.
    //
    // Two independent guards, so neither one alone is load-bearing:
    //   1. QDRANT__SERVICE__HOST pins the bind address even with no config file
    //      at all (Qdrant maps QDRANT__<SECTION>__<KEY> onto its config tree).
    //   2. --config-path points at the real config.yaml when one exists.
    let mut cmd = std::process::Command::new(&qdrant_exe);
    cmd.current_dir(&qdrant_dir)
        .env("QDRANT__SERVICE__HOST", "127.0.0.1")
        .creation_flags(CREATE_NO_WINDOW);

    let config_path = std::path::Path::new(&qdrant_dir).join("config.yaml");
    if config_path.exists() {
        cmd.arg("--config-path").arg(&config_path);
    }

    match cmd.spawn() {
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
    if !crate::qdrant::dense_enabled() {
        tracing::info!("qdrant-autolaunch: skipped — dense stack disabled (ULTRON_DENSE=0)");
        return;
    }
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
    diagnostics_native::emit_headless_error_alert(report)
}
