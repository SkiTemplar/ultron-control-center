// Fachada de la API de la ventana «ULTRON Sessions». Dos adaptadores con la misma
// interfaz: el real (invoke/listen de Tauri) y el mock (demo y e2e), que se
// activa con `?mock=1` o cuando la página no corre dentro de Tauri.

import type {
  AgentNode,
  Ask,
  AskAnswer,
  BackgroundOutcome,
  CommandOutcome,



  Bitacora,
  HistoryPage,
  CommandDef,
  CreateSessionArgs,
  Effort,
  EngineId,
  EngineModel,
  EngineRunArgs,
  EngineSessionPast,
  EngineStatus,
  EngineTask,
  RelayState,
  ExportFormat,
  ExportResult,
  GitCommitInfo,
  GitRepoSnapshot,
  InterruptSendOutcome,
  KeyName,


  OpResult,
  PermissionMode,

  QueueItem,
  QueueItemInput,
  QueueItemPatch,
  RecoverAction,
  RecoverOptions,
  RecoverOutcome,
  SendMode,
  SendOutcome,
  SessionPrefs,

  PastSession,
  PlanUsage,
  PathStatus,
  SavedAttachment,
  SesionesEventName,
  SesionesEvents,
  ProjectRef,
  SessionId,
  SessionInfo,
  SessionSettings,
  UsoPace,
  EnginesPlanUsage,
  SocraticMode,
} from "./types";
import type { IncidentReport } from "./incidents";
import type { WorkflowRun } from "./workflows";
import type { RailReport } from "./rail-rects";

export type Unlisten = () => void;

export interface SesionesApi {
  readonly isMock: boolean;
  list(): Promise<SessionInfo[]>;
  past(projectId?: string, limit?: number): Promise<PastSession[]>;
  create(args: CreateSessionArgs): Promise<SessionInfo>;
  /** v3: `auto` encola si la sesión no está libre; `now` escribe en la cola nativa de la CLI. */
  send(args: { id: SessionId; text: string; attachments: string[]; clientId: string; mode: SendMode }): Promise<SendOutcome>;
  key(args: { id: SessionId; key: KeyName }): Promise<void>;
  kill(id: SessionId): Promise<void>;
  rename(args: { id: SessionId; title: string }): Promise<void>;
  /** Página del historial (§7): sin `beforeUuid`, la última; error `history_cursor_gone` si el cursor ya no existe. */
  history(args: { id: SessionId; agentId?: string; beforeUuid?: string; limit?: number }): Promise<HistoryPage>;
  agents(id: SessionId): Promise<AgentNode[]>;
  /** Runs de `Workflow` de la sesión, reconstruidos desde el disco si hace falta. */
  workflows(id: SessionId): Promise<WorkflowRun[]>;
  terminalAttach(id: SessionId): Promise<string>;
  terminalDetach(id: SessionId): Promise<void>;
  /** Redimensiona el PTY y su pantalla emulada (la TUI se repinta entera). */
  terminalResize(args: { id: SessionId; cols: number; rows: number }): Promise<void>;
  /** Devuelve el PTY a su tamaño de lanzamiento. */
  terminalRestoreSize(id: SessionId): Promise<void>;
  /** Error `ask_gone` si la pregunta ya no está pendiente. */
  answer(args: { askId: string; answer: AskAnswer }): Promise<void>;
  saveAttachment(args: { name: string; dataBase64: string; mediaType: string }): Promise<SavedAttachment>;
  readImage(path: string): Promise<string>;
  /** Abre una imagen con la app del sistema (solo imágenes). */
  openImage(path: string, cwd?: string): Promise<void>;
  revealPath(path: string, cwd?: string): Promise<void>;
  /** Abre un fichero con la app del sistema; rechaza ejecutables y scripts. */
  openFile(path: string, cwd?: string): Promise<void>;
  /** Estado en disco de rutas absolutas, en el mismo orden (máx. 500). */
  pathsStatus(paths: readonly string[]): Promise<PathStatus[]>;
  /** Ficheros que Claude editó desde `since` (ISO), leídos del transcript y de los subagentes (máx. 500). */
  turnEdits(id: SessionId, since: string): Promise<string[]>;
  /** Abre el fichero en VS Code (en `line` si se da); relativo a `cwd`. */
  openInEditor(path: string, line?: number, cwd?: string): Promise<void>;
  /** Pide destino y guarda; `null` si se cancela. */
  saveImage(dataUrl: string, name: string): Promise<string | null>;
  /** Exporta la conversación completa al destino que elige el usuario; `null` si cancela. */
  exportConversation(args: { id: SessionId; format: ExportFormat }): Promise<ExportResult | null>;
  /** Abre (o muestra en su carpeta, con `reveal`) un fichero exportado en esta ejecución. */
  openExport(path: string, reveal?: boolean): Promise<void>;
  gitSnapshot(cwd: string): Promise<GitRepoSnapshot>;
  gitDiffFile(cwd: string, file: string, staged: boolean): Promise<string>;
  gitCommit(cwd: string, message: string): Promise<string>;
  gitLog(cwd: string, limit: number): Promise<GitCommitInfo[]>;
  /** Ficheros del proyecto para el autocompletado `@` (`sesiones_files`). */
  listFiles(cwd: string): Promise<string[]>;
  /** `force` (botón Actualizar): salta la muestra local, la caché y la espera tras un fallo. */
  usage(req?: { force?: boolean }): Promise<PlanUsage>;
  usagePace(req?: { force?: boolean }): Promise<UsoPace>;
  /** Uso de Codex y agy (`sesiones_engines_usage`); `force` salta la caché de `agy /usage`. */
  enginesUsage(req?: { force?: boolean }): Promise<EnginesPlanUsage>;
  /** Ventana adicional de Sessions; devuelve su etiqueta. */
  newWindow(sessionId?: string): Promise<string>;
  /** Trae la ventana principal del Control Center (`sesiones_open_control_center`). */
  openControlCenter(): Promise<void>;
  /** Abre un enlace web (`http`, `https` o `mailto`) en el navegador del sistema. */
  openUrl(url: string): Promise<void>;
  /** Rectángulos de la columna de sesiones para la mascota (rail-rects.ts). */
  reportRail(report: RailReport): Promise<void>;
  /** `/mejorar`: reescribe el borrador por el AI Router (no lo envía). */
  mejorar(args: { id: SessionId; draft: string; lastError: string | null }): Promise<string>;
  // --- v0.2 ---
  launch(projectId: string): Promise<SessionInfo>;
  /** Proyectos registrados con ruta (para «+ Claude» sin sesión de referencia). */
  projects(): Promise<ProjectRef[]>;
  settings(id: SessionId): Promise<SessionSettings>;
  setEffort(args: { id: SessionId; effort: Effort }): Promise<OpResult>;
  setModel(args: { id: SessionId; model: string }): Promise<OpResult>;
  setSocratic(args: { projectId: string; mode: SocraticMode }): Promise<void>;
  promptHistory(args: { projectId?: string; cwd?: string; limit?: number }): Promise<string[]>;
  /** Con `id` y puente v2, la lista viva de la sesión. */
  commands(cwd: string, id?: SessionId): Promise<CommandDef[]>;
  bitacora(projectId: string): Promise<Bitacora>;
  engines(req?: { force?: boolean }): Promise<EngineStatus[]>;
  /** `attachments`: rutas de los adjuntos del composer (Codex local: imágenes con `--image`). */
  engineRun(args: EngineRunArgs & { attachments?: string[] }): Promise<EngineTask>;
  engineBring(args: { taskId: string; sessionId: SessionId }): Promise<void>;
  engineCancel(taskId: string): Promise<void>;
  engineList(): Promise<EngineTask[]>;
  relayList(): Promise<RelayState[]>;
  relaySwitchGemini(sessionId: SessionId): Promise<RelayState>;
  relayReturn(sessionId: SessionId): Promise<void>;
  /** Borra las tareas terminadas de la sesión; devuelve la lista que queda. */
  engineClear(sessionId: SessionId): Promise<EngineTask[]>;
  /** Tribunal: pega las respuestas del grupo en la sesión para contrastarlas. */
  engineContrast(args: { group: string; sessionId: SessionId }): Promise<void>;
  engineModels(engine: EngineId): Promise<EngineModel[]>;
  /** Sesión de motor (Codex o Gemini) sin Claude; con `resume`, reabre una cerrada con el mismo id. */
  engineSessionCreate(args: { engine: EngineId; projectId?: string; cwd?: string; model?: string; resume?: SessionId }): Promise<SessionInfo>;
  /** Lanza un turno `chat`; error si hay uno en curso o el texto está vacío. */
  engineSessionSend(args: { id: SessionId; text: string; attachments?: string[] }): Promise<EngineTask>;
  /** Interrumpe el turno en curso de la sesión de motor (`turn/interrupt` o `session/cancel`; sin proceso vivo, cancela el turno `exec`). */
  engineSessionInterrupt(id: SessionId): Promise<void>;
  /** Sesiones de motor cerradas, más recientes primero. */
  engineSessionPast(limit?: number): Promise<EngineSessionPast[]>;
  /** Dictado: trozo de audio en base64 a texto (Whisper de Groq). */
  transcribe(audioB64: string, mime: string): Promise<string>;
  // --- v3 (contrato de estabilidad, §7.1) ---
  runCommand(args: { id: SessionId; command: string; args: string; clientId: string }): Promise<CommandOutcome>;
  recover(args: { id: SessionId; action: RecoverAction; opts?: RecoverOptions }): Promise<RecoverOutcome>;
  /** §3.4: Ctrl+B sobre la herramienta en primer plano, verificado por su cierre. Error si no hay ninguna o no se mueve. */
  background(args: { id: SessionId }): Promise<BackgroundOutcome>;
  /** §3.4: encola el mensaje el primero, interrumpe el turno y lo envía por delante de lo devuelto a la cola. */
  interruptAndSend(args: { id: SessionId; text: string; attachments: string[]; clientId: string; delegate: boolean }): Promise<InterruptSendOutcome>;
  trustAnswer(args: { id: SessionId; accept: boolean }): Promise<void>;
  dialogAnswer(args: { id: SessionId; index: number }): Promise<void>;
  /** Solo con la terminal adjunta. */
  terminalInput(args: { id: SessionId; data: string }): Promise<void>;
  setPermissionMode(args: { id: SessionId; mode: PermissionMode }): Promise<OpResult>;
  logDir(): Promise<string>;
  /** Guarda un aviso en `sesiones-incidentes.jsonl` con la pantalla y el estado de la sesión. */
  reportIncident(report: IncidentReport): Promise<void>;
  pendingAsks(id?: SessionId): Promise<Ask[]>;
  queueList(id: SessionId): Promise<QueueItem[]>;
  queueEnqueue(args: { id: SessionId; item: QueueItemInput }): Promise<QueueItem[]>;
  queueUpdate(args: { id: SessionId; clientId: string; patch: QueueItemPatch }): Promise<QueueItem[]>;
  queueRemove(args: { id: SessionId; clientId: string }): Promise<QueueItem[]>;
  queueMove(args: { id: SessionId; clientId: string; toIndex: number }): Promise<QueueItem[]>;
  /** Sin `clientId`, todos los elementos en cola. */
  queueSendNow(args: { id: SessionId; clientId?: string }): Promise<QueueItem[]>;
  queueRetry(args: { id: SessionId; clientId: string }): Promise<QueueItem[]>;
  prefsGet(): Promise<SessionPrefs>;
  prefsSet(prefs: SessionPrefs): Promise<SessionPrefs>;
  // <WP-MOTORES>
  /** Devuelve la URL `http://preview.localhost/<uuid>` que sirve el HTML. */
  previewPut(html: string): Promise<string>;
  /** Effort guardado de Codex y niveles que admite `model` (solo `codex`). */
  engineEffortGet(args: { engine: EngineId; model?: string }): Promise<import("./types").EngineEffort>;
  /** Guarda el effort de Codex (`null` = el de su configuración); devuelve el guardado. */
  engineEffortSet(args: { engine: EngineId; effort: string | null }): Promise<string | null>;
  // </WP-MOTORES>
  on<K extends SesionesEventName>(event: K, cb: (payload: SesionesEvents[K]) => void): Promise<Unlisten>;
  onPty(id: SessionId, cb: (base64: string) => void): Promise<Unlisten>;
}

export function isInsideTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function wantsMock(): boolean {
  if (typeof window === "undefined") return true;
  const params = new URLSearchParams(window.location.search);
  return params.get("mock") === "1" || !isInsideTauri();
}

let instance: SesionesApi | null = null;
let loading: Promise<SesionesApi> | null = null;

async function create(): Promise<SesionesApi> {
  if (wantsMock()) {
    const { createMockApi } = await import("./mock/api-mock");
    return createMockApi();
  }
  const { createTauriApi } = await import("./api-tauri");
  return createTauriApi();
}

/** Carga perezosa y única del adaptador: el mock no entra en el chunk real si no se usa. */
export function loadApi(): Promise<SesionesApi> {
  loading ??= create().then((api) => {
    instance = api;
    return api;
  });
  return loading;
}

export function getApi(): SesionesApi {
  if (!instance) throw new Error("La API de ULTRON Sessions aún no está cargada");
  return instance;
}
