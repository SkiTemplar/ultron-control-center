// Borradores del composer por sesión. El composer se remonta al cambiar la sesión
// de un panel (pestaña, barra lateral o selector del panel) para que el texto, los
// adjuntos, el dictado y los menús de una sesión no aparezcan en otra; aquí se
// guarda lo que quedó a medias para recuperarlo al volver a esa sesión.
//
// Además se copian en `sessionStorage` (con un debounce corto) para sobrevivir a
// una recarga de la página en el mismo WebView: la que hace el backend tras una
// caída del renderer (`ventana.rs`, `Reload`) no avisa antes, así que lo escrito en
// los últimos `PERSIST_DELAY_MS` puede perderse; lo anterior, no.

import type { SendTarget, SessionId } from "../../types";
import type { Attachment } from "./useAttachments";

export interface ComposerDraft {
  text: string;
  attachments: readonly Attachment[];
  target: SendTarget;
  delegate: boolean;
}

export const DRAFTS_STORAGE_KEY = "ultron.sesiones.drafts.v1";
/** Espera desde el último cambio hasta la copia en `sessionStorage`. */
export const PERSIST_DELAY_MS = 250;

const TARGETS: ReadonlySet<string> = new Set<SendTarget>(["claude", "codexLocal", "codexCloud", "gemini", "opencode"]);

function isEmpty(d: ComposerDraft): boolean {
  return !d.text && d.attachments.length === 0 && d.target === "claude" && !d.delegate;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseAttachment(v: unknown): Attachment | null {
  if (!isRecord(v)) return null;
  const { path, previewDataUrl, name, mediaType, isPathOnly } = v;
  if (typeof path !== "string" || typeof name !== "string" || typeof mediaType !== "string") return null;
  if (previewDataUrl !== null && typeof previewDataUrl !== "string") return null;
  return { path, previewDataUrl, name, mediaType, ...(isPathOnly === true ? { isPathOnly } : {}) };
}

function parseDraft(v: unknown): ComposerDraft | null {
  if (!isRecord(v)) return null;
  const { text, attachments, target, delegate } = v;
  if (typeof text !== "string" || !Array.isArray(attachments) || typeof delegate !== "boolean") return null;
  if (typeof target !== "string" || !TARGETS.has(target)) return null;
  const parsed = attachments.map(parseAttachment);
  if (parsed.some((a) => a === null)) return null;
  return { text, attachments: parsed as Attachment[], target: target as SendTarget, delegate };
}

/** Borradores guardados en `raw` (JSON); lo mal formado se descarta entrada a entrada. */
export function parseStoredDrafts(raw: string | null): Map<SessionId, ComposerDraft> {
  const out = new Map<SessionId, ComposerDraft>();
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!isRecord(parsed)) return out;
  for (const [id, v] of Object.entries(parsed)) {
    const d = parseDraft(v);
    if (d && !isEmpty(d)) out.set(id, d);
  }
  return out;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function load(): Map<SessionId, ComposerDraft> {
  try {
    return parseStoredDrafts(storage()?.getItem(DRAFTS_STORAGE_KEY) ?? null);
  } catch {
    return new Map();
  }
}

const drafts = load();
let timer: ReturnType<typeof setTimeout> | null = null;

function serialize(withPreviews: boolean): string {
  const entries = [...drafts].map(([id, d]) => [
    id,
    withPreviews ? d : { ...d, attachments: d.attachments.map((a) => ({ ...a, previewDataUrl: null })) },
  ]);
  return JSON.stringify(Object.fromEntries(entries));
}

/**
 * Copia los borradores en `sessionStorage` ya. Si la cuota no da para las vistas
 * previas de las imágenes, se guardan sin ellas (el fichero adjunto sigue). `false`
 * si no se pudo guardar nada: el borrador sigue en memoria, pero no sobrevivirá a
 * una recarga.
 */
export function flushDrafts(): boolean {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  const s = storage();
  if (!s) return false;
  try {
    if (drafts.size === 0) s.removeItem(DRAFTS_STORAGE_KEY);
    else s.setItem(DRAFTS_STORAGE_KEY, serialize(true));
    return true;
  } catch {
    try {
      s.setItem(DRAFTS_STORAGE_KEY, serialize(false));
      return true;
    } catch {
      return false;
    }
  }
}

function schedulePersist(): void {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(flushDrafts, PERSIST_DELAY_MS);
}

if (typeof window !== "undefined") window.addEventListener("pagehide", () => void flushDrafts());

export function readDraft(id: SessionId): ComposerDraft | null {
  return drafts.get(id) ?? null;
}

/** Guarda una copia del borrador; uno vacío borra la entrada para no acumular sesiones cerradas. */
export function saveDraft(id: SessionId, draft: ComposerDraft): void {
  if (isEmpty(draft)) {
    if (!drafts.delete(id)) return;
  } else {
    drafts.set(id, { ...draft, attachments: [...draft.attachments] });
  }
  schedulePersist();
}

/** Solo para tests: vacía todos los borradores guardados, también en `sessionStorage`. */
export function clearDrafts(): void {
  drafts.clear();
  flushDrafts();
}
