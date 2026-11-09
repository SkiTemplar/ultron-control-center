// ULTRON Control Center — AI Router: lógica pura de la sección «Modelo local».
//
// Tipos espejo de src-tauri/src/ollama/{api,editor}.rs y funciones puras que
// deciden etiquetas y estados a partir de ellos. Sin React ni invoke: se
// testean en ollamaEngine.test.ts.

/** Espejo de `EditorEngineStatus` en src-tauri/src/ollama/editor.rs. */
export interface EditorEngineStatus {
  available: boolean;
  engine: string;
  model_low: string;
  model_mid: string;
  model_high: string;
  active_model: string | null;
  settings_path: string | null;
  /** `ollamaTab.keepAlive` explícito; null = plazo según el motor (5m low/mid, 10m high). */
  keep_alive_override: string | null;
}

export interface LoadedModel {
  name: string;
  size_vram: number;
  expires_at: string | null;
}

export interface DownloadedModel {
  name: string;
  size: number;
  family: string | null;
  parameter_size: string | null;
  quantization_level: string | null;
}

export type LocalEngine = "low" | "mid" | "high";

/** Espejo de `OllamaStatus` en src-tauri/src/ollama/api.rs. */
export interface OllamaStatus {
  installed: boolean;
  server_up: boolean;
  version: string | null;
  /** Modelo del motor activo si es local; si no, el del último motor local. */
  configured_model: string;
  configured_engine: LocalEngine;
  loaded_models: LoadedModel[];
  downloaded_models: DownloadedModel[];
}

export const LOCAL_ENGINES: readonly LocalEngine[] = ["low", "mid", "high"];

const LOCAL_HINT: Record<LocalEngine, string> = {
  low: "rápido",
  mid: "equilibrado",
  high: "potente",
};

export function isLocalEngine(engine: string): engine is LocalEngine {
  return (LOCAL_ENGINES as readonly string[]).includes(engine);
}

export function modelForEngine(status: EditorEngineStatus, engine: LocalEngine): string {
  if (engine === "low") return status.model_low;
  if (engine === "mid") return status.model_mid;
  return status.model_high;
}

const SIZE_TOKEN = /^\d+(\.\d+)?[bm]$/i;

function findSize(text: string): string | null {
  const token = text.split(/[-_/]/).find((t) => SIZE_TOKEN.test(t));
  return token ? token.toLowerCase() : null;
}

/**
 * Tamaño legible de un modelo: "qwen2.5-coder:3b-base" → "3b". Busca primero
 * en el tag y después en el nombre base; sin tamaño reconocible devuelve el
 * tag (o el nombre entero si no tiene). Espejo de `editor::model_size_label`.
 */
export function modelSizeLabel(model: string): string {
  const colon = model.lastIndexOf(":");
  const hasTag = colon >= 0 && colon < model.length - 1;
  const base = hasTag ? model.slice(0, colon) : model;
  const tag = hasTag ? model.slice(colon + 1) : model;
  return findSize(tag) ?? findSize(base) ?? tag;
}

export interface EngineOption {
  engine: string;
  label: string;
  /** Tooltip: nombre completo del modelo o descripción del motor. */
  title: string;
}

/** Botones del motor, con el tamaño real de cada nivel local. */
export function engineOptions(status: EditorEngineStatus): EngineOption[] {
  const local = LOCAL_ENGINES.map((engine) => {
    const model = modelForEngine(status, engine);
    return { engine, label: `${modelSizeLabel(model)} · ${LOCAL_HINT[engine]}`, title: model };
  });
  return [
    ...local,
    { engine: "copilot", label: "Copilot", title: "GitHub Copilot, en la nube; libera la VRAM" },
    { engine: "off", label: "Apagado", title: "Sin autocompletado; libera la VRAM" },
  ];
}

/** Ollama trata un nombre sin tag como `:latest`. Espejo de `switch::same_model`. */
export function sameModel(a: string, b: string): boolean {
  const normalize = (m: string) => (m.split("/").pop()?.includes(":") ? m : `${m}:latest`);
  return normalize(a) === normalize(b);
}

export function findLoaded(status: OllamaStatus | null): LoadedModel | undefined {
  return status?.loaded_models.find((m) => sameModel(m.name, status.configured_model));
}

/** El modelo del motor de referencia está en disco (solo fiable con el servidor arriba). */
export function isConfiguredDownloaded(status: OllamaStatus): boolean {
  return status.downloaded_models.some((m) => sameModel(m.name, status.configured_model));
}

/**
 * Caducidad de un modelo cargado a partir de `expires_at` de /api/ps: Ollama
 * lo suelta si pasa el plazo del motor (`keep_alive`) sin peticiones. Un
 * instante a más de 10 años es un `keep_alive: -1` explícito.
 */
export function formatExpiry(expiresAt: string | null, now: number = Date.now()): string | null {
  if (!expiresAt) return null;
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return null;
  const yearsAhead = (date.getTime() - now) / (365 * 24 * 60 * 60 * 1000);
  if (yearsAhead > 10) return "sin caducidad (keep_alive -1)";
  if (yearsAhead < 0) return "caducado";
  const time = date.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  return `se descarga a las ${time} si no se usa`;
}

export type HeaderTone = "ok" | "warn" | "danger" | "muted" | "accent";

export interface HeaderState {
  title: string;
  label: string;
  tone: HeaderTone;
}

/** Título y punto de estado de la cabecera. */
export function headerState(
  status: OllamaStatus | null,
  engine: EditorEngineStatus | null,
  statusError: string | null,
  engineBusy: boolean,
): HeaderState {
  if (!status) {
    return statusError
      ? { title: "Modelo local", label: "error", tone: "danger" }
      : { title: "Modelo local", label: "comprobando…", tone: "muted" };
  }
  const model = status.configured_model;
  if (engineBusy) return { title: model, label: "cambiando de motor…", tone: "warn" };
  if (engine && !engine.available) {
    return { title: model, label: "VS Code no encontrado", tone: "muted" };
  }
  if (engine?.engine === "copilot") return { title: "Copilot", label: "Copilot activo", tone: "accent" };
  if (engine?.engine === "off") return { title: "Autocompletado apagado", label: "apagado", tone: "muted" };
  if (!status.installed) return { title: model, label: "Ollama no instalado", tone: "muted" };
  if (!status.server_up) return { title: model, label: "servidor parado", tone: "warn" };
  if (findLoaded(status)) return { title: model, label: "cargado", tone: "ok" };
  if (!isConfiguredDownloaded(status)) return { title: model, label: "no descargado", tone: "danger" };
  return { title: model, label: "no cargado", tone: "danger" };
}

/** Motivo por el que «Medir latencia» no se puede usar, o null si se puede. */
export function benchmarkBlockReason(
  status: OllamaStatus | null,
  engine: EditorEngineStatus | null,
): string | null {
  if (!status || !engine) return "Comprobando el estado…";
  if (!isLocalEngine(engine.engine)) {
    return "Solo se mide con un motor local activo: elige uno de los niveles locales.";
  }
  if (!status.server_up) return "El servidor de Ollama está parado.";
  if (findLoaded(status)) return null;
  if (!isConfiguredDownloaded(status)) {
    return `${status.configured_model} no está descargado: descárgalo abajo, en «Descargar modelo».`;
  }
  return `${status.configured_model} no está cargado: vuelve a elegir su motor para cargarlo.`;
}
