// Adaptador real: comandos y eventos de Tauri según los contratos v0.1 y v0.2.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { SesionesApi } from "./api";
import { NETWORK_PATH_BLOCKED, isNetworkPath } from "./components/inspector/rutas-sesion";
import { normalizeEngines } from "./components/inspector/uso-motores";
import type { ChatMessage, GitRepoSnapshot, HistoryPage, PlanUsage, PlanWindowUsage } from "./types";

type RawWindow = { utilization?: number; percent?: number; resets_at?: string | null; resetsAt?: string | null };
type RawUsage = Record<string, unknown>;

function normWindow(raw: unknown): PlanWindowUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as RawWindow;
  const percent = typeof w.percent === "number" ? w.percent : typeof w.utilization === "number" ? w.utilization : null;
  if (percent === null) return null;
  return { percent, resetsAt: w.resetsAt ?? w.resets_at ?? null };
}

/** Acepta tanto la forma camelCase del contrato como la de plan_limits.rs. */
export function normalizeUsage(raw: unknown): PlanUsage {
  const u = (raw ?? {}) as RawUsage;
  return {
    fiveHour: normWindow(u.fiveHour ?? u.five_hour),
    weekly: normWindow(u.weekly ?? u.sevenDay ?? u.seven_day),
    stale: Boolean(u.stale),
  };
}

/** `HistoryPage` del contrato §7; un backend anterior devolvía la lista entera. */
export function normalizePage(raw: unknown): HistoryPage {
  if (Array.isArray(raw)) return { messages: raw as ChatMessage[], hasMore: false };
  const page = (raw ?? {}) as Partial<HistoryPage>;
  return { messages: Array.isArray(page.messages) ? page.messages : [], hasMore: Boolean(page.hasMore) };
}

export function createTauriApi(): SesionesApi {
  return {
    isMock: false,
    list: () => invoke("sesiones_list"),
    past: (projectId, limit) => invoke("sesiones_past", { projectId, limit }),
    create: (args) => invoke("sesiones_create", { ...args }),
    send: (args) => invoke("sesiones_send", { ...args }),
    key: (args) => invoke("sesiones_key", { ...args }),
    kill: (id) => invoke("sesiones_kill", { id }),
    rename: (args) => invoke("sesiones_rename", { ...args }),
    history: async (args) => normalizePage(await invoke("sesiones_history", { ...args })),
    agents: (id) => invoke("sesiones_agents", { id }),
    workflows: (id) => invoke("sesiones_workflows", { id }),
    terminalAttach: (id) => invoke("sesiones_terminal_attach", { id }),
    terminalDetach: (id) => invoke("sesiones_terminal_detach", { id }),
    terminalResize: (args) => invoke("sesiones_terminal_resize", { ...args }),
    terminalRestoreSize: (id) => invoke("sesiones_terminal_restore_size", { id }),
    answer: (args) => invoke("sesiones_answer", { ...args }),
    saveAttachment: (args) => invoke("sesiones_save_attachment", { ...args }),
    // Última barrera del front para todos los llamantes: el chat, Adjuntos y los bloques de imagen.
    readImage: (path) => (isNetworkPath(path) ? Promise.reject(new Error(NETWORK_PATH_BLOCKED)) : invoke("sesiones_read_image", { path })),
    openImage: (path, cwd) => invoke("sesiones_open_image", { path, cwd }),
    revealPath: (path, cwd) => invoke("sesiones_reveal_path", { path, cwd }),
    openFile: (path, cwd) => invoke("sesiones_open_file", { path, cwd }),
    pathsStatus: (paths) => invoke("sesiones_paths_status", { paths }),
    turnEdits: (id, since) => invoke("sesiones_turn_edits", { id, since }),
    openInEditor: (path, line, cwd) => invoke("sesiones_open_in_editor", { path, line, cwd }),
    saveImage: (dataUrl, name) => invoke("sesiones_save_image", { dataUrl, name }),
    exportConversation: (args) => invoke("sesiones_export", { ...args }),
    openExport: (path, reveal) => invoke("sesiones_export_open", { path, reveal: reveal ?? false }),
    gitSnapshot: (cwd) => invoke<GitRepoSnapshot>("git_repo_snapshot", { path: cwd }),
    gitDiffFile: (cwd, file, staged) => invoke("git_diff_file", { path: cwd, file, staged }),
    gitCommit: (cwd, message) => invoke("git_commit", { path: cwd, message }),
    gitLog: (cwd, limit) => invoke("git_log_full", { path: cwd, limit }),
    listFiles: (cwd) => invoke<string[]>("sesiones_files", { cwd }),
    usage: async (req) => normalizeUsage(await invoke("sesiones_usage", { force: req?.force ?? false })),
    usagePace: (req) => invoke("sesiones_usage_pace", { force: req?.force ?? false }),
    enginesUsage: async (req) => normalizeEngines(await invoke("sesiones_engines_usage", { force: req?.force ?? false })),
    newWindow: (sessionId) => invoke("sesiones_new_window", { sessionId }),
    openControlCenter: () => invoke("sesiones_open_control_center"),
    openUrl: (url) => openUrl(url),
    reportRail: (report) => invoke("sesiones_rail_report", { report }),
    mejorar: ({ id, draft, lastError }) => invoke("sesiones_mejorar", { id, draft, lastError }),
    launch: (projectId) => invoke("sesiones_launch", { projectId }),
    projects: async () => {
      const raw = await invoke<{ id: string; name: string | null; path: string | null; last_active?: string | null }[]>("list_projects");
      return raw
        .filter((p) => p.path)
        .map((p) => ({ id: p.id, name: p.name ?? p.id, path: p.path ?? "", lastActive: p.last_active ?? undefined }))
        .sort((a, b) => a.name.localeCompare(b.name, "es"));
    },
    settings: (id) => invoke("sesiones_settings", { id }),
    setEffort: (args) => invoke("sesiones_set_effort", { ...args }),
    setModel: (args) => invoke("sesiones_set_model", { ...args }),
    setSocratic: (args) => invoke("sesiones_set_socratic", { ...args }),
    promptHistory: (args) => invoke("sesiones_prompt_history", { ...args }),
    commands: (cwd, id) => invoke("sesiones_commands", { cwd, id }),
    bitacora: (projectId) => invoke("sesiones_bitacora", { projectId }),
    engines: (req) => invoke("sesiones_engines", { force: req?.force ?? false }),
    engineRun: (args) => invoke("sesiones_engine_run", { ...args }),
    engineBring: (args) => invoke("sesiones_engine_bring", { ...args }),
    engineCancel: (taskId) => invoke("sesiones_engine_cancel", { taskId }),
    engineList: () => invoke("sesiones_engine_list"),
    relayList: () => invoke("sesiones_relay_list"),
    relaySwitchGemini: (sessionId) => invoke("sesiones_relay_switch_gemini", { sessionId }),
    relayReturn: (sessionId) => invoke("sesiones_relay_return", { sessionId }),
    engineClear: (sessionId) => invoke("sesiones_engine_clear", { sessionId }),
    engineContrast: (args) => invoke("sesiones_engine_contrast", { ...args }),
    engineModels: (engine) => invoke("sesiones_engine_models", { engine }),
    engineSessionCreate: (args) => invoke("sesiones_engine_session_create", { ...args }),
    engineSessionSend: (args) => invoke("sesiones_engine_session_send", { ...args }),
    engineSessionInterrupt: (id) => invoke("sesiones_engine_session_interrupt", { id }),
    engineSessionPast: (limit) => invoke("sesiones_engine_session_past", { limit }),
    transcribe: (audioB64, mime) => invoke("sesiones_transcribe", { audioB64, mime }),
    // --- v3 (contrato de estabilidad, §7.1) ---
    runCommand: (args) => invoke("sesiones_run_command", { ...args }),
    recover: (args) => invoke("sesiones_recover", { ...args }),
    background: (args) => invoke("sesiones_background", { ...args }),
    interruptAndSend: (args) => invoke("sesiones_interrupt_send", { ...args }),
    trustAnswer: (args) => invoke("sesiones_trust_answer", { ...args }),
    dialogAnswer: (args) => invoke("sesiones_dialog_answer", { ...args }),
    terminalInput: (args) => invoke("sesiones_terminal_input", { ...args }),
    setPermissionMode: (args) => invoke("sesiones_set_permission_mode", { ...args }),
    logDir: () => invoke("sesiones_log_dir"),
    reportIncident: (report) => invoke("sesiones_incident", { report }),
    pendingAsks: (id) => invoke("sesiones_pending_asks", { id }),
    queueList: (id) => invoke("sesiones_queue_list", { id }),
    queueEnqueue: (args) => invoke("sesiones_queue_enqueue", { ...args }),
    queueUpdate: (args) => invoke("sesiones_queue_update", { ...args }),
    queueRemove: (args) => invoke("sesiones_queue_remove", { ...args }),
    queueMove: (args) => invoke("sesiones_queue_move", { ...args }),
    queueSendNow: (args) => invoke("sesiones_queue_send_now", { ...args }),
    queueRetry: (args) => invoke("sesiones_queue_retry", { ...args }),
    prefsGet: () => invoke("sesiones_prefs_get"),
    prefsSet: (prefs) => invoke("sesiones_prefs_set", { prefs }),
    // <WP-MOTORES>
    previewPut: (html) => invoke("sesiones_preview_put", { html }),
    engineEffortGet: (args) => invoke("sesiones_engine_effort_get", { engine: args.engine, model: args.model ?? null }),
    engineEffortSet: (args) => invoke("sesiones_engine_effort_set", { ...args }),
    // </WP-MOTORES>
    on: (event, cb) => listen(event, (e) => cb(e.payload as never)),
    onPty: (id, cb) => listen<string>(`sesiones://pty/${id}`, (e) => cb(e.payload)),
  };
}
