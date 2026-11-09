// Parte pura de la segunda opinión automática (`auto-review.ts`): ficheros
// editados en un turno, prompt de la revisión y si su resultado se enseña.

import type { ChatMessage, EngineTask, SessionInfo } from "./types";

export const AUTO_REVIEW_MIN_FILES = 5;
/** Turnos revisados y tareas avisadas que se recuerdan (las más recientes). */
export const MAX_REMEMBERED = 500;
/** Respuesta pactada de Codex cuando no encuentra nada (cabecera `review` del backend). */
export const SIN_HALLAZGOS = "SIN HALLAZGOS";
const MAX_KEYS = 200;
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Clave estable de la conversación: sobrevive a reinicios y restauraciones. */
export function reviewKey(info: Pick<SessionInfo, "id" | "claudeSessionId">): string {
  return info.claudeSessionId ?? info.id;
}

/** Normaliza lo leído del almacenamiento: solo cadenas, sin duplicados, con tope. */
export function sanitizeKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const keys = raw.filter((k): k is string => typeof k === "string" && k.length > 0 && k.length <= 128);
  return [...new Set(keys)].slice(-MAX_KEYS);
}

/** Interruptores guardados en localStorage (texto crudo o `null`). */
export function parseStoredKeys(raw: string | null): string[] {
  try {
    return sanitizeKeys(raw ? JSON.parse(raw) : null);
  } catch {
    return [];
  }
}

/** Apunta `key` en `set` y descarta las más antiguas por encima de `max` (orden de inserción). */
export function rememberBounded(set: Set<string>, key: string, max = MAX_REMEMBERED): void {
  set.delete(key);
  set.add(key);
  for (const oldest of set) {
    if (set.size <= max) break;
    set.delete(oldest);
  }
}

/** true si la sesión ya tiene una revisión automática en curso. */
export function hasRunningReview(tasks: readonly EngineTask[], sessionId: string): boolean {
  return tasks.some((t) => t.kind === "review" && t.status === "running" && t.sessionId === sessionId);
}

function filePathOf(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const r = input as Record<string, unknown>;
  const v = r.file_path ?? r.notebook_path;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Ficheros distintos que editaron Write/Edit/MultiEdit/NotebookEdit desde `sinceIso`. */
export function editedFiles(messages: readonly ChatMessage[], sinceIso: string): string[] {
  const since = Date.parse(sinceIso);
  const files = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant" || Date.parse(m.timestamp) < since) continue;
    for (const b of m.blocks) {
      if (b.kind !== "toolUse" || !WRITE_TOOLS.has(b.name)) continue;
      const p = filePathOf(b.input);
      if (p) files.add(p);
    }
  }
  return [...files];
}

/** Unión sin duplicados, en orden: primero `a` y luego lo que solo está en `b`. */
export function mergeFiles(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])];
}

export function reviewPrompt(files: readonly string[]): string {
  return [`Ficheros que Claude editó en el último turno (${files.length}):`, ...files.map((f) => `- ${f}`)].join("\n");
}

/** true si la revisión no encontró nada (tolera negritas y puntuación alrededor). */
export function isCleanReview(summary: string | undefined): boolean {
  const t = (summary ?? "").replace(/[*_`.!\s]+/g, " ").trim().toUpperCase();
  return t === SIN_HALLAZGOS;
}

/** En el chat, una revisión automática solo se ve si encontró algo o falló. */
export function visibleInChat(t: EngineTask): boolean {
  if (t.kind !== "review") return true;
  if (t.status === "running" || t.status === "cancelled") return false;
  return t.status === "error" || !isCleanReview(t.summary);
}
