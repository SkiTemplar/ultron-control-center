import * as vscode from "vscode";
import {
  buildGenerateRequest,
  fetchCompletion,
  firstLoadedModelName,
  formatStatusBarLabel,
  formatSuggestionLogLine,
  sanitizeCompletion,
} from "./logic";

const CONFIG_SECTION = "ollamaTab";
const COMMAND_TOGGLE = "ollamaTab.toggle";

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
  endpoint: string;
  model: string;
  debounceMs: number;
  timeoutMs: number;
  maxPrefixChars: number;
  maxSuffixChars: number;
  logSuggestions: boolean;
}

function readSettings(): Settings {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    enabled: cfg.get<boolean>("enabled", true),
    endpoint: cfg.get<string>("endpoint", "http://127.0.0.1:11434"),
    model: cfg.get<string>("model", ""),
    debounceMs: cfg.get<number>("debounceMs", 75),
    timeoutMs: cfg.get<number>("timeoutMs", 1500),
    maxPrefixChars: cfg.get<number>("maxPrefixChars", 3000),
    maxSuffixChars: cfg.get<number>("maxSuffixChars", 1000),
    logSuggestions: cfg.get<boolean>("logSuggestions", true),
  };
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
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);
    this.item.command = COMMAND_TOGGLE;
    this.render();
    this.item.show();
  }

  private render(): void {
    const enabled = readSettings().enabled;
    const label = formatStatusBarLabel({ model: this.lastModel, suggestionCount: this.suggestionCount });

    if (!enabled) {
      this.item.text = `$(circle-slash) ${label}`;
      this.item.tooltip = "Ollama Tab: desactivado (clic para activar)";
      return;
    }
    if (this.state === "error") {
      this.item.text = `$(warning) ${label}`;
      this.item.tooltip = "Ollama Tab: sin conexion (clic para desactivar)";
      return;
    }
    if (this.inFlight) {
      this.item.text = `$(sync~spin) ${label}`;
      this.item.tooltip = "Ollama Tab: pidiendo sugerencia…";
      return;
    }
    this.item.text = `$(zap) ${label}`;
    this.item.tooltip = "Ollama Tab: listo (clic para desactivar)";
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

    const myGeneration = ++this.generation;
    await sleep(settings.debounceMs, token);
    if (token.isCancellationRequested || myGeneration !== this.generation) return undefined;

    const fullPrefix = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
    const lastLine = document.lineAt(document.lineCount - 1);
    const fullSuffix = document.getText(new vscode.Range(position, lastLine.range.end));

    const model = await resolveModel(settings, fetch);
    const request = buildGenerateRequest({
      model,
      prefix: fullPrefix,
      suffix: fullSuffix,
      maxPrefixChars: settings.maxPrefixChars,
      maxSuffixChars: settings.maxSuffixChars,
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
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(CONFIG_SECTION)) status.refresh();
    }),
  );

  output.appendLine("[ollama-tab] activado");
}

export function deactivate(): void {
  // No hay estado global que limpiar: los disposables de activate() lo cubren.
}
