/**
 * Logica pura de Ollama Tab: construccion del prompt FIM, recorte de la
 * ventana de contexto y saneado de la respuesta. Sin dependencia de `vscode`
 * para poder testearla con Node/Vitest directamente.
 */

const FIM_PREFIX = "<|fim_prefix|>";
const FIM_SUFFIX = "<|fim_suffix|>";
const FIM_MIDDLE = "<|fim_middle|>";

export interface OllamaGenerateOptions {
  num_predict: number;
  temperature: number;
  stop: string[];
}

export interface OllamaGenerateRequest {
  model: string;
  prompt: string;
  raw: true;
  stream: false;
  /** Cuanto mantiene Ollama el modelo residente tras responder. Sin este
   *  campo rige el default del servidor (5 min) y el modelo se descarga entre
   *  rafagas de escritura: cada sugerencia vuelve al camino frio, que el
   *  timeout de completado nunca llega a esperar. */
  keep_alive: string;
  options: OllamaGenerateOptions;
}

export interface OllamaGenerateResponse {
  response?: string;
}

/**
 * Recorta el prefijo (texto antes del cursor) a `maxChars`, cortando en un
 * limite de linea para no partir una linea por la mitad. Conserva el final
 * del texto (lo mas cercano al cursor).
 */
export function trimPrefixContext(prefix: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (prefix.length <= maxChars) return prefix;

  const truncated = prefix.slice(prefix.length - maxChars);
  const newlineIdx = truncated.indexOf("\n");
  if (newlineIdx === -1) {
    // Ni siquiera cabe una linea completa: devolver el recorte tal cual.
    return truncated;
  }
  return truncated.slice(newlineIdx + 1);
}

/**
 * Recorta el sufijo (texto despues del cursor) a `maxChars`, cortando en un
 * limite de linea. Conserva el inicio del texto (lo mas cercano al cursor).
 */
export function trimSuffixContext(suffix: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (suffix.length <= maxChars) return suffix;

  const truncated = suffix.slice(0, maxChars);
  const newlineIdx = truncated.lastIndexOf("\n");
  if (newlineIdx === -1) {
    return truncated;
  }
  return truncated.slice(0, newlineIdx);
}

/** Construye el prompt FIM crudo que espera Ollama con `raw: true`. */
export function buildFimPrompt(prefix: string, suffix: string): string {
  return FIM_PREFIX + prefix + FIM_SUFFIX + suffix + FIM_MIDDLE;
}

export interface BuildRequestParams {
  model: string;
  prefix: string;
  suffix: string;
  maxPrefixChars: number;
  maxSuffixChars: number;
  numPredict?: number;
  keepAlive?: string;
}

/** Valor por defecto de `keep_alive`: el modelo sigue residente media hora
 *  desde la ultima peticion, asi que una sesion de edicion normal siempre lo
 *  encuentra caliente (~50 ms) en vez de pagar la carga en frio (~10 s). */
export const DEFAULT_KEEP_ALIVE = "30m";

/** Construye el cuerpo de `/api/generate` a partir del contexto ya recortado. */
export function buildGenerateRequest(params: BuildRequestParams): OllamaGenerateRequest {
  const trimmedPrefix = trimPrefixContext(params.prefix, params.maxPrefixChars);
  const trimmedSuffix = trimSuffixContext(params.suffix, params.maxSuffixChars);
  return {
    model: params.model,
    prompt: buildFimPrompt(trimmedPrefix, trimmedSuffix),
    raw: true,
    stream: false,
    keep_alive: params.keepAlive ?? DEFAULT_KEEP_ALIVE,
    options: {
      num_predict: params.numPredict ?? 48,
      temperature: 0,
      stop: ["\n"],
    },
  };
}

/**
 * Peticion de calentamiento: carga el modelo en RAM sin generar tokens
 * (`num_predict: 0`). Se lanza con un timeout propio y largo, porque la carga
 * en frio de un modelo de 1 GB ronda los 10 s en este equipo, muy por encima
 * del timeout con el que se pide una sugerencia.
 */
export function buildWarmupRequest(model: string, keepAlive?: string): OllamaGenerateRequest {
  return {
    model,
    prompt: "",
    raw: true,
    stream: false,
    keep_alive: keepAlive ?? DEFAULT_KEEP_ALIVE,
    options: { num_predict: 0, temperature: 0, stop: [] },
  };
}

/**
 * Busca el mayor solape entre el final de `text` y el inicio de
 * `suffixLine`, y lo elimina de `text`. Cubre el caso en que el modelo
 * repite (total o parcialmente) el texto que ya sigue al cursor.
 */
function stripDuplicateSuffixOverlap(text: string, suffixLine: string): string {
  if (text.length === 0 || suffixLine.length === 0) return text;

  const maxOverlap = Math.min(text.length, suffixLine.length);
  for (let overlap = maxOverlap; overlap > 0; overlap--) {
    if (text.slice(text.length - overlap) === suffixLine.slice(0, overlap)) {
      return text.slice(0, text.length - overlap);
    }
  }
  return text;
}

/**
 * Sanea la respuesta cruda de Ollama para usarla como ghost text de una
 * unica linea. Devuelve `null` cuando no hay nada util que sugerir:
 * respuesta vacia/solo espacios, o una respuesta que duplica integramente
 * el texto que ya esta despues del cursor.
 */
export function sanitizeCompletion(raw: string | null | undefined, textAfterCursor: string): string | null {
  if (!raw) return null;

  // Defensa extra por si el stop token no corto la respuesta (raw=true).
  const firstLine = raw.split("\n")[0].replace(/\r$/, "");
  if (firstLine.trim().length === 0) return null;

  const suffixLine = textAfterCursor.split("\n")[0];

  if (suffixLine.startsWith(firstLine)) {
    // Todo lo propuesto ya esta presente justo despues del cursor.
    return null;
  }

  const deduped = stripDuplicateSuffixOverlap(firstLine, suffixLine);
  if (deduped.trim().length === 0) return null;

  return deduped;
}

export interface FetchGenerateOptions {
  endpoint: string;
  request: OllamaGenerateRequest;
  timeoutMs: number;
  signal?: AbortSignal;
  fetchImpl: typeof fetch;
}

/**
 * Llama a `/api/generate` con timeout propio (ademas de un `signal`
 * externo opcional para cancelacion por parte del editor).
 */
export async function fetchCompletion(options: FetchGenerateOptions): Promise<string | null> {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onExternalAbort);

  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const res = await options.fetchImpl(`${options.endpoint.replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options.request),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Ollama respondio ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as OllamaGenerateResponse;
    return data.response ?? null;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}

// ---------------------------------------------------------------------------
// Resolucion del modelo activo cuando `ollamaTab.model` esta vacio: el
// modelo cargado segun `GET /api/ps` (la extension no decide el modelo,
// solo pregunta cual esta cargado ahora mismo — eso lo controla ULTRON
// Control Center > AI Router > Modelo local o la bandeja del sistema).
// ---------------------------------------------------------------------------

interface OllamaPsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

/**
 * Nombre del primer modelo cargado segun el cuerpo crudo de `/api/ps`.
 * `null` si el JSON es invalido, no trae `models`, o la lista esta vacia
 * (ningun modelo cargado ahora mismo).
 */
// ---------------------------------------------------------------------------
// Motor de autocompletado activo.
//
// VS Code deja que varias extensiones registren un proveedor de ghost text a
// la vez y muestra la propuesta de una de ellas sin criterio estable, asi que
// tener Copilot y Ollama Tab compitiendo da un resultado impredecible: no se
// sabe cual escribio la sugerencia. Aqui el motor es EXCLUYENTE y de una sola
// fuente de verdad (`ollamaTab.engine`): elegir uno apaga el otro.
// ---------------------------------------------------------------------------

/** `off` = sin ghost text; `copilot` = GitHub Copilot; `low`/`mid`/`high` =
 *  modelo local, de menos a mas VRAM. */
export type Engine = "off" | "copilot" | "low" | "mid" | "high";

export const LOCAL_ENGINES: readonly Engine[] = ["low", "mid", "high"];

export interface EngineModels {
  low: string;
  mid: string;
  high: string;
}

export interface EngineResolution {
  /** Modelo de Ollama que sirve las sugerencias, o null si el motor no es local. */
  model: string | null;
  /** Modelos locales que deben soltarse de VRAM al activar este motor. */
  unload: string[];
  /** Si el proveedor de Ollama Tab debe responder. */
  ollamaEnabled: boolean;
  /** Si Copilot debe tener el autocompletado inline activo. */
  copilotEnabled: boolean;
}

/**
 * Traduce el motor elegido a la configuracion completa que hay que aplicar.
 * El campo `unload` es lo que hace practicable tener los dos modelos
 * instalados: solo el del motor activo ocupa VRAM (8 GB en este equipo, de los
 * que ~3 ya estan tomados), el otro se descarga con `keep_alive: 0`.
 */
export function resolveEngine(engine: Engine, models: EngineModels): EngineResolution {
  const all = [models.low, models.mid, models.high];
  const others = (active: string): string[] => all.filter((m) => m !== active);

  switch (engine) {
    case "low":
      return { model: models.low, unload: others(models.low), ollamaEnabled: true, copilotEnabled: false };
    case "mid":
      return { model: models.mid, unload: others(models.mid), ollamaEnabled: true, copilotEnabled: false };
    case "high":
      return { model: models.high, unload: others(models.high), ollamaEnabled: true, copilotEnabled: false };
    case "copilot":
      return { model: null, unload: all, ollamaEnabled: false, copilotEnabled: true };
    case "off":
    default:
      return { model: null, unload: all, ollamaEnabled: false, copilotEnabled: false };
  }
}

// ---------------------------------------------------------------------------
// Presupuesto de VRAM.
// ---------------------------------------------------------------------------

/** Margen sobre el tamano del modelo: el contexto y los buffers del runtime no
 *  entran en el peso del fichero, y quedarse al limite empuja capas a la CPU. */
const VRAM_MARGIN = 1.15;

export interface VramCheck {
  freeMb: number;
  neededMb: number;
}

/**
 * Tamano en MB que `/api/tags` declara para un modelo, o null si no aparece.
 * Sirve para decidir si el modelo cabe ANTES de intentar cargarlo.
 */
export function modelSizeMb(tagsBody: string, model: string): number | null {
  let parsed: { models?: { name?: string; model?: string; size?: number }[] };
  try {
    parsed = JSON.parse(tagsBody) as typeof parsed;
  } catch {
    return null;
  }
  const entry = (parsed.models ?? []).find((m) => m.name === model || m.model === model);
  if (!entry || typeof entry.size !== "number") return null;
  return Math.round(entry.size / 1_000_000);
}

/**
 * Aviso cuando el modelo no cabe en la VRAM libre. Devuelve null si cabe (o si
 * no hay datos para juzgarlo: sin GPU NVIDIA, `nvidia-smi` ausente o modelo
 * desconocido, se deja pasar en vez de bloquear por una sospecha).
 */
export function vramWarning({ freeMb, neededMb }: VramCheck): string | null {
  if (!Number.isFinite(freeMb) || !Number.isFinite(neededMb) || neededMb <= 0) return null;
  const budget = Math.round(neededMb * VRAM_MARGIN);
  if (freeMb >= budget) return null;
  return `Quedan ${freeMb} MB de VRAM libres y este modelo necesita ~${budget} MB. Ollama descargara capas a la CPU y las sugerencias iran lentas.`;
}

export interface EngineStatusParams {
  engine: Engine;
  model: string | null;
  suggestionCount: number;
}

/**
 * Etiqueta de la barra de estado. Nombra SIEMPRE el motor activo: con dos
 * fuentes posibles de ghost text, saber cual escribio la sugerencia es el dato
 * que se mira de un vistazo.
 */
export function formatEngineStatus({ engine, model, suggestionCount }: EngineStatusParams): string {
  if (engine === "off") return "Sin autocompletado";
  if (engine === "copilot") return "Copilot";
  const name = model ?? "?";
  return `Ollama ${engine} · ${name} · ${suggestionCount}`;
}

/** Nombres de los modelos que `/api/ps` declara cargados ahora mismo. */
export function loadedModelNames(body: string): string[] {
  let parsed: OllamaPsResponse;
  try {
    parsed = JSON.parse(body) as OllamaPsResponse;
  } catch {
    return [];
  }
  return (parsed.models ?? [])
    .map((entry) => entry.name ?? entry.model ?? null)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
}

/**
 * True si `model` figura entre los cargados. Ollama devuelve el nombre con
 * etiqueta (`qwen2.5-coder:1.5b-base`); un ajuste escrito sin etiqueta se
 * acepta comparando solo la parte anterior a los dos puntos, para no dar por
 * frio un modelo que si esta en RAM.
 */
export function isModelLoaded(body: string, model: string): boolean {
  const wanted = model.trim();
  if (!wanted) return false;
  return loadedModelNames(body).some(
    (name) => name === wanted || name.split(":")[0] === wanted.split(":")[0],
  );
}

export function firstLoadedModelName(body: string): string | null {
  let parsed: OllamaPsResponse;
  try {
    parsed = JSON.parse(body) as OllamaPsResponse;
  } catch {
    return null;
  }
  const first = parsed.models?.[0];
  if (!first) return null;
  return first.name ?? first.model ?? null;
}

// ---------------------------------------------------------------------------
// Barra de estado — modelo activo + contador de sugerencias servidas en
// la sesion, para distinguir a simple vista una sugerencia de esta
// extension de una de GitHub Copilot (ambas se muestran como "ghost
// text" gris y son indistinguibles sin esta etiqueta).
// ---------------------------------------------------------------------------

/** Texto de la barra de estado (sin el icono, que decide `extension.ts` segun el estado de conexion). */
export function formatStatusBarLabel(params: { model: string | null; suggestionCount: number }): string {
  const modelPart = params.model ? ` · ${params.model}` : "";
  return `Ollama Tab${modelPart} · ${params.suggestionCount}`;
}

// ---------------------------------------------------------------------------
// Traza de sugerencias en el OutputChannel — una linea por sugerencia
// MOSTRADA (no por peticion: las que `sanitizeCompletion` descarta no
// generan linea). Nunca vuelca el prefijo/sufijo del fichero: eso podria
// incluir codigo sensible y no aporta nada que el propio editor no
// muestre ya.
// ---------------------------------------------------------------------------

const LOG_SUGGESTION_MAX_CHARS = 60;

/** Recorta `text` a `maxChars` (60 por defecto) anadiendo `…` si se corta. */
export function truncateForLog(text: string, maxChars: number = LOG_SUGGESTION_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/** `HH:MM:SS` en hora local — funcion pura via inyeccion de `Date` (testeable sin mockear el reloj). */
export function formatLogTime(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

export interface SuggestionLogLineParams {
  date: Date;
  languageId: string;
  elapsedMs: number;
  suggestion: string;
}

/** Linea de traza para una sugerencia mostrada: hora, lenguaje, latencia y texto (truncado). */
export function formatSuggestionLogLine(params: SuggestionLogLineParams): string {
  const time = formatLogTime(params.date);
  const truncated = truncateForLog(params.suggestion);
  return `[${time}] ${params.languageId} ${params.elapsedMs}ms: ${truncated}`;
}
