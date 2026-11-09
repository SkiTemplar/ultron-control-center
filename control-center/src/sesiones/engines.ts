// Motores consultores (Codex, Gemini y OpenCode) en la línea de tiempo de Claude (E8):
// normalización de eventos, destino del composer y paquete de la segunda opinión.

import type { SesionesApi } from "./api";
import { reportError } from "./bootstrap";
import { prefsStore } from "./prefs";
import { store } from "./store";
import type { EngineId, EngineModel, EngineStatus, EngineTask, EngineTaskKind, SendTarget, SessionId } from "./types";

export const ENGINE_LABEL: Record<EngineId, string> = { codex: "Codex", gemini: "Gemini", opencode: "OpenCode" };

/** Motores externos, en el orden en que se muestran. */
export const ENGINE_IDS: readonly EngineId[] = ["codex", "gemini", "opencode"];

/** Nombre visible de los proveedores de OpenCode (`opencode_entorno.rs`). */
const OPENCODE_PROVIDERS: Record<string, string> = {
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
  groq: "Groq",
  cerebras: "Cerebras",
  nvidia: "NVIDIA NIM",
  google: "Google",
};

/** Proveedor de un modelo de OpenCode (`deepseek/deepseek-flash` → «DeepSeek»); null en los demás motores. */
export function modelProvider(engine: EngineId, modelId: string): string | null {
  if (engine !== "opencode") return null;
  const cut = modelId.indexOf("/");
  if (cut <= 0) return null;
  const id = modelId.slice(0, cut);
  return OPENCODE_PROVIDERS[id] ?? id;
}

/** Máximo de la respuesta que se cita en una segunda opinión (el backend añade el contexto). */
export const OPINION_QUOTE_MAX = 6000;

export function engineOfTarget(target: SendTarget): EngineId | null {
  if (target === "codexLocal" || target === "codexCloud") return "codex";
  if (target === "gemini") return "gemini";
  if (target === "opencode") return "opencode";
  return null;
}

/** Estado de un motor; `null` mientras no se sepa (no se bloquea a ciegas). */
export function engineState(list: EngineStatus[] | null, id: EngineId): EngineStatus | null {
  return list?.find((e) => e.id === id) ?? null;
}

/** Motivo por el que un motor no se puede usar, o `null` si está disponible. */
export function engineBlockReason(list: EngineStatus[] | null, id: EngineId): string | null {
  const st = engineState(list, id);
  if (!st) return list ? `${ENGINE_LABEL[id]} no aparece en la detección de motores` : null;
  return st.available ? null : st.reason ?? `${ENGINE_LABEL[id]} no está disponible`;
}

export function opinionPrompt(answer: string): string {
  const quote = answer.length > OPINION_QUOTE_MAX ? `${answer.slice(0, OPINION_QUOTE_MAX)}\n[…recortado]` : answer;
  return [
    "Da una segunda opinión crítica sobre la última respuesta de Claude en esta sesión.",
    "Señala errores, riesgos y alternativas concretas; si estás de acuerdo, dilo en una línea.",
    "",
    "<respuesta-de-claude>",
    quote,
    "</respuesta-de-claude>",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Modelos de cada motor: lista de su CLI, cacheada (un fallo, 60 s)
// ---------------------------------------------------------------------------

/** Tiempo que se recuerda un fallo de `engineModels` antes de reintentar. */
export const MODELS_ERROR_TTL_MS = 60_000;

type ModelsEntry = { models: EngineModel[] } | { error: string; at: number };
const modelsCache = new Map<EngineId, ModelsEntry>();
const inFlight = new Map<EngineId, Promise<EngineModel[]>>();

/** Lista cacheada, si la hay (sin pedirla). */
export function cachedEngineModels(engine: EngineId): EngineModel[] | null {
  const hit = modelsCache.get(engine);
  return hit && "models" in hit ? hit.models : null;
}

/** Modelos del motor: los aciertos se guardan; un fallo se repite 60 s sin relanzar la CLI. */
export function loadEngineModels(api: SesionesApi, engine: EngineId, now = Date.now()): Promise<EngineModel[]> {
  const hit = modelsCache.get(engine);
  if (hit && "models" in hit) return Promise.resolve(hit.models);
  if (hit && now - hit.at < MODELS_ERROR_TTL_MS) return Promise.reject(new Error(hit.error));
  const running = inFlight.get(engine);
  if (running) return running;
  const p = api.engineModels(engine).then(
    (models) => {
      modelsCache.set(engine, { models });
      return models;
    },
    (e: unknown) => {
      modelsCache.set(engine, { error: e instanceof Error ? e.message : String(e), at: now });
      throw e;
    },
  ).finally(() => inFlight.delete(engine));
  inFlight.set(engine, p);
  return p;
}

/** Solo para tests: olvida lo cacheado. */
export function resetEngineModelsCache(): void {
  modelsCache.clear();
  inFlight.clear();
}

/**
 * Modelo con el que se lanza el motor: la preferencia si sigue en la lista de
 * la CLI. Codex Cloud usa el de su entorno. Sin lista (la CLI no respondió)
 * se manda la preferencia y el backend la valida.
 */
export function resolveEngineModel(engine: EngineId, cloud: boolean, models: EngineModel[] | null): string | undefined {
  if (cloud) return undefined;
  const pref = prefsStore.getState().engineModels[engine];
  if (!pref) return undefined;
  if (models && !models.some((m) => m.id === pref)) return undefined;
  return pref;
}

interface RunArgs {
  sessionId: SessionId;
  engine: EngineId;
  prompt: string;
  kind: EngineTaskKind;
  cloud?: boolean;
  /** Paquete de contexto del hilo (por defecto, sí). */
  includeContext?: boolean;
  /** Id del Tribunal si se lanza junto a otro motor. */
  group?: string;
  /** Clave idempotente (turno): el backend no lanza dos veces la misma. */
  turnId?: string;
  /** Rutas de los adjuntos del composer; Codex cloud los rechaza. */
  attachments?: readonly string[];
}

/** Lanza una intervención con el modelo elegido y la añade al store. */
export async function runEngine(api: SesionesApi, args: RunArgs): Promise<EngineTask | null> {
  const cloud = Boolean(args.cloud);
  try {
    const models = cloud ? null : await loadEngineModels(api, args.engine).catch(() => null);
    const task = await api.engineRun({
      sessionId: args.sessionId,
      engine: args.engine,
      prompt: args.prompt,
      kind: args.kind,
      includeContext: args.includeContext ?? true,
      mode: args.engine === "codex" ? (cloud ? "cloud" : "local") : undefined,
      model: resolveEngineModel(args.engine, cloud, models),
      group: args.group,
      turnId: args.turnId,
      ...(args.attachments?.length ? { attachments: [...args.attachments] } : {}),
    });
    store.dispatch({ type: "engine", task });
    return task;
  } catch (e) {
    reportError(e);
    return null;
  }
}

/** Tribunal: el mismo encargo a Codex (local) y a Gemini a la vez, con un id de grupo común. */
export async function runTribunal(
  api: SesionesApi,
  args: { sessionId: SessionId; prompt: string; includeContext: boolean },
): Promise<EngineTask[]> {
  const group = crypto.randomUUID();
  const run = (engine: EngineId) => runEngine(api, { ...args, engine, kind: "task", group });
  const tasks = await Promise.all([run("codex"), run("gemini")]);
  return tasks.filter((t): t is EngineTask => t !== null);
}

/** Tareas de un Tribunal agrupadas por id, en el orden de la lista. */
export function groupTribunals(tasks: EngineTask[]): (EngineTask | EngineTask[])[] {
  const out: (EngineTask | EngineTask[])[] = [];
  const seen = new Map<string, EngineTask[]>();
  for (const t of tasks) {
    if (!t.group) {
      out.push(t);
      continue;
    }
    const g = seen.get(t.group);
    if (g) {
      g.push(t);
      continue;
    }
    const nuevo = [t];
    seen.set(t.group, nuevo);
    out.push(nuevo);
  }
  return out.map((x) => (Array.isArray(x) && x.length === 1 ? x[0] : x));
}

/** Se puede contrastar un Tribunal con todas sus respuestas terminadas bien y sin traer. */
export function canContrast(group: EngineTask[]): boolean {
  return group.length >= 2 && group.every((t) => t.status === "done" && !t.broughtAt);
}

/** Tokens de una tarea en texto corto (`18,4k → 640`), o `null` si el motor no los dio. */
export function formatUsage(t: EngineTask): string | null {
  if (!t.usage) return null;
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toLocaleString("es-ES", { maximumFractionDigits: 1 })}k` : String(n));
  return `${k(t.usage.inputTokens)} → ${k(t.usage.outputTokens)} tokens`;
}

/** Estado de los motores; `force` (botón «Detectar») salta la caché del backend. */
export async function refreshEngines(api: SesionesApi, req: { force?: boolean } = {}): Promise<void> {
  try {
    store.dispatch({ type: "engineStatus", engines: await api.engines(req) });
  } catch (e) {
    reportError(e);
  }
}
