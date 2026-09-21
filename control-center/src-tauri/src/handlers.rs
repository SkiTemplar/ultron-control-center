// handlers.rs — registro completo de comandos Tauri (generate_handler!).
//
// Extraido de lib.rs (2026-08-16, cat7.3: fichero >800 lineas). El macro genera
// el dispatcher de invoke; vive aqui como funcion generica sobre el Runtime y
// lib.rs lo consume con `.invoke_handler(handlers::all())`. Los paths internos
// son crate-relativos via el glob import (los mods del root son items del crate
// y visibles para todo modulo hijo).
#![allow(unused_imports)]
use crate::*;

pub(crate) fn all() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        // -- misc / system status --
        commands::misc::maria_root_str,
        commands::misc::home_dir_str,
        commands::misc::instruction_path,
        commands::misc::claude_usage,
        // Wiring 2026-08-11 (audit 08-09 #43): heatmap dia x fuente +
        // eventos recientes en Usage -> Activity. El resto de misc.rs
        // (list_logs/tail_log/compute_cost/...) sigue sin registrar a
        // proposito hasta tener consumidor en la UI.
        commands::misc::compute_activity_timeline,
        // -- Lab TFG (wiring 2026-08-12): deteccion determinista de patrones
        //    de texto IA sobre el catalogo docs/research/patrones-texto-ia.json.
        //    Consume la pestana Lab (Detector + Catalogo). --
        // -- external editor (v2.6 Library redesign) --
        commands::external_editor::open_in_vscode,
        commands::external_editor::read_text_file,
        // -- alerts / changelog --
        commands::alerts::read_alerts,
        commands::alerts::delete_alert_entries,
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
        commands::mcps::mcp_account_templates,
        commands::mcps::mcp_accounts_list,
        commands::mcps::mcp_account_add,
        commands::mcps::mcp_account_remove,
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
        agent_orchestration::usage::agent_usage_stats,
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
        // FRENTE D (2026-09-10): boton "Abrir app" en la tarjeta de proyecto
        // — lanza project.app_command en una terminal nueva (cwd = path).
        commands::projects::project_open_app,
        // -- asistente "Nuevo proyecto" (wiring 2026-09-14): wrapper del CLI
        //    ~/.ultron/scripts/project-create.mjs (roots/list/templates/
        //    subject/mkdir/create) que consume NewProjectWizard.tsx. --
        commands::projects::project_create_cli,
        // -- editor CLAUDE.md por proyecto (wiring 2026-08-11, audit #39;
        //    modal en ProjectWorkspace, fila Codigo). Del mismo bloque
        //    quedan SIN registrar a proposito: project_context_load (su
        //    payload agrega el KG retirado en jul-02 — actualizar payload
        //    antes de cablear un panel que mostraria datos muertos) y
        //    launch_project_executable/reorder_launcher_items (esperan la
        //    pasada por la UI del launcher). --
        commands::projects::project_claude_md_load,
        commands::projects::project_claude_md_save,
        commands::projects::project_create_claude_md,
        commands::projects::add_launcher_item,
        commands::projects::remove_launcher_item,
        commands::projects::launch_item,
        commands::projects::launch_all_items,
        // Read side.
        // Write side (2026-08-15) — every mutator snapshots the DB first.
        // AI auto-categorisation: propose (read-only) then apply.
        // -- MEMORY CORE: health only (recall_hybrid retired Ola 0; memory_health still used by MemoryStatusCard) --
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
        // Memory -> Retrato (2026-09-16): retrato del usuario generado por
        // scripts/memory-portrait.mjs; leer, marcar afirmaciones y regenerar.
        commands::memory::memory_portrait_get,
        commands::memory::memory_portrait_mark,
        commands::memory::memory_portrait_regenerate,
        // Retrieval Inspector (wiring 2026-08-10, audit 08-09 #34): traza
        // completa del recall (dense/sparse/fused + injected/discarded con
        // razon) + rebuild manual del indice denso. Construidos en jun-26,
        // registrados HOY — el panel vive en Memory -> Inspector.
        commands::memory::recall_inspect,
        commands::memory::memory_reindex,
        // -- MEMORY KERNEL: Session Resume — SIN comando Tauri a proposito
        //    (audit 08-09 #44): el resume sale por el sidecar
        //    `ultron-memory.exe resume` via hook SessionStart, no por invoke. --
        // -- AUTO-ROUTING #7: agent/skill catalog index + semantic route --
        // Wiring 2026-08-11 (audit 08-09 #40): reindex manual + buscador
        // semantico en Library -> Routing. Antes solo el warm-up de setup()
        // tocaba el catalogo y un fallo quedaba invisible ("catalog warm
        // skipped"); ahora hay boton de reindex y prueba de routing manual.
        commands::memory::catalog_reindex,
        commands::memory::catalog_reindex_skills,
        commands::memory::catalog_search,
        // -- ORCHESTRATOR "Ultron": prompt -> intent -> workflow -> agent -> memory --
        orchestrator::orchestrate_prompt,
        // -- PERSONALITIES v1 (2026-08-13): tonos editables + playground de deteccion --
        // Library -> Tones sobre ~/.ultron/personality.json; la deteccion vive
        // DENTRO de orchestrate() (hot path del sidecar, cero hooks nuevos).
        orchestrator::personalities_load,
        orchestrator::personalities_save,
        orchestrator::personalities_detect,
        // -- CUSTOM WORDS (2026-08-13): status por tono + spinner de Claude Code --
        orchestrator::tone_status_load,
        orchestrator::tone_status_save,
        orchestrator::spinner_verbs_load,
        orchestrator::spinner_verbs_save,
        // -- Resumen REAL de sesión vía AI Router (lazy, cacheado por session_id+hash) --
        // Restaurado 2026-07-20: d811828 lo borró como "0 consumidores" pero
        // SessionCard.tsx lo invoca (audit ultracode cat10/cat14).
        commands::session_summary::summarize_session_activity,
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
        // -- mar.ia: orbe + estado de voz --
        maria::voice::maria_voice_start,
        maria::voice::maria_voice_running,
        maria::voice::maria_voice_wake,
        maria::voice::maria_voice_ask,
        maria::quota::maria_quota_windows,
        maria::sysinfo::maria_telemetry,
        maria::models::maria_models_catalog,
        maria::local::maria_local_status,
        maria::login::maria_login_status,
        maria::cuentas::maria_cuentas_informe,
        maria::criterio::maria_criterio_get,
        maria::criterio::maria_criterio_set,
        maria::criterio::maria_criterio_reset,
        maria::perfiles::maria_perfiles_listar,
        maria::perfiles::maria_perfil_guardar,
        maria::perfiles::maria_perfil_activar,
        maria::perfiles::maria_perfil_borrar,
        maria::perfiles::maria_cuenta_cerrar_sesion,
        maria::perfiles::maria_clave_borrar,
        maria::teclado::maria_teclado_get,
        maria::teclado::maria_teclado_set,
        maria::login::maria_login_open,
        maria::relay::maria_relay_ask,
        maria::flujo::maria_relay_cancel,
        maria::artefactos::maria_artefacto_publicar,
        maria::artefactos::maria_artefacto_guardar,
        maria::encargos::maria_encargo_lanzar,
        maria::encargos::maria_encargos,
        maria::encargos::maria_encargo_cancelar,
        maria::paneles::maria_ficheros,
        maria::paneles::maria_fichero_leer,
        maria::paneles::maria_carpeta_de,
        maria::paneles::maria_web_ventana,
        maria::relay::maria_relay_truncar,
        maria::relay::maria_relay_ramas,
        maria::relay::maria_relay_rama_restaurar,
        maria::relay::maria_relay_exportar,
        maria::threads::maria_thread_project,
        maria::capacidades::maria_capacidades,
        maria::capacidades::maria_compartir_mcps,
        maria::adjuntos::maria_adjunto_guardar,
        maria::relay::maria_relay_thread,
        maria::relay::maria_relay_state,
        maria::relay::maria_relay_config,
        maria::threads::maria_threads_list,
        // Buscar DENTRO de las conversaciones. Lo llama la caja «buscar…» de
        // jarvis/ThreadSidebar.tsx, que hasta el 2026-09-22 solo miraba el
        // titulo (y el titulo lo pone una IA a posteriori).
        maria::threads::maria_threads_buscar,
        maria::threads::maria_thread_create,
        maria::threads::maria_thread_pin,
        maria::threads::maria_thread_rename,
        maria::threads::maria_thread_folder,
        maria::threads::maria_thread_close,
        maria::threads::maria_thread_autotitle,
        maria::threads::maria_thread_delete,
        maria::term::maria_term_open,
        maria::term::maria_term_subscribe,
        maria::term::maria_term_write,
        maria::term::maria_term_resize,
        maria::term::maria_term_kill,
        maria::term::maria_term_list,
        maria::arranque::maria_arranque_estado,
        maria::arranque::maria_arranque_set,
        maria::voice::maria_voice_wake_status,
        maria::tailscale::maria_tailscale_diagnostico,
        maria::web::maria_web_status,
        maria::web::maria_web_set,
        maria::web::maria_web_test_notify,
        // -- project detach / reattach (ventanas independientes) --
        commands::detach::detach_project_window,
        // -- OpenGL/vcpkg project scaffolder (v2.5.2 — replaces crear_proyecto.bat) --
        // -- global notes (memory context pipeline) --
        // -- local Knowledge Graph editor (Control Center-owned, v2.6 fb-047) --
        // kg commands des-registrados: lógica viva en src/kg.rs (create/delete entity, search).
        // memory_graph (unified search + tree snapshot) borrado entero 2026-07-04 (0 callers).
        // -- sessions --
        commands::sessions::spawn_session,
        commands::sessions::list_claude_sessions,
        commands::sessions::list_workspaces,
        // Transcript completo paginado (navegador de conversaciones 2026-09-17):
        // lo consume src/components/conversations/.
        commands::session_transcript::read_session_transcript,
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
        // -- system / scheduled tasks (wiring 2026-08-11, audit 08-09 #35:
        //    construidos may-26, registrados HOY; panel System -> Tasks;
        //    gate "solo ULTRON-*" vive en los inners) --
        commands::system::list_scheduled_tasks,
        commands::system::run_scheduled_task,
        commands::system::task_detail,
        commands::system::rich_system_info,
        commands::system::edit_scheduled_task,
        commands::system::delete_scheduled_task,
        // -- Turn Off: apagado programado via shutdown.exe (Windows-only;
        //    panel System -> Turn Off) --
        // -- installed apps --
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
        // -- library (P5 — install from GitHub + per-project pin) --
        commands::library::library_install_from_github,
        // 2026-09-22: Destacados. Sustituyen a github_search_repos /
        // github_search_trending / library_search_github, que lanzaban la CLI
        // `gh` (ausente en esta maquina) y concatenaban topics con AND.
        commands::library::repos_buscar,
        commands::library::repos_detalle,
        commands::library::repos_aplicar,
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
        // Lo llama el panel Cambios del chat (`jarvis/PanelLateral.tsx`), que
        // desde el 2026-09-22 deja preparar, descartar y confirmar sin salir.
        commands::projects::git_discard_file,
        commands::projects::git_log_full,
        commands::projects::codegraph_is_indexed,
        commands::projects::codegraph_summary,
        commands::projects::open_project_terminal,
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
        // -- AI Router (zone -> provider routing, providers catalog, --
        // -- health checks, metrics, end-to-end zone test) --
        // P1 2026-05-27: key-aware routing — validate keys + disabled list
        // -- quota watchdog (P0 2026-05-27 — 98% auto-fallback) --
        // -- proxy free-tier lifecycle (NVIDIA NIM via claude-code-proxy) --
        // -- Ollama (modelo local) — AI Router > Modelo local; el interruptor
        // -- simple de la bandeja no pasa por aqui, habla directo con
        // -- ollama::toggle. --
        // -- workflow YAML composability + SQLite run history (KIRKARDO 23
        //    P2; wiring 2026-08-11, audit #32: los 6 llevaban desde jun-26
        //    sin registrar y la tabla se creaba vacía en cada boot. El
        //    escritor real es delegate.rs; el historial vive en el
        //    LiveSessionMonitor) --
    ]
}
