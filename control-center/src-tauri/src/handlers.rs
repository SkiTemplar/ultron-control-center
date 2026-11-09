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
        commands::misc::ultron_root_str,
        commands::misc::instruction_path,
        commands::misc::claude_usage,
        // Cuota del plan (2026-09-21): la ventana de 5h y la semanal vienen del
        // endpoint OAuth de Anthropic, no de ningun fichero local — eran el
        // unico dato de /usage que obligaba a abrir una terminal.
        commands::misc::claude_plan_limits,
        // Horario de uso (cockpit/usage-schedule.json) para ponderar el ritmo semanal
        // de la tarjeta igual que la statusline y el hook usage-pace-guard.
        commands::misc::usage_schedule_get,
        // Wiring 2026-08-11 (audit 08-09 #43): heatmap dia x fuente +
        // eventos recientes en Usage -> Activity.
        commands::misc::compute_activity_timeline,
        // -- Lab TFG (wiring 2026-08-12): deteccion determinista de patrones
        //    de texto IA sobre el catalogo docs/research/patrones-texto-ia.json.
        //    Consume la pestana Lab (Detector + Catalogo). --
        tfg_lab::tfg_catalog_load,
        tfg_lab::tfg_detect,
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
        commands::mcps::add_mcp,
        commands::mcps::update_mcp,
        commands::mcps::delete_mcp,
        commands::mcps::mcp_ping,
        commands::mcps::mcp_set_disabled,
        commands::mcps::mcp_account_templates,
        commands::mcps::mcp_accounts_list,
        commands::mcps::mcp_account_add,
        commands::mcps::mcp_account_remove,
        mcps::commands::mcp_get_config,
        mcps::commands::mcp_health_check_all,
        // -- Settings > Cuentas y modelos (read-only CLI account/model report) --
        commands::accounts::accounts_report,
        commands::accounts::accounts_refresh_models,
        // -- Settings > Herramientas (read-only CLI install/version report) --
        commands::tools::tools_status,
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
        // FRENTE D (2026-09-10): boton "Abrir app" en la tarjeta de proyecto
        // — lanza project.app_command en una terminal nueva (cwd = path).
        commands::projects::project_open_app,
        // 2026-10-28: boton "Jugar" de los proyectos de Unreal/Unity (abre el
        // juego sin editor; projects/game.rs + game_launch.rs).
        commands::projects::project_play_game,
        // -- asistente "Nuevo proyecto" (wiring 2026-09-14): wrapper del CLI
        //    ~/.ultron/scripts/project-create.mjs (roots/list/templates/
        //    subject/mkdir/create) que consume NewProjectWizard.tsx. --
        commands::projects::project_create_cli,
        // -- uso de Claude Code por proyecto (tarjeta "Uso" de ProjectWorkspace; script
        //    ~/.ultron/scripts/project-usage.mjs). --
        commands::projects::project_usage,
        // -- editor CLAUDE.md por proyecto (wiring 2026-08-11, audit #39;
        //    modal en ProjectWorkspace, fila Codigo). --
        // -- Bitacora (2026-09-21): el historial de resumenes por sesion, que
        //    hasta ahora solo leia el hook de SessionStart, se ve en el
        //    workspace del proyecto. --
        commands::projects::project_session_log,
        commands::projects::project_session_entry,
        commands::projects::project_claude_md_load,
        commands::projects::project_claude_md_save,
        commands::projects::project_create_claude_md,
        commands::projects::add_launcher_item,
        commands::projects::remove_launcher_item,
        commands::projects::launch_item,
        commands::projects::launch_all_items,
        // -- FINANCE: native dashboard + write path of the Bank/finanzas project --
        // Requires --features finance (local-only; finance/ excluded from public repo).
        // Read side.
        #[cfg(feature = "finance")]
        finance::finance_overview,
        #[cfg(feature = "finance")]
        finance::finance_categorias_list,
        #[cfg(feature = "finance")]
        finance::finance_sync,
        #[cfg(feature = "finance")]
        finance::finance_open_setup,
        // Write side (2026-08-15) — every mutator snapshots the DB first.
        #[cfg(feature = "finance")]
        finance::finance_fondo_upsert,
        #[cfg(feature = "finance")]
        finance::finance_fondo_delete,
        #[cfg(feature = "finance")]
        finance::finance_fondos_clear,
        #[cfg(feature = "finance")]
        finance::finance_fondo_aportar,
        #[cfg(feature = "finance")]
        finance::finance_recalibrar_saldo,
        #[cfg(feature = "finance")]
        finance::finance_set_limite,
        #[cfg(feature = "finance")]
        finance::finance_set_config,
        #[cfg(feature = "finance")]
        finance::finance_movimiento_set_categoria,
        #[cfg(feature = "finance")]
        finance::finance_backup_db,
        // AI auto-categorisation: propose (read-only) then apply.
        #[cfg(feature = "finance")]
        finance::finance_ai_rank,
        #[cfg(feature = "finance")]
        finance::finance_ai_rank_apply,
        // -- MEMORY CORE: salud y contadores para la tarjeta "Sistema de memoria" del Panel --
        // La pestaña Memory (bandeja, navegador, inspector y retrato) y la
        // subpestaña Library -> Routing se retiraron el 2026-10-18 junto con sus
        // comandos: la memoria se gobierna por hooks y por el sidecar
        // `ultron-memory.exe` (inbox, recall, reindex), sin invoke desde la GUI.
        commands::memory::memory_health,
        commands::memory::memory_stats,
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
        commands::batches::batch_read_script,
        commands::batches::execute_batch,
        commands::batches::delete_batch_single,
        commands::batches::clear_all_batches,
        commands::batches::batches_list_queue,
        commands::batches::batches_requeue,
        commands::batches::batches_dismiss_queue,
        // -- project detach / reattach (ventanas independientes) --
        commands::detach::detach_project_window,
        // <WP-ESTADO> ventana «ULTRON Sessions» (docs/sesiones/CONTRATO*.md)
        sesiones::comandos::sesiones_open_window,
        sesiones::comandos::sesiones_list,
        sesiones::comandos::sesiones_past,
        sesiones::comandos::sesiones_send,
        sesiones::comandos::sesiones_rename,
        sesiones::comandos::sesiones_history,
        sesiones::comandos::sesiones_files,
        sesiones::comandos::sesiones_agents,
        sesiones::comandos::sesiones_workflows,
        sesiones::comandos::sesiones_answer,
        sesiones::comandos::sesiones_save_attachment,
        sesiones::comandos::sesiones_read_image,
        sesiones::comandos::sesiones_usage,
        sesiones::comandos_v2::sesiones_launch,
        sesiones::comandos_v2::sesiones_settings,
        sesiones::comandos_v2::sesiones_set_effort,
        sesiones::comandos_v2::sesiones_set_model,
        sesiones::comandos_v2::sesiones_set_socratic,
        sesiones::comandos_v2::sesiones_prompt_history,
        sesiones::comandos_v2::sesiones_commands,
        sesiones::comandos_v2::sesiones_bitacora,
        sesiones::comandos_v2::sesiones_engines,
        sesiones::comandos_v2::sesiones_engine_run,
        sesiones::comandos_v2::sesiones_engine_bring,
        sesiones::comandos_v2::sesiones_engine_cancel,
        sesiones::comandos_v2::sesiones_engine_list,
        sesiones::comandos_v2::sesiones_relay_list,
        sesiones::comandos_v2::sesiones_relay_switch_gemini,
        sesiones::comandos_v2::sesiones_relay_return,
        sesiones::comandos_v2::sesiones_engine_clear,
        sesiones::comandos_v2::sesiones_engine_contrast,
        sesiones::comandos_v2::sesiones_engine_models,
        sesiones::comandos_motor_sesion::sesiones_engine_session_create,
        sesiones::comandos_motor_sesion::sesiones_engine_session_send,
        sesiones::comandos_motor_sesion::sesiones_engine_session_interrupt,
        sesiones::comandos_motor_sesion::sesiones_engine_session_past,
        sesiones::comandos_v2::sesiones_transcribe,
        sesiones::comandos::sesiones_usage_pace,
        sesiones::comandos::sesiones_engines_usage,
        sesiones::comandos::sesiones_open_image,
        sesiones::comandos::sesiones_reveal_path,
        sesiones::comandos::sesiones_open_file,
        sesiones::comandos::sesiones_paths_status,
        sesiones::comandos::sesiones_turn_edits,
        sesiones::comandos::sesiones_open_in_editor,
        sesiones::comandos::sesiones_save_image,
        sesiones::comandos::sesiones_export,
        sesiones::comandos::sesiones_export_open,
        sesiones::comandos_v2::sesiones_mejorar,
        sesiones::comandos_v2::sesiones_new_window,
        sesiones::comandos_v2::sesiones_open_control_center,
        // contrato de estabilidad (§7.1)
        sesiones::comandos_v2::sesiones_run_command,
        sesiones::comandos_v2::sesiones_pending_asks,
        sesiones::comandos_v2::sesiones_queue_list,
        sesiones::comandos_v2::sesiones_queue_enqueue,
        sesiones::comandos_v2::sesiones_queue_update,
        sesiones::comandos_v2::sesiones_queue_remove,
        sesiones::comandos_v2::sesiones_queue_move,
        sesiones::comandos_v2::sesiones_queue_send_now,
        sesiones::comandos_v2::sesiones_queue_retry,
        sesiones::comandos_v2::sesiones_prefs_get,
        sesiones::comandos_v2::sesiones_prefs_set,
        // </WP-ESTADO>
        // <WP-PTY>
        sesiones::comandos_pty::sesiones_create,
        sesiones::comandos_pty::sesiones_key,
        sesiones::comandos_pty::sesiones_kill,
        sesiones::proteccion::sesiones_busy,
        sesiones::comandos_pty::sesiones_terminal_attach,
        sesiones::comandos_pty::sesiones_terminal_detach,
        sesiones::comandos_pty::sesiones_terminal_resize,
        sesiones::comandos_pty::sesiones_terminal_restore_size,
        sesiones::comandos_pty::sesiones_recover,
        sesiones::comandos_forzar::sesiones_background,
        sesiones::comandos_forzar::sesiones_interrupt_send,
        sesiones::comandos_pty::sesiones_trust_answer,
        sesiones::comandos_pty::sesiones_dialog_answer,
        sesiones::comandos_pty::sesiones_terminal_input,
        sesiones::comandos_pty::sesiones_set_permission_mode,
        sesiones::comandos_pty::sesiones_log_dir,
        sesiones::incidentes::sesiones_incident,
        // </WP-PTY>
        // <WP-MOTORES>
        sesiones::ventana::sesiones_preview_put,
        sesiones::barra_lateral::sesiones_rail_report,
        sesiones::foco_sesion::sesiones_focus_session,
        sesiones::modelos::sesiones_engine_effort_get,
        sesiones::modelos::sesiones_engine_effort_set,
        // </WP-MOTORES>
        // -- mascota de escritorio (ventana «mascot» + Settings → Mascota) --
        mascot::mascot_get_settings,
        mascot::mascot_save_settings,
        mascot::mascot_summon,
        mascot::mascot_env,
        mascot::mascot_cursor,
        mascot::mascot_windows,
        mascot::mascot_set_interactive,
        mascot::drop_assist::mascot_pet_rect,
        mascot::mascot_focus,
        mascot::mascot_ask,
        mascot::chat_log::mascot_chat_load,
        mascot::chat_log::mascot_chat_save,
        mascot::chat_log::mascot_chat_archive,
        mascot::mascot_bridge_status,
        mascot::mascot_register_mcp,
        mascot::mascot_open_url,
        mascot::approve::mascot_approve_answer,
        mascot::permission::mascot_session_context,
        mascot::screens::mascot_screens,
        mascot::screens::mascot_move_to_screen,
        mascot::screens::mascot_set_hidden,
        mascot::screens::mascot_hidden_status,
        mascot::open::mascot_open_file,
        mascot::explorer::mascot_file_at,
        mascot::mascot_open_settings,
        mascot::context::mascot_foreground,
        mascot::presence::mascot_presence,
        mascot::media::mascot_media,
        mascot::taskbar::mascot_taskbar,
        mascot::mascot_nudge_cursor,
        mascot::alerts::mascot_desk_alerts,
        mascot::targets::mascot_target_window,
        mascot::sessions_surfaces::mascot_sessions_surfaces,
        mascot::calendar::mascot_calendar_today,
        mascot::calendar::mascot_calendar_status,
        mascot::calendar::mascot_calendar_set_url,
        mascot::calendar::mascot_calendar_refresh,
        // -- global notes (memory context pipeline) --
        commands::notes::notes_list_global,
        commands::notes::notes_load_global,
        commands::notes::notes_save_global,
        commands::notes::notes_delete_global,
        // -- local Knowledge Graph editor (Control Center-owned, v2.6 fb-047) --
        // kg commands des-registrados: lógica viva en src/kg.rs (create/delete entity, search).
        // memory_graph (unified search + tree snapshot) borrado entero 2026-07-04 (0 callers).
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
        commands::settings::remove_env_key,
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
        commands::turn_off::turn_off_schedule,
        commands::turn_off::turn_off_cancel,
        commands::turn_off::turn_off_status,
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
        // -- library (P5 — GitHub install + per-project pin) --
        // v2.6.1: GitHub repo discovery for Catalog tab.
        commands::library::github_search_repos,
        commands::library::github_search_trending,
        commands::library::agent_create,
        commands::library::skill_create,
        // v2.6 (v27-f14): sibling-file listing for Skills/Agents detail.
        commands::library::list_skill_files,
        // FRENTE 7: analizar repo local + integrar al routing/memoria
        commands::library::analyze_local_repo,
        // -- git ops por proyecto --
        commands::projects::git_pull,
        commands::projects::git_push,
        commands::projects::git_publish,
        commands::projects::git_init,
        commands::projects::git_fetch,
        commands::projects::git_repo_state,
        commands::projects::git_repo_snapshot,
        // micro GitHub Desktop: changed files, per-file diff, stage, commit, log
        commands::projects::git_diff_file,
        commands::projects::git_stage,
        commands::projects::git_unstage,
        commands::projects::git_commit,
        commands::projects::git_log_full,
        commands::projects::codegraph_is_indexed,
        commands::projects::codegraph_summary,
        // visor CodeGraph (pilar 3): lecturas de solo lectura del índice
        commands::projects::codegraph_files,
        commands::projects::codegraph_search,
        commands::projects::codegraph_neighborhood,
        commands::projects::open_project_terminal,
        commands::projects::codegraph_init_project,
        // -- kanban (P4) --
        commands::kanban::kanban_load,
        commands::kanban::kanban_create_card,
        commands::kanban::kanban_update_card,
        commands::kanban::kanban_move_card,
        commands::kanban::kanban_delete_card,
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
        ai_router::ai_router_list_zones,
        ai_router::ai_router_save_zone,
        ai_router::ai_router_list_providers,
        ai_router::ai_router_health,
        ai_router::ai_router_metrics,
        ai_router::ai_router_usage_summary,
        // P1 2026-05-27: key-aware routing — validate keys + disabled list
        ai_router::ai_router_validate_keys,
        // 2026-10-26: delegador multi-motor + proveedores por protocolo
        // (plans/2026-10-26-delegador-multi-motor.md §4)
        ai_router::delegation::ai_router_get_delegation,
        ai_router::delegation::ai_router_set_delegation,
        ai_router::delegation_runtime::ai_router_delegation_status,
        ai_router::delegation_runtime::ai_router_delegation_ledger,
        ai_router::discover::ai_router_discover_models,
        ai_router::custom::ai_router_upsert_custom_provider,
        ai_router::custom::ai_router_remove_custom_provider,
        // -- quota watchdog (P0 2026-05-27 — 98% auto-fallback) --
        // -- proxy free-tier lifecycle (NVIDIA NIM via claude-code-proxy) --
        proxy::proxy_health,
        proxy::proxy_state_enabled,
        proxy::proxy_set_enabled,
        // -- Ollama (modelo local) — AI Router > Modelo local. El unico mando
        // -- del modelo es el motor del editor (editor_engine_set); la bandeja
        // -- no pasa por aqui, llama a ollama::engine::set_engine_blocking. --
        ollama::commands::ollama_status,
        ollama::commands::ollama_benchmark,
        ollama::commands::ollama_pull,
        ollama::commands::ollama_delete,
        ollama::commands::editor_engine_status,
        ollama::commands::editor_engine_set,
        // -- workflow YAML composability + SQLite run history (KIRKARDO 23
        //    P2; wiring 2026-08-11, audit #32). El escritor real de runs es
        //    batches.rs (record_run_inner/update_run_inner); workflow_record_run/
        //    workflow_update_run/workflow_set_state/workflow_get_state nunca
        //    tuvieron llamador en la UI y se podaron el 2026-09-23. --
        commands::workflows::workflow_get_runs,
        commands::workflows::workflow_load_user_defined,
    ]
}
