// Inventario de adjuntos de una sesión a partir del transcript (R29,
// motores-ventanas:F7), separado en Entrada (lo que aporta el usuario:
// imágenes pegadas, ficheros citados con `@"…"` y rutas que el composer añade
// al texto con el rótulo de `PATH_ONLY_LABEL`) y Salida (lo que produce o
// enseña Claude: imágenes de resultados de herramientas, ficheros escritos
// con Write/Edit y cualquier ruta citada en sus respuestas). Las rutas
// relativas se resuelven contra el cwd de la sesión y se deduplican por ruta
// absoluta. Puro: qué existe en disco lo decide `sesiones_paths_status`.

import type { ChatMessage, SavedAttachment } from "../../types";
import { PATH_ONLY_LABEL } from "../composer/attachment-kind";
import { extractPaths, pathKey, resolvePath } from "./rutas-sesion";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface AttachmentItem {
  /** Ruta absoluta normalizada (dedupe) o identificador estable. */
  key: string;
  name: string;
  /** Ruta en disco (absoluta si se pudo resolver): abrir, carpeta, leer la imagen. */
  path?: string;
  /** `data:` URL ya disponible. */
  src?: string;
  isImage: boolean;
  /**
   * Ruta sacada del texto de Claude: solo se enseña si existe en disco. Las
   * de herramientas y las del usuario se enseñan siempre (como ausentes si
   * ya no están).
   */
  isSpeculative: boolean;
}

export interface CollectedAttachments {
  input: AttachmentItem[];
  output: AttachmentItem[];
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const MENTION = new RegExp(`(?:@|${escapeRegExp(PATH_ONLY_LABEL)} )"([^"]+)"`, "g");
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Último segmento de una ruta, con `\` o `/`. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** Entrada para `raw`; `null` si es especulativa y no se puede resolver. */
function item(raw: string, cwd: string | undefined, isSpeculative: boolean, src?: string): AttachmentItem | null {
  const abs = resolvePath(raw, cwd);
  if (!abs && isSpeculative) return null;
  const path = abs ?? raw;
  return { key: pathKey(path), name: baseName(path), path, src, isImage: IMAGE_EXT.test(path), isSpeculative };
}

class Bucket {
  private readonly byKey = new Map<string, AttachmentItem>();
  push(it: AttachmentItem | null): void {
    if (!it) return;
    const prev = this.byKey.get(it.key);
    if (!prev) {
      this.byKey.set(it.key, it);
      return;
    }
    // Una ruta citada que además escribió una herramienta deja de ser especulativa.
    if (prev.isSpeculative && !it.isSpeculative) this.byKey.set(it.key, { ...prev, isSpeculative: false, src: prev.src ?? it.src });
  }
  get items(): AttachmentItem[] {
    return [...this.byKey.values()];
  }
}

function filePathOf(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const v = (input as Record<string, unknown>).file_path ?? (input as Record<string, unknown>).notebook_path;
  return typeof v === "string" ? v : null;
}

function collectFrom(m: ChatMessage, cwd: string | undefined, input: Bucket, output: Bucket): void {
  m.blocks.forEach((b, i) => {
    if (b.kind === "toolResult") {
      (b.images ?? []).forEach((src, j) =>
        output.push({ key: `${m.uuid}-${i}-${j}`, name: `resultado ${j + 1}`, src, isImage: true, isSpeculative: false }),
      );
      return;
    }
    if (m.role === "user") {
      if (b.kind === "image") {
        const fromPath = b.path ? item(b.path, cwd, false, b.dataUrl) : null;
        input.push(fromPath ?? { key: `${m.uuid}-${i}`, name: "imagen", src: b.dataUrl, isImage: true, isSpeculative: false });
      } else if (b.kind === "text") {
        for (const match of b.text.matchAll(MENTION)) input.push(item(match[1], cwd, false));
      }
      return;
    }
    if (m.role !== "assistant") return;
    if (b.kind === "toolUse" && WRITE_TOOLS.has(b.name)) {
      const p = filePathOf(b.input);
      if (p) output.push(item(p, cwd, false));
    } else if (b.kind === "text") {
      for (const p of extractPaths(b.text)) output.push(item(p, cwd, true));
    }
  });
}

/** Adjuntos de entrada y salida de una sesión, en orden de aparición. */
export function collectAttachments(
  messages: readonly ChatMessage[],
  sent: readonly SavedAttachment[] = [],
  cwd?: string,
): CollectedAttachments {
  const input = new Bucket();
  const output = new Bucket();
  sent.forEach((a) => input.push(item(a.path, cwd, false, a.previewDataUrl ?? undefined)));
  messages.forEach((m) => collectFrom(m, cwd, input, output));
  return { input: input.items, output: output.items };
}
