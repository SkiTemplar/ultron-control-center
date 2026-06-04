# UI <-> Backend Alignment Map

> Mapa de alineacion entre los comandos Tauri registrados en el backend
> (`control-center/src-tauri/src/lib.rs`, bloque `generate_handler!`) y los
> call-sites reales del frontend (`control-center/src/`, `invoke(...)`).
>
> - **Fecha**: 2026-06-04
> - **HEAD**: f936a66
> - **Backend**: `src-tauri/src/lib.rs:180-568` (un unico `invoke_handler`)
> - **Frontend**: 233 call-sites `invoke()` en 64 ficheros `.ts`/`.tsx`
> - **Metodo**: extraccion del bloque `generate_handler!` (ultimo segmento
>   `::` de cada entrada) cruzada con todos los `invoke("cmd"...)` /
>   `invoke<T>("cmd"...)` (incluyendo formato multilinea) del frontend.
> - **No se edito codigo.** Solo lectura + este documento.

---

## Resumen por categoria

| Cat | Nombre | Definicion | Comandos |
|-----|--------|------------|---------:|
| **A** | LIVE | Registrado **y** con caller UI real (`invoke` en `.tsx`/`.ts`) | **167** |
| **B** | BACKEND-ONLY-INTENCIONAL | Registrado, sin caller UI; consumido por hooks / CLI / sidecar / setup interno / palette dinamico futuro | **72** |
| **C** | CONSERVAR-FUTURA-UI (MEMORY KERNEL) | Registrado, sin caller UI; **decision de USER**: conservar para la UI de revision de memoria (Inbox + Inspector + governance) | **18** |
| **D** | PODABLE | Registrado, sin caller UI; feature muerta (workday salvo `record_kanban_event`, kg, decisions, mem0 salvo `status`, Memory-tab legacy/ECC/graphify) | **66** |
| | **TOTAL registrado** | | **323** |

**Cuadre**: 167 (A) + 72 (B) + 18 (C) + 66 (D) = **323** = total de comandos
registrados en `generate_handler!`. OK.

### Invokes rotos (frontend -> comando NO registrado)

| Comando invocado | Call-site frontend | Estado | Nota |
|------------------|--------------------|--------|------|
| `quota_get_status` | `components/Sidebar.tsx:234` (`invoke<QuotaDotStatus>("quota_get_status")`) | **ROTO (real)** | El watchdog de quota fue quitado en `cbb2d5c`; `QuotaDot` sigue invocando un comando inexistente. El `invoke` rechaza pero esta envuelto en `.catch(() => {})` (Sidebar.tsx:236-241), por eso falla en silencio. Tambien escucha eventos `quota:updated/critical/reset` que ya nadie emite. **Podar `QuotaDot` + `useQuotaDot`.** |
| `recall_semantic` | `types.ts:1065`, `types.ts:1085` | **No es call-site** | Aparece solo dentro de comentarios JSDoc (`/** ... invoke("recall_semantic", ...) */`), no es una llamada real. `recall_semantic` se retiro en Ola 0 (path 384d legacy). Referencia documental obsoleta: limpiar el comentario, sin impacto runtime. |

> Solo **1 invoke roto real** (`quota_get_status`). El segundo match es texto
> en un comentario, no ejecuta.

---

## (A) LIVE — registrado + caller UI real (167)

Evidencia: `lib.rs:<linea de registro>` -> primer call-site UI
`fichero:linea` (relativo a `control-center/src/`).

| Comando | Registro (lib.rs) | Caller UI (primero) |
|---------|-------------------|---------------------|
| `add_hook` | 445 | `components/Hooks.tsx:1291` |
| `add_launcher_item` | 255 | `components/Projects.tsx:399` |
| `add_mcp` | 203 | `components/MCPs.tsx:1090` |
| `add_plan` | 438 | `components/Plans.tsx:740` |
| `agent_create` | 479 | `lib/library-client.ts:46` |
| `agent_toggle` | 224 | `components/Agents.tsx:542` |
| `agents_bulk_toggle` | 225 | `components/Agents.tsx:598` |
| `ai_router_health` | 546 | `components/AIRouter/ProviderCatalog.tsx:241` |
| `ai_router_list_providers` | 545 | `components/AIRouter/AIRouterIndex.tsx:189` |
| `ai_router_list_zones` | 542 | `components/AIRouter/AIRouterIndex.tsx:177` |
| `ai_router_metrics` | 547 | `components/AIRouter/RouterMetrics.tsx:115` |
| `ai_router_test` | 548 | `components/AIRouter/ZoneEditor.tsx:353` |
| `ai_router_update_zone` | 544 | `components/AIRouter/ZoneEditor.tsx:326` |
| `ai_router_usage_summary` | 550 | `components/AIRouter/RouterDashboard.tsx:49` |
| `analyze_catalog_compat` | 489 | `components/library/Catalog.tsx:582` |
| `analyze_diagnostic_with_ai` | 426 | `components/system/Diagnostics.tsx:554` |
| `analyze_hook_name` | 453 | `components/Hooks.tsx:395` |
| `auth_status` | 422 | `components/AuthStatus.tsx:63` |
| `auto_archive_resolved_plans` | 442 | `components/Plans.tsx:680` |
| `backup_status` | 399 | `components/dashboard/BackupCard.tsx:62` |
| `batches_dismiss_queue` | 300 | `components/projects/BatchDropdown.tsx:184` |
| `batches_list_queue` | 298 | `components/projects/BatchDropdown.tsx:126` |
| `batches_requeue` | 299 | `components/projects/BatchDropdown.tsx:160` |
| `bulk_analyze_hook_names` | 454 | `components/Hooks.tsx:409` |
| `check_for_updates` | 245 | `components/UpdateBanner.tsx:73` |
| `claude_usage` | 188 | `components/Usage.tsx:693` |
| `clean_resolved_plans` | 441 | `components/Plans.tsx:844` |
| `cleanup_old_batches` | 296 | `components/projects/BatchDropdown.tsx:550` |
| `clear_all_batches` | 297 | `components/projects/BatchDropdown.tsx:479` |
| `close_control_center` | 423 | `components/Settings/LifecyclePanel.tsx:256` |
| `compute_activity_timeline` | 189 | `components/ActivityTimeline.tsx:167` |
| `create_opengl_project` | 307 | `components/projects/NewOpenGlProjectModal.tsx:116` |
| `create_project` | 251 | `components/Projects.tsx:337` |
| `delegate_task_launch` | 230 | `components/Agents.tsx:122` |
| `delete_alert_entries` | 197 | `components/Notifications.tsx:706` |
| `delete_batch_single` | 295 | `components/projects/BatchDropdown.tsx:297` |
| `delete_hook` | 448 | `components/Hooks.tsx:364` |
| `delete_mcp` | 205 | `components/MCPs.tsx:1143` |
| `delete_plan` | 440 | `components/Plans.tsx:762` |
| `delete_project` | 253 | `components/Projects.tsx:291` |
| `detach_project_window` | 303 | `components/projects/ProjectWorkspace.tsx:250` |
| `diagnostic_history_list` | 427 | `components/system/DiagnosticHistoryPanel.tsx:30` |
| `diagnostic_history_read` | 428 | `components/system/DiagnosticHistoryPanel.tsx:37` |
| `diagnostic_schedule_get` | 429 | `components/system/DiagnosticSchedulePanel.tsx:23` |
| `diagnostic_schedule_set` | 430 | `components/system/DiagnosticSchedulePanel.tsx:36` |
| `diagnostics_run` | 431 | `components/system/Diagnostics.tsx:566` |
| `event_log_recent` | 433 | `components/dashboard/CrashEventsCard.tsx:58` |
| `execute_batch` | 294 | `components/projects/BatchDropdown.tsx:221` |
| `generate_mcp_from_prompt` | 206 | `components/MCPs.tsx:1167` |
| `get_backup_root` | 397 | `components/Settings/BackupsSection.tsx:163` |
| `get_backup_schedule` | 402 | `components/Settings/BackupsSection.tsx:183` |
| `get_backup_sources` | 400 | `components/Settings/BackupsSection.tsx:172` |
| `get_env_keys_status` | 406 | `components/Settings/ApiKeysSection.tsx:151` |
| `get_global_hotkey` | 525 | `components/Settings/LifecyclePanel.tsx:27` |
| `get_hook_descriptions` | 456 | `components/Hooks.tsx:300` |
| `get_hook_names_cache` | 455 | `components/Hooks.tsx:291` |
| `get_in_app_shortcuts` | 536 | `App.tsx:145` |
| `github_search_repos` | 477 | `components/library/Catalog.tsx:528` |
| `github_search_trending` | 478 | `components/library/Catalog.tsx:524` |
| `home_dir_str` | 183 | `lib/paths.ts:26` |
| `hooks_last_fired` | 452 | `components/Hooks.tsx:328` |
| `instruction_path` | 187 | `components/MCPs.tsx:1266` |
| `kanban_add_column` | 512 | `components/projects/ProjectBoard.tsx:162` |
| `kanban_archive_done` | 509 | `components/projects/ProjectBoard.tsx:283` |
| `kanban_create_card` | 503 | `components/projects/CardEditorModal.tsx:92` |
| `kanban_delete_card` | 506 | `components/projects/ProjectBoard.tsx:123` |
| `kanban_delete_column` | 513 | `components/projects/ProjectBoard.tsx:177` |
| `kanban_dispatch_card` | 507 | `components/projects/CardEditorModal.tsx:130` |
| `kanban_list_archives` | 510 | `components/projects/ProjectBoard.tsx:264` |
| `kanban_load` | 501 | `components/Projects.tsx:152` |
| `kanban_load_archive` | 511 | `components/projects/ProjectBoard.tsx:300` |
| `kanban_move_card` | 505 | `components/projects/ProjectBoard.tsx:84` |
| `kanban_rename_column` | 514 | `components/projects/ProjectBoard.tsx:146` |
| `kanban_reorder_columns` | 515 | `components/projects/ProjectBoard.tsx:215` |
| `kanban_update_card` | 504 | `components/projects/CardEditorModal.tsx:105` |
| `launch_all_items` | 259 | `components/Projects.tsx:246` |
| `launch_item` | 258 | `components/Projects.tsx:237` |
| `library_install_from_github` | 473 | `lib/library-client.ts:42` |
| `library_install_via_ai` | 487 | `components/library/Catalog.tsx:635` |
| `library_list_pinned` | 483 | `lib/library-client.ts:68` |
| `library_pin_agent` | 481 | `lib/library-client.ts:57` |
| `library_search_github` | 472 | `lib/library-client.ts:29` |
| `library_unpin_agent` | 482 | `lib/library-client.ts:64` |
| `list_agents` | 218 | `components/Agents.tsx:456` |
| `list_all_plugins` | 459 | `components/Settings/PluginsSection.tsx:192` |
| `list_all_slash_commands` | 238 | `components/library/Commands.tsx:97` |
| `list_batches` | 293 | `components/projects/BatchDropdown.tsx:139` |
| `list_button_prompts` | 520 | `components/Settings/ButtonPromptsSection.tsx:88` |
| `list_claude_sessions` | 345 | `components/Sessions.tsx:583` |
| `list_delegations` | 226 | `components/Agents.tsx:424` |
| `list_hooks` | 444 | `components/Hooks.tsx:270` |
| `list_installed_apps` | 416 | `components/System.tsx:908` |
| `list_maintenance_commands` | 240 | `App.tsx:338` |
| `list_mcps` | 201 | `components/MCPs.tsx:972` |
| `list_plans` | 436 | `components/Plans.tsx:658` |
| `list_projects` | 248 | `components/Agents.tsx:447` |
| `list_skill_files` | 485 | `components/library/LibraryDetailPane.tsx:248` |
| `list_skills` | 209 | `components/Skills.tsx:295` |
| `list_skills_legacy` | 210 | `components/Skills.tsx:273` |
| `list_workspaces` | 346 | `components/Sessions.tsx:591` |
| `mcp_ping` | 207 | `components/MCPs.tsx:920` |
| `mem0_status` | 325 | `components/dashboard/Mem0Card.tsx:26` |
| `memory_health` | 264 | `components/dashboard/MemoryStatusCard.tsx:44` |
| `notes_delete_global` | 312 | `components/Notes.tsx:234` |
| `notes_list_global` | 309 | `components/Notes.tsx:92` |
| `notes_load_global` | 310 | `components/Notes.tsx:133` |
| `notes_save_global` | 311 | `components/Notes.tsx:163` |
| `open_app_folder` | 417 | `components/System.tsx:1002` |
| `open_in_vscode` | 193 | `components/library/LibraryDetailPane.tsx:302` |
| `open_project` | 249 | `App.tsx:216` |
| `open_project_in_ide` | 247 | `components/Projects.tsx:214` |
| `patch_plan_status` | 437 | `components/Plans.tsx:700` |
| `plugin_changelog_summary` | 464 | `components/Settings/PluginsSection.tsx:94` |
| `plugin_check_updates_bulk` | 463 | `components/Settings/PluginsSection.tsx:204` |
| `proxy_health` | 558 | `components/AIRouter/ProxyControl.tsx:82` |
| `proxy_set_enabled` | 560 | `components/AIRouter/ProxyControl.tsx:75` |
| `proxy_state_enabled` | 559 | `components/AIRouter/ProxyControl.tsx:101` |
| `pty_kill` | 467 | `components/projects/TabsBar.tsx:152` |
| `pty_list` | 468 | `components/Projects.tsx:157` |
| `purge_legacy_autostart` | 396 | `components/Settings/LifecyclePanel.tsx:193` |
| `read_alerts` | 196 | `App.tsx:73` |
| `read_changelog` | 198 | `App.tsx:79` |
| `read_features` | 538 | `lib/features.ts:61` |
| `read_plugin_info` | 458 | `components/dashboard/PluginStatusCard.tsx:23` |
| `read_text_file` | 194 | `components/library/LibraryDetailPane.tsx:224` |
| `recall_last_session_global` | 353 | `components/dashboard/ResumeSessionCard.tsx:45` |
| `recent_hook_fires` | 450 | `components/Hooks.tsx:282` |
| `record_ui_alert` | 199 | `lib/notify.ts:73` |
| `remove_launcher_item` | 256 | `components/Projects.tsx:260` |
| `request_hook_via_ai` | 451 | `components/Hooks.tsx:378` |
| `reset_button_prompt` | 522 | `lib/button-prompts.ts:105` |
| `rules_list` | 234 | `components/Rules.tsx:71` |
| `rules_write` | 236 | `components/Rules.tsx:165` |
| `run_app_lifecycle` | 243 | `components/UpdateBanner.tsx:115` |
| `run_backup_now` | 242 | `components/dashboard/BackupCard.tsx:92` |
| `run_diagnostic_native` | 425 | `components/system/Diagnostics.tsx:523` |
| `run_maintenance_command` | 241 | `components/system/Diagnostics.tsx:584` |
| `run_mcp_health_check` | 202 | `components/MCPs.tsx:1026` |
| `save_features` | 539 | `lib/features.ts:120` |
| `scan_projects` | 250 | `components/Projects.tsx:170` |
| `set_backup_root` | 398 | `components/Settings/BackupsSection.tsx:232` |
| `set_backup_schedule` | 403 | `components/Settings/BackupsSection.tsx:323` |
| `set_backup_sources` | 401 | `components/Settings/BackupsSection.tsx:293` |
| `set_default_provider` | 254 | `components/Projects.tsx:284` |
| `set_env_vars_keys` | 405 | `components/Settings/ApiKeysSection.tsx:199` |
| `set_global_hotkey` | 526 | `components/Settings/LifecyclePanel.tsx:45` |
| `settings_read` | 394 | `components/MCPs.tsx:735` |
| `settings_save` | 395 | `components/MCPs.tsx:769` |
| `skill_create` | 480 | `lib/library-client.ts:50` |
| `skill_toggle` | 211 | `components/Skills.tsx:336` |
| `skills_bulk_toggle` | 212 | `components/Skills.tsx:382` |
| `spawn_session` | 343 | `components/AuthStatus.tsx:85` |
| `tabs_load` | 517 | `state/ProjectsTabsContext.tsx:65` |
| `tabs_save` | 518 | `state/ProjectsTabsContext.tsx:88` |
| `test_hook` | 449 | `components/Hooks.tsx:1438` |
| `toggle_hook` | 447 | `components/Hooks.tsx:352` |
| `ultron_root_str` | 182 | `lib/paths.ts:19` |
| `uninstall_app` | 418 | `components/System.tsx:520` |
| `uninstall_plugin_cache` | 460 | `components/Settings/PluginsSection.tsx:240` |
| `update_agent_md` | 222 | `components/Agents.tsx:1218` |
| `update_button_prompt` | 521 | `lib/button-prompts.ts:96` |
| `update_hook` | 446 | `components/Hooks.tsx:1298` |
| `update_mcp` | 204 | `components/MCPs.tsx:1120` |
| `update_plan` | 439 | `components/Plans.tsx:731` |
| `update_project` | 252 | `components/Projects.tsx:329` |
| `update_skill_md` | 215 | `components/Skills.tsx:395` |
| `workday_record_kanban_event` | 377 | `components/projects/ProjectBoard.tsx:99` |

> Nota: `workday_record_kanban_event` es el **unico** comando `workday_*` con
> caller UI vivo (movimiento de tarjetas Kanban -> evento de jornada). El
> resto de `workday_*` esta en (D). Confirmado por la regla de USER.

---

## (B) BACKEND-ONLY-INTENCIONAL — registrado, sin caller UI, consumido fuera de la UI (72)

Comandos registrados que no tienen `invoke()` en el frontend pero **no son
basura**: los consume el setup interno de Rust, el dispatcher de palette/CLI,
hooks, el sidecar, o son superficie de orquestacion/auto-routing aun sin
cablear en UI. Mantener.

| Comando | Registro (lib.rs) | Consumidor / motivo |
|---------|-------------------|---------------------|
| `agents_pinned_load` | 227 | Pin de agentes (API back-end; UI de pin aun no cableada) |
| `agents_pinned_save` | 228 | idem |
| `ai_router_disabled_providers` | 553 | Routing key-aware; consumido por logica de router, no UI directa |
| `ai_router_get_zone` | 543 | Detalle de zona (back-end; UI usa list_zones) |
| `ai_router_route` | 549 | Decision de routing (orquestador / proxy), no UI |
| `ai_router_validate_keys` | 552 | Validacion de keys server-side |
| `appx_query` | 419 | Query AppX (helper de System; UI usa list_installed_apps) |
| `batches_enqueue_command` | 301 | Encolado de batch desde hooks/CLI |
| `build_fallback_context` | 530 | Codex fallback (back-end pipeline) |
| `build_fallback_prompt` | 531 | idem |
| `catalog_fetch_previews` | 474 | Preview de catalogo (lazy; UI usa read_curated_catalog) |
| `catalog_reindex` | 288 | AUTO-ROUTING #7 indexacion catalogo agentes/skills |
| `catalog_search` | 289 | AUTO-ROUTING #7 route semantico |
| `check_plugin_updates` | 461 | Update check unitario (UI usa plugin_check_updates_bulk) |
| `clear_project_at_slot` | 535 | Hotkeys por proyecto (config back-end) |
| `compute_cost` | 190 | Coste (helper; UI usa claude_usage / compute_activity_timeline) |
| `create_agent` | 221 | Creacion de agente (back-end; UI usa agent_create de library) |
| `create_skill` | 214 | idem skill |
| `delegate_task_to_agent` | 229 | Delegacion programatica (UI usa delegate_task_launch) |
| `delete_agent` | 223 | Borrado de agente (back-end; sin boton UI) |
| `delete_scheduled_task` | 414 | Tareas programadas (back-end / System avanzado) |
| `delete_skill` | 216 | Borrado de skill (back-end; sin boton UI) |
| `edit_scheduled_task` | 413 | Tareas programadas |
| `get_button_prompt` | 523 | Lookup individual (UI usa list_button_prompts) |
| `get_project_hotkeys` | 533 | Hotkeys por proyecto (registro en setup) |
| `is_developer_install` | 244 | Flag de entorno (consumido por logica de lifecycle) |
| `is_project_detached` | 305 | Estado de ventana detach |
| `kanban_migrate_existing` | 508 | Migracion idempotente (arranque/back-end) |
| `kanban_save` | 502 | Guardado directo (UI usa create/update/move) |
| `launch_codex_fallback` | 532 | Codex fallback launcher |
| `list_active_hooks` | 232 | Hooks activos (back-end / diagnostico) |
| `list_agent_workflows` | 231 | Workflows de agente (back-end) |
| `list_agents_legacy` | 219 | Compat legacy |
| `list_instruction_folders` | 186 | Carpetas de instrucciones (helper) |
| `list_logs` | 184 | Logs (helper; tail_log/CLI) |
| `list_scheduled_tasks` | 408 | Tareas programadas (System avanzado) |
| `migrate_dry_run` | 469 | Migracion dry-run (CLI / diagnostico) |
| `open_event_viewer` | 434 | Abrir Visor de eventos (helper de System) |
| `open_folder_in_vscode` | 191 | Helper VSCode (UI usa open_in_vscode) |
| `orchestrate_prompt` | 291 | ORQUESTADOR "Ultron" prompt->intent->workflow (superficie nueva) |
| `pause_global_hotkeys` | 527 | Pausa de hotkeys (control programatico) |
| `proxy_start` | 556 | Proxy free-tier (auto vida; UI usa proxy_set_enabled) |
| `proxy_stop` | 557 | idem (tambien on_window_event/RunEvent::Exit en lib.rs) |
| `pty_spawn` | 466 | Terminal embebido (spawn via portable-pty / sesion) |
| `qdrant_embed_query` | 262 | Embedding via sidecar (back-end recall) |
| `qdrant_status` | 261 | Estado Qdrant (back-end / diagnostico) |
| `read_agent_md` | 220 | Lectura MD agente (UI usa read_text_file/list_skill_files) |
| `read_curated_catalog` | 473 | Catalogo curado (back-end feed) |
| `read_skill_md` | 213 | Lectura MD skill |
| `reattach_project_window` | 304 | Reattach de ventana |
| `recall_last_session` | 352 | Recall per-project (UI usa el _global) |
| `reorder_launcher_items` | 257 | Reorden launcher (back-end / DnD futuro) |
| `resume_global_hotkeys` | 528 | Reanuda hotkeys |
| `rich_system_info` | 412 | Info de sistema enriquecida (helper) |
| `rules_read` | 235 | Lectura de regla (UI usa rules_list + rules_write) |
| `run_inline` | 344 | Ejecucion inline de sesion (CLI/tauri-events) |
| `run_scheduled_task` | 409 | Lanzar tarea programada |
| `sessions_auto_tag` | 349 | Auto-tag de sesiones (hook P1) |
| `sessions_bulk_auto_tag` | 350 | idem bulk |
| `sessions_tags_load` | 348 | Carga de tags de sesion |
| `set_in_app_shortcuts` | 537 | Guardado de atajos (UI lee con get_in_app_shortcuts) |
| `set_project_at_slot` | 534 | Hotkeys por proyecto |
| `system_info` | 410 | Info de sistema (helper; UI usa rich_system_info/list_installed_apps) |
| `tail_log` | 185 | Tail de log (helper/CLI) |
| `task_detail` | 411 | Detalle de tarea programada |
| `uninstall_bloatware_app` | 420 | Desinstalar bloatware (System avanzado) |
| `workflow_get_runs` | 564 | Historial de runs de workflow (KIRKARDO 23 P2; SQLite) |
| `workflow_get_state` | 566 | Estado de workflow |
| `workflow_load_user_defined` | 567 | Carga de workflows YAML user-defined |
| `workflow_record_run` | 562 | Registro de run (consumido por orquestador/runner) |
| `workflow_set_state` | 565 | Set estado de workflow |
| `workflow_update_run` | 563 | Update de run |

> **Aviso de riesgo**: parte de (B) es superficie "intencional" pero todavia
> **no observada** en runtime (auto-routing #7: `catalog_reindex` /
> `catalog_search`; orquestador: `orchestrate_prompt`; `workflow_*`). Si el
> rework decide no cablearlas, migran a (D). Hoy se conservan por ser API de
> features en curso, no features muertas.

---

## (C) CONSERVAR-FUTURA-UI — MEMORY KERNEL (18)

Decision explicita de USER: **conservar** estos comandos para la futura UI
de revision de memoria (Memory Inbox + Retrieval Inspector + governance de
items). Estan registrados, sin caller UI hoy, pero son la columna del kernel.

| Comando | Registro (lib.rs) | Rol en el kernel |
|---------|-------------------|------------------|
| `recall` | 268 | Recall hibrido unificado (Fase B) |
| `recall_inspect` | 269 | Retrieval Inspector (debug de scoring) |
| `memory_reindex` | 270 | Reindex denso |
| `memory_inbox_list` | 272 | Memory Inbox: listado de candidates |
| `memory_candidate_approve` | 273 | Inbox: aprobar candidate |
| `memory_candidate_reject` | 274 | Inbox: rechazar candidate |
| `memory_candidate_edit` | 275 | Inbox: editar candidate |
| `memory_item_edit` | 276 | Governance: editar item |
| `memory_item_relabel` | 277 | Governance: relabel |
| `memory_item_deprecate` | 278 | Governance: deprecar |
| `memory_item_quarantine` | 279 | Governance: quarantine |
| `memory_do_not_use` | 280 | Governance: marcar do-not-use |
| `memory_item_history` | 281 | Governance: historial de item |
| `memory_item_pin` | 282 | Governance: pin |
| `memory_item_unpin` | 283 | Governance: unpin |
| `memory_stats` | 284 | Stats del kernel (para card/panel) |
| `session_resume` | 286 | Session Resume (contexto acotado) |
| `memory_migrate` | 266 | ETL one-shot (Fase A3; conservar hasta cerrar migracion) |

> Estos 18 son el set "no podar" del kernel. Cuando se construya la UI de
> revision, pasaran a (A).

---

## (D) PODABLE — feature muerta, sin caller UI (66)

Sin `invoke()` en el frontend y **sin** rol de futuro segun la decision de
USER. Candidatos a poda (junto con `quota_get_status`/`QuotaDot`, ver
seccion de invokes rotos).

### D.1 Workdays (jornadas) — salvo `workday_record_kanban_event` (34)

`create_workday`, `start_workday`, `pause_workday`, `resume_workday`,
`complete_workday`, `archive_workday`, `list_workdays`, `get_workday_detail`,
`get_workday_metrics`, `list_templates`, `save_template`, `update_goal`,
`link_session`, `link_task`, `register_workday_autoupdate_task`,
`workday_list`, `workday_pending_link_record`, `workday_drain_pending_links`,
`workday_auto_link_session`, `workday_auto_start_for_project`,
`workday_auto_for_session`, `workday_append_context`, `workday_today_timeline`,
`workday_history`, `workday_active_today_for_project`, `workday_wipe_all`,
`workday_day_view`, `workday_goals_add`, `workday_goals_update`,
`workday_goals_delete`, `workday_goals_auto_fill`, `workday_ai_summary_generate`,
`workday_context_auto_append`, `workday_active_id_today` — toda la superficie
de jornadas de trabajo (v2.7/v2.8). **34 comandos** (ver tabla completa abajo).
`workday_record_kanban_event` queda fuera: es (A).

### D.2 Knowledge Graph local (kg_*) (7)

`kg_read_graph`, `kg_create_entities`, `kg_delete_entity`,
`kg_add_observations`, `kg_create_relations`, `kg_delete_relation`,
`kg_search_nodes` — editor de KG local (v2.6 fb-047). Sin caller UI.

### D.3 Decisions registry (decisions_*) (9)

`decisions_add`, `decisions_update`, `decisions_list`, `decisions_delete`,
`decisions_drain_pending`, `decisions_search`, `kanban_decisions_search`,
`decisions_reject_all_auto`, `decisions_purge_noise` — registro de decisiones
(KIRKARDO 24). Sin caller UI ("Decisions pocho").

### D.4 mem0 (salvo `status`) + Memory-tab legacy / ECC / graphify (16)

`mem0_search`, `mem0_add`, `mem0_delete`, `mem0_diagnostics`,
`mem0_test_connection`, `mem0_list_all` (mem0 fuera del SoT; `mem0_status`
sigue LIVE en Mem0Card),
`memory_status_mem0`, `memory_status_ecc`, `memory_status_graphify`,
`memory_status_files`, `memory_sync_mem0_manual`, `memory_graphify_index`,
`memory_tree_snapshot`, `memory_unified_search`, `ecc_memory_read`,
`bootstrap_ecc_memory` —
superficie del **Memory tab legacy** (incluido `memory_unified_search`, que en
`memory_graph.rs:201` aun lee `ultron_sessions` WRITE-DEAD). Verificado: el
unico componente con nombre "memory" es `MemoryStatusCard.tsx`, que solo invoca
`memory_health` (LIVE). Ningun caller para estos.

### Tabla completa (D) con registro lib.rs

| Comando | Registro (lib.rs) | Subgrupo |
|---------|-------------------|----------|
| `archive_workday` | 360 | D.1 workdays |
| `complete_workday` | 359 | D.1 workdays |
| `create_workday` | 355 | D.1 workdays |
| `get_workday_detail` | 362 | D.1 workdays |
| `get_workday_metrics` | 365 | D.1 workdays |
| `link_session` | 363 | D.1 workdays |
| `link_task` | 364 | D.1 workdays |
| `list_templates` | 366 | D.1 workdays |
| `list_workdays` | 361 | D.1 workdays |
| `pause_workday` | 357 | D.1 workdays |
| `register_workday_autoupdate_task` | 392 | D.1 workdays |
| `resume_workday` | 358 | D.1 workdays |
| `save_template` | 367 | D.1 workdays |
| `start_workday` | 356 | D.1 workdays |
| `update_goal` | 368 | D.1 workdays |
| `workday_active_id_today` | 391 | D.1 workdays |
| `workday_active_today_for_project` | 380 | D.1 workdays |
| `workday_ai_summary_generate` | 389 | D.1 workdays |
| `workday_append_context` | 376 | D.1 workdays |
| `workday_auto_for_session` | 375 | D.1 workdays |
| `workday_auto_link_session` | 372 | D.1 workdays |
| `workday_auto_start_for_project` | 374 | D.1 workdays |
| `workday_context_auto_append` | 390 | D.1 workdays |
| `workday_day_view` | 383 | D.1 workdays |
| `workday_drain_pending_links` | 371 | D.1 workdays |
| `workday_goals_add` | 385 | D.1 workdays |
| `workday_goals_auto_fill` | 388 | D.1 workdays |
| `workday_goals_delete` | 387 | D.1 workdays |
| `workday_goals_update` | 386 | D.1 workdays |
| `workday_history` | 379 | D.1 workdays |
| `workday_list` | 369 | D.1 workdays |
| `workday_pending_link_record` | 370 | D.1 workdays |
| `workday_today_timeline` | 378 | D.1 workdays |
| `workday_wipe_all` | 382 | D.1 workdays |
| `kg_read_graph` | 317 | D.2 kg |
| `kg_create_entities` | 318 | D.2 kg |
| `kg_delete_entity` | 319 | D.2 kg |
| `kg_add_observations` | 320 | D.2 kg |
| `kg_create_relations` | 321 | D.2 kg |
| `kg_delete_relation` | 322 | D.2 kg |
| `kg_search_nodes` | 323 | D.2 kg |
| `decisions_add` | 491 | D.3 decisions |
| `decisions_delete` | 494 | D.3 decisions |
| `decisions_drain_pending` | 495 | D.3 decisions |
| `decisions_list` | 493 | D.3 decisions |
| `decisions_purge_noise` | 499 | D.3 decisions |
| `decisions_reject_all_auto` | 498 | D.3 decisions |
| `decisions_search` | 496 | D.3 decisions |
| `decisions_update` | 492 | D.3 decisions |
| `kanban_decisions_search` | 497 | D.3 decisions |
| `mem0_add` | 327 | D.4 mem0 |
| `mem0_delete` | 328 | D.4 mem0 |
| `mem0_diagnostics` | 329 | D.4 mem0 |
| `mem0_list_all` | 331 | D.4 mem0 |
| `mem0_search` | 326 | D.4 mem0 |
| `mem0_test_connection` | 330 | D.4 mem0 |
| `bootstrap_ecc_memory` | 315 | D.4 memory-tab legacy |
| `ecc_memory_read` | 314 | D.4 memory-tab legacy |
| `memory_graphify_index` | 338 | D.4 memory-tab legacy |
| `memory_status_ecc` | 334 | D.4 memory-tab legacy |
| `memory_status_files` | 336 | D.4 memory-tab legacy |
| `memory_status_graphify` | 335 | D.4 memory-tab legacy |
| `memory_status_mem0` | 333 | D.4 memory-tab legacy |
| `memory_sync_mem0_manual` | 337 | D.4 memory-tab legacy |
| `memory_tree_snapshot` | 341 | D.4 memory-tab legacy |
| `memory_unified_search` | 340 | D.4 memory-tab legacy (lee ultron_sessions WRITE-DEAD) |

> **Nota D.1**: 33 `workday_*` + 6 helpers de jornada sin prefijo
> (`create/start/pause/resume/complete/archive_workday`,
> `list_workdays`, `get_workday_detail`, `get_workday_metrics`,
> `list_templates`, `save_template`, `update_goal`, `link_session`,
> `link_task`, `register_workday_autoupdate_task`). El total D.1 = 34 filas en
> la tabla. `workday_record_kanban_event` queda **fuera** de (D): es (A).

---

## Metodologia y verificacion

1. **Backend**: se parseo el unico bloque `tauri::generate_handler![...]`
   (`lib.rs:180-568`), tomando el ultimo segmento `::` de cada entrada y
   filtrando comentarios. -> **323 comandos unicos registrados.**
2. **Frontend**: se recogieron todos los `invoke("cmd"...)` /
   `invoke<T>("cmd"...)` (regex multilinea-aware) bajo `control-center/src/`.
   -> **233 call-sites, 169 nombres de comando unicos invocados.**
3. **Cruce**:
   - LIVE (A) = registrado AND invocado = **167**.
   - Roto = invocado AND NO registrado = **2 matches**, de los cuales **1 es
     call-site real** (`quota_get_status`) y **1 es comentario** (`recall_semantic`).
   - No invocado = registrado AND NOT invocado = **156**, repartidos en
     B (72) + C (18) + D (66).
4. **Casos multilinea cazados** (habrian sido falsos "no invocado"):
   `cleanup_old_batches`, `clear_all_batches` (BatchDropdown.tsx),
   `list_maintenance_commands` (App.tsx). Reclasificados a (A).
5. **Dispatcher dinamico**: `App.tsx:359` `invoke(cmd, args)` (runQuiet de la
   command palette) solo despacha comandos ya LIVE
   (`spawn_session`, `run_app_lifecycle`, `purge_legacy_autostart`,
   `scan_projects`, `close_control_center`). No rescata ningun comando de B/C/D.
6. **Cuadre final**: 167 + 72 + 18 + 66 = **323** = total registrado. OK.

### Acciones sugeridas (no ejecutadas aqui)

- **Poda inmediata segura**: `QuotaDot` + `useQuotaDot` + invoke
  `quota_get_status` + listeners `quota:*` en `Sidebar.tsx` (comando ya no
  existe; el `.catch` lo oculta).
- **Limpieza documental**: comentarios `recall_semantic` en `types.ts`.
- **Poda de features (D)**: workdays (salvo `record_kanban_event`), kg,
  decisions, mem0 (salvo `status`), Memory-tab legacy. Requiere quitar tanto
  los wrappers `#[tauri::command]` como las entradas del `generate_handler!`
  y los modulos asociados. **Fuera del alcance de este mapa** (este doc no
  edita codigo).
