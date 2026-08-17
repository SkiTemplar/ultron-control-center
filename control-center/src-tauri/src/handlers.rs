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
        // -- workflow YAML composability + SQLite run history (KIRKARDO 23
        //    P2; wiring 2026-08-11, audit #32: los 6 llevaban desde jun-26
        //    sin registrar y la tabla se creaba vacía en cada boot. El
        //    escritor real es delegate.rs; el historial vive en el
        //    LiveSessionMonitor) --
        commands::workflows::workflow_record_run,
        commands::workflows::workflow_update_run,
        commands::workflows::workflow_get_runs,
        commands::workflows::workflow_load_user_defined,
        commands::workflows::workflow_set_state,
        commands::workflows::workflow_get_state,
    ]
}
