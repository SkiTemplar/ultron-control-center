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
}

/** Construye el cuerpo de `/api/generate` a partir del contexto ya recortado. */
export function buildGenerateRequest(params: BuildRequestParams): OllamaGenerateRequest {
  const trimmedPrefix = trimPrefixContext(params.prefix, params.maxPrefixChars);
  const trimmedSuffix = trimSuffixContext(params.suffix, params.maxSuffixChars);
  return {
    model: params.model,
    prompt: buildFimPrompt(trimmedPrefix, trimmedSuffix),
    raw: true,
    stream: false,
    options: {
      num_predict: params.numPredict ?? 48,
      temperature: 0,
      stop: ["\n"],
    },
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
