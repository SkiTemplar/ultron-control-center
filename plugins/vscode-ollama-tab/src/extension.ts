import * as vscode from "vscode";
import {
  buildGenerateRequest,
  buildWarmupRequest,
  fetchCompletion,
  firstLoadedModelName,
  formatEngineStatus,
  formatSuggestionLogLine,
  isModelLoaded,
  modelSizeMb,
  resolveEngine,
  sanitizeCompletion,
  vramWarning,
  type Engine,
  type EngineModels,
} from "./logic";

const CONFIG_SECTION = "ollamaTab";
const COMMAND_TOGGLE = "ollamaTab.toggle";
const COMMAND_SELECT_ENGINE = "ollamaTab.selectEngine";

/** Ajuste de Copilot que gobierna su ghost text. Se apaga al activar un motor
 *  local para que las dos extensiones no propongan a la vez. */
const COPILOT_SECTION = "github.copilot";
const COPILOT_INLINE_KEY = "editor.enableAutoCompletions";

/** Modelo por defecto si `ollamaTab.model` esta vacio Y `/api/ps` no
 * informa ningun modelo cargado (servidor parado, sin red, etc). Mismo
 * valor que `DEFAULT_MODEL` en `ollama_toggle.rs` del lado ULTRON. */
const DEFAULT_MODEL = "qwen2.5-coder:1.5b-base";

/** Cuanto se reutiliza el ultimo resultado de `/api/ps` antes de volver a
 * preguntar. Evita una peticion extra por cada pulsacion cuando
 * `ollamaTab.model` esta vacio. */
const PS_CACHE_TTL_MS = 4_000;

type ConnectionState = "idle" | "ok" | "error";

interface Settings {
  enabled: boolean;
  engine: Engine;
  modelLow: string;
  modelMid: string;
  modelHigh: string;
  endpoint: string;
  model: string;
  debounceMs: number;
  timeoutMs: number;
  maxPrefixChars: number;
  maxSuffixChars: number;
  logSuggestions: boolean;
  keepAlive: string;
  warmupTimeoutMs: number;
}

function readSettings(): Settings {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    enabled: cfg.get<boolean>("enabled", true),
    engine: cfg.get<Engine>("engine", "low"),
    modelLow: cfg.get<string>("modelLow", DEFAULT_MODEL),
    modelMid: cfg.get<string>("modelMid", "qwen2.5-coder:3b-base"),
    modelHigh: cfg.get<string>("modelHigh", "qwen2.5-coder:7b-base"),
    endpoint: cfg.get<string>("endpoint", "http://127.0.0.1:11434"),
    model: cfg.get<string>("model", ""),
    debounceMs: cfg.get<number>("debounceMs", 75),
    timeoutMs: cfg.get<number>("timeoutMs", 2500),
    maxPrefixChars: cfg.get<number>("maxPrefixChars", 3000),
    maxSuffixChars: cfg.get<number>("maxSuffixChars", 1000),
    logSuggestions: cfg.get<boolean>("logSuggestions", true),
    keepAlive: cfg.get<string>("keepAlive", "30m"),
    warmupTimeoutMs: cfg.get<number>("warmupTimeoutMs", 120_000),
  };
}

/** Los tres modelos locales, en el orden low < mid < high. */
function engineModels(settings: Settings): EngineModels {
  return { low: settings.modelLow, mid: settings.modelMid, high: settings.modelHigh };
}

function sleep(ms: number, token: vscode.CancellationToken): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    token.onCancellationRequested(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Resolucion del modelo activo cuando `ollamaTab.model` esta vacio: se
// pregunta a `/api/ps` cual esta cargado ahora mismo y se cachea unos
// segundos (`PS_CACHE_TTL_MS`) para no anadir una peticion extra por cada
// sugerencia. Un valor explicito en el ajuste SIEMPRE se respeta y no
// consulta `/api/ps`.
// ---------------------------------------------------------------------------

let psCache: { model: string | null; expiresAt: number } | null = null;

async function resolveModel(settings: Settings, fetchImpl: typeof fetch): Promise<string> {
  const explicit = settings.model.trim();
  if (explicit) return explicit;

  // El motor manda sobre `/api/ps`: con dos modelos instalados, preguntar cual
  // esta cargado devolveria el del motor anterior mientras se suelta.
  const fromEngine = resolveEngine(settings.engine, engineModels(settings)).model;
  if (fromEngine) return fromEngine;

  const now = Date.now();
  if (psCache && now < psCache.expiresAt) {
    return psCache.model ?? DEFAULT_MODEL;
  }

  let resolved: string | null = null;
  try {
    const res = await fetchImpl(`${settings.endpoint.replace(/\/$/, "")}/api/ps`, { method: "GET" });
    if (res.ok) {
      resolved = firstLoadedModelName(await res.text());
    }
  } catch {
    resolved = null;
  }
  psCache = { model: resolved, expiresAt: now + PS_CACHE_TTL_MS };
  return resolved ?? DEFAULT_MODEL;
}

// ---------------------------------------------------------------------------
// Calentamiento del modelo.
//
// Medido en este equipo con `qwen2.5-coder:1.5b-base`: primera peticion (modelo
// fuera de RAM) 10,7 s; con el modelo residente, 50 ms. Como el timeout de una
// sugerencia son un par de segundos, pedir en frio aborta SIEMPRE la peticion, y al
// abortarla Ollama cancela tambien la carga: el modelo nunca llega a quedarse
// residente y la extension se queda en un bucle de peticiones canceladas (499)
// sin servir una sola sugerencia.
//
// Por eso, antes de pedir nada se comprueba en `/api/ps` si el modelo esta
// cargado. Si no lo esta, se lanza UNA peticion de calentamiento en segundo
// plano (timeout largo, `num_predict: 0`) y el turno actual no sugiere nada.
// Las pulsaciones siguientes encuentran el modelo caliente.
// ---------------------------------------------------------------------------

let warmupInFlight: Promise<void> | null = null;
let warmCache: { model: string; expiresAt: number } | null = null;

async function isWarm(settings: Settings, model: string, fetchImpl: typeof fetch): Promise<boolean> {
  const now = Date.now();
  if (warmCache && warmCache.model === model && now < warmCache.expiresAt) return true;

  try {
    const res = await fetchImpl(`${settings.endpoint.replace(/\/$/, "")}/api/ps`, { method: "GET" });
    if (!res.ok) return false;
    const loaded = isModelLoaded(await res.text(), model);
    warmCache = loaded ? { model, expiresAt: now + PS_CACHE_TTL_MS } : null;
    return loaded;
  } catch {
    return false;
  }
}

/** Lanza el calentamiento si no hay otro en curso. No lanza errores: un fallo
 *  deja la extension como estaba (sin sugerir) en vez de romper el editor. */
function startWarmup(
  settings: Settings,
  model: string,
  output: vscode.OutputChannel,
  fetchImpl: typeof fetch,
): Promise<void> {
  if (warmupInFlight) return warmupInFlight;

  output.appendLine(`[ollama-tab] calentando ${model}…`);
  const startedAt = Date.now();
  warmupInFlight = fetchCompletion({
    endpoint: settings.endpoint,
    request: buildWarmupRequest(model, settings.keepAlive),
    timeoutMs: settings.warmupTimeoutMs,
    fetchImpl,
  })
    .then(() => {
      warmCache = { model, expiresAt: Date.now() + PS_CACHE_TTL_MS };
      output.appendLine(`[ollama-tab] ${model} cargado en ${Date.now() - startedAt} ms`);
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      output.appendLine(`[ollama-tab] calentamiento fallido: ${message}`);
    })
    .finally(() => {
      warmupInFlight = null;
    });

  return warmupInFlight;
}

// ---------------------------------------------------------------------------
// Cambio de motor: apaga lo que no se usa.
// ---------------------------------------------------------------------------

/** Suelta un modelo de la VRAM (`keep_alive: 0`). Best-effort: si el servidor
 *  no responde, el modelo caducara solo por inactividad. */
async function unloadModel(
  settings: Settings,
  model: string,
  output: vscode.OutputChannel,
  fetchImpl: typeof fetch,
): Promise<void> {
  try {
    await fetchImpl(`${settings.endpoint.replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: "", stream: false, keep_alive: 0 }),
    });
    output.appendLine(`[ollama-tab] ${model} descargado de VRAM`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.appendLine(`[ollama-tab] no se pudo descargar ${model}: ${message}`);
  }
}

/**
 * VRAM libre segun `nvidia-smi`, o null si no se puede saber (sin GPU NVIDIA,
 * binario ausente, driver que no responde). Null significa "no juzgar", no
 * "no hay sitio".
 */
async function freeVramMb(): Promise<number | null> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const { stdout } = await run(
      "nvidia-smi",
      ["--query-gpu=memory.free", "--format=csv,noheader,nounits"],
      { timeout: 4000, windowsHide: true },
    );
    const value = Number.parseInt(stdout.trim().split(/\r?\n/)[0] ?? "", 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Avisa si el modelo del motor elegido no cabe en la VRAM libre y deja decidir.
 * Devuelve false solo si el usuario cancela. Con Unreal, un juego o cualquier
 * otra cosa comiendo la GPU, esto es lo que separa "va lento sin saber por que"
 * de una eleccion informada.
 */
async function confirmVram(
  settings: Settings,
  model: string,
  output: vscode.OutputChannel,
): Promise<boolean> {
  const [freeMb, tags] = await Promise.all([
    freeVramMb(),
    fetch(`${settings.endpoint.replace(/\/$/, "")}/api/tags`)
      .then((res) => (res.ok ? res.text() : ""))
      .catch(() => ""),
  ]);
  if (freeMb === null || !tags) return true;

  const neededMb = modelSizeMb(tags, model);
  if (neededMb === null) return true;

  const warning = vramWarning({ freeMb, neededMb });
  if (!warning) return true;

  output.appendLine(`[ollama-tab] VRAM justa para ${model}: ${warning}`);
  const choice = await vscode.window.showWarningMessage(
    `${model}: ${warning}`,
    { modal: false },
    "Activar igualmente",
    "Cancelar",
  );
  return choice === "Activar igualmente";
}

/**
 * Aplica un motor: persiste la eleccion, deja Copilot en el estado contrario,
 * suelta de VRAM el modelo que ya no toca y calienta el nuevo.
 */
async function applyEngine(engine: Engine, output: vscode.OutputChannel): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const current = readSettings();
  const wanted = resolveEngine(engine, engineModels(current));

  // El aviso va ANTES de persistir: cancelar deja el motor anterior intacto.
  if (wanted.model && !(await confirmVram(current, wanted.model, output))) {
    output.appendLine(`[ollama-tab] motor ${engine} cancelado por falta de VRAM`);
    return;
  }

  await cfg.update("engine", engine, vscode.ConfigurationTarget.Global);
  await cfg.update("enabled", true, vscode.ConfigurationTarget.Global);

  const settings = readSettings();
  const plan = resolveEngine(engine, engineModels(settings));

  // Copilot puede no estar instalado: su ajuste no existiria y `update` falla.
  // Eso no debe impedir el cambio de motor.
  try {
    await vscode.workspace
      .getConfiguration(COPILOT_SECTION)
      .update(COPILOT_INLINE_KEY, plan.copilotEnabled, vscode.ConfigurationTarget.Global);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.appendLine(`[ollama-tab] Copilot no configurable (${message})`);
  }

  warmCache = null;
  for (const model of plan.unload) {
    await unloadModel(settings, model, output, fetch);
  }

  output.appendLine(`[ollama-tab] motor -> ${engine}${plan.model ? ` (${plan.model})` : ""}`);
  if (plan.model) void startWarmup(settings, plan.model, output, fetch);
}

// ---------------------------------------------------------------------------
// Barra de estado — modelo activo + contador de sugerencias servidas en
// la sesion. Distingue a simple vista una sugerencia de esta extension de
// una de GitHub Copilot (ambas se ven como "ghost text" gris).
// ---------------------------------------------------------------------------

class OllamaTabStatus {
  private readonly item: vscode.StatusBarItem;
  private state: ConnectionState = "idle";
  private inFlight = false;
  private lastModel: string | null = null;
  private suggestionCount = 0;

  constructor(private readonly output: vscode.OutputChannel) {
    // A la izquierda y con prioridad alta: el motor activo se lee de un
    // vistazo, sin buscarlo entre los indicadores de la derecha.
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = COMMAND_SELECT_ENGINE;
    this.render();
    this.item.show();
  }

  private render(): void {
    const settings = readSettings();
    const engine: Engine = settings.enabled ? settings.engine : "off";
    const label = formatEngineStatus({
      engine,
      model: this.lastModel,
      suggestionCount: this.suggestionCount,
    });
    const pick = " (clic para cambiar de motor)";

    if (engine === "off") {
      this.item.text = `$(circle-slash) ${label}`;
      this.item.tooltip = `Sin ghost text${pick}`;
      return;
    }
    if (engine === "copilot") {
      this.item.text = `$(github) ${label}`;
      this.item.tooltip = `Sugiere GitHub Copilot${pick}`;
      return;
    }
    if (this.state === "error") {
      this.item.text = `$(warning) ${label}`;
      this.item.tooltip = `Ollama sin conexion${pick}`;
      return;
    }
    if (this.inFlight) {
      this.item.text = `$(sync~spin) ${label}`;
      this.item.tooltip = "Ollama Tab: pidiendo sugerencia…";
      return;
    }
    this.item.text = `$(zap) ${label}`;
    this.item.tooltip = `Sugiere Ollama en local${pick}`;
  }

  setInFlight(value: boolean): void {
    this.inFlight = value;
    this.render();
  }

  /** Registra una sugerencia MOSTRADA (no una peticion — las descartadas
   * por `sanitizeCompletion` no cuentan) y actualiza el modelo mostrado. */
  recordSuggestion(model: string): void {
    this.suggestionCount += 1;
    this.lastModel = model;
    this.render();
  }

  markOk(): void {
    if (this.state !== "ok") this.output.appendLine("[ollama-tab] conexion OK");
    this.state = "ok";
    this.render();
  }

  markError(reason: string): void {
    if (this.state !== "error") this.output.appendLine(`[ollama-tab] sin conexion: ${reason}`);
    this.state = "error";
    this.render();
  }

  refresh(): void {
    this.render();
  }

  dispose(): void {
    this.item.dispose();
  }
}

class OllamaInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private generation = 0;

  constructor(
    private readonly status: OllamaTabStatus,
    private readonly output: vscode.OutputChannel,
  ) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const settings = readSettings();
    if (!settings.enabled) return undefined;
    // Motor no local (Copilot u off): esta extension calla, para que no haya
    // dos proveedores proponiendo ghost text sobre el mismo cursor.
    if (!resolveEngine(settings.engine, engineModels(settings)).ollamaEnabled) {
      return undefined;
    }

    const myGeneration = ++this.generation;
    await sleep(settings.debounceMs, token);
    if (token.isCancellationRequested || myGeneration !== this.generation) return undefined;

    const fullPrefix = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
    const lastLine = document.lineAt(document.lineCount - 1);
    const fullSuffix = document.getText(new vscode.Range(position, lastLine.range.end));

    const model = await resolveModel(settings, fetch);
    if (token.isCancellationRequested) return undefined;

    // Gate de calentamiento: en frio, pedir con el timeout de sugerencia solo
    // produce peticiones canceladas. Se calienta en segundo plano y este turno
    // no sugiere.
    if (!(await isWarm(settings, model, fetch))) {
      void startWarmup(settings, model, this.output, fetch);
      return undefined;
    }
    if (token.isCancellationRequested) return undefined;

    const request = buildGenerateRequest({
      model,
      prefix: fullPrefix,
      suffix: fullSuffix,
      maxPrefixChars: settings.maxPrefixChars,
      maxSuffixChars: settings.maxSuffixChars,
      keepAlive: settings.keepAlive,
    });

    const controller = new AbortController();
    token.onCancellationRequested(() => controller.abort());

    const requestStart = Date.now();
    let raw: string | null;
    this.status.setInFlight(true);
    try {
      raw = await fetchCompletion({
        endpoint: settings.endpoint,
        request,
        timeoutMs: settings.timeoutMs,
        signal: controller.signal,
        fetchImpl: fetch,
      });
      this.status.markOk();
    } catch (err) {
      if (token.isCancellationRequested) return undefined;
      const message = err instanceof Error ? err.message : String(err);
      this.status.markError(message);
      return undefined;
    } finally {
      this.status.setInFlight(false);
    }

    if (token.isCancellationRequested || myGeneration !== this.generation) return undefined;

    const suggestion = sanitizeCompletion(raw, fullSuffix);
    if (!suggestion) return undefined;

    const elapsedMs = Date.now() - requestStart;
    this.status.recordSuggestion(model);
    if (settings.logSuggestions) {
      this.output.appendLine(
        formatSuggestionLogLine({
          date: new Date(),
          languageId: document.languageId,
          elapsedMs,
          suggestion,
        }),
      );
    }

    const item = new vscode.InlineCompletionItem(suggestion, new vscode.Range(position, position));
    return [item];
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Ollama Tab");
  const status = new OllamaTabStatus(output);
  const provider = new OllamaInlineCompletionProvider(status, output);

  context.subscriptions.push(
    output,
    status,
    vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, provider),
    vscode.commands.registerCommand(COMMAND_TOGGLE, async () => {
      const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
      const current = cfg.get<boolean>("enabled", true);
      await cfg.update("enabled", !current, vscode.ConfigurationTarget.Global);
      status.refresh();
    }),
    vscode.commands.registerCommand(COMMAND_SELECT_ENGINE, async () => {
      const settings = readSettings();
      const items: (vscode.QuickPickItem & { engine: Engine })[] = [
        {
          engine: "low",
          label: "$(zap) Ollama low",
          description: settings.modelLow,
          detail: "Local y rapido. Poca VRAM.",
        },
        {
          engine: "mid",
          label: "$(dashboard) Ollama mid",
          description: settings.modelMid,
          detail: "Local, equilibrio entre calidad y VRAM.",
        },
        {
          engine: "high",
          label: "$(rocket) Ollama high",
          description: settings.modelHigh,
          detail: "Local y mas capaz. Ocupa bastante mas VRAM.",
        },
        {
          engine: "copilot",
          label: "$(github) GitHub Copilot",
          detail: "En la nube. Libera la VRAM por completo.",
        },
        {
          engine: "off",
          label: "$(circle-slash) Sin autocompletado",
          detail: "Ni Copilot ni Ollama proponen nada.",
        },
      ];
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: `Motor de autocompletado (ahora: ${settings.engine})`,
      });
      if (!picked) return;
      await applyEngine(picked.engine, output);
      status.refresh();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(CONFIG_SECTION)) status.refresh();
    }),
  );

  output.appendLine("[ollama-tab] activado");

  // Calentar al arrancar: la primera pulsacion del dia encuentra el modelo ya
  // residente en vez de gastar el turno en cargarlo.
  void (async () => {
    const settings = readSettings();
    if (!settings.enabled) return;
    const plan = resolveEngine(settings.engine, engineModels(settings));
    if (!plan.ollamaEnabled) return;
    const model = await resolveModel(settings, fetch);
    if (await isWarm(settings, model, fetch)) return;
    await startWarmup(settings, model, output, fetch);
  })();
}

export function deactivate(): void {
  // No hay estado global que limpiar: los disposables de activate() lo cubren.
}
