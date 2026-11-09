// Qué hace el composer con cada adjunto. Imágenes, PDF y texto dentro de sus
// topes se copian a `~/.ultron/adjuntos` y van como mención `@"ruta"`, que Claude
// Code lee entera. Del resto (binarios, tipos desconocidos, ficheros que superan
// el tope) se envía solo la ruta en el texto del mensaje: una mención a un `.log`
// enorme o a un `.obj` costaría tokens, y un binario no aportaría nada.

import type { Attachment } from "./useAttachments";

export const MAX_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;

export const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];
/** Misma lista que `TEXT_EXT` en `sesiones/adjuntos.rs` (lo comprueba un test). */
export const TEXT_EXT = [
  "txt", "md", "markdown", "json", "jsonl", "csv", "tsv", "log", "yaml", "yml", "toml", "xml",
  "ini", "cfg", "rs", "ts", "tsx", "js", "jsx", "mjs", "py", "c", "h", "cpp", "hpp", "cs", "java",
  "go", "sh", "ps1", "sql", "html", "css", "diff", "patch",
];

/** Rótulo de la ruta en el mensaje; `adjuntos-collect.ts` lo reconoce en el transcript. */
export const PATH_ONLY_LABEL = "Fichero adjunto (solo ruta):";

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** ¿Se puede citar con `@` para que Claude Code lo lea? */
export function isReadable(name: string, size: number): boolean {
  const ext = extensionOf(name);
  if (TEXT_EXT.includes(ext)) return size <= MAX_TEXT_BYTES;
  return (IMAGE_EXT.includes(ext) || ext === "pdf") && size <= MAX_BYTES;
}

/** Texto y menciones de un envío: las rutas sin mención van al final del texto. */
export function outgoingPayload(text: string, items: readonly Attachment[]): { text: string; attachments: string[] } {
  const routes = items.filter((a) => a.isPathOnly).map((a) => `${PATH_ONLY_LABEL} "${a.path}"`);
  return {
    text: [text, routes.join("\n")].filter(Boolean).join("\n\n"),
    attachments: items.filter((a) => !a.isPathOnly).map((a) => a.path),
  };
}
