// Las cabeceras de BatchDropdown y ProjectQuickActions solo citan comandos de
// la cola de .bat que existen (auditoría Kirkardo del 2026-10-23: citaban
// `batches_enqueue_manual`, que no existe, y mezclaban la cola viva con el
// RunBatch del kanban, retirado el 2026-10-17).

import { describe, expect, it } from "vitest";
import batchDropdown from "../BatchDropdown.tsx?raw";
import quickActions from "../ProjectQuickActions.tsx?raw";
import handlers from "../../../../src-tauri/src/handlers.rs?raw";

/** Comentario de cabecera: las líneas `//` iniciales del fichero. */
function header(src: string): string {
  const lines = src.split(/\r?\n/);
  const end = lines.findIndex((l) => !l.startsWith("//"));
  return lines.slice(0, end === -1 ? lines.length : end).join("\n");
}

/**
 * Identificadores snake_case de la cola de .bat citados en la cabecera, sin
 * las rutas de ficheros (`src-tauri/src/commands/batches_sub/...`).
 */
function batchCommands(src: string): string[] {
  const text = header(src).replace(/src-tauri\/\S+/g, "");
  return [...new Set(text.match(/\b[a-z]*_?batch(?:es)?_?[a-z_]*\b/g) ?? [])].filter((w) =>
    w.includes("_"),
  );
}

const registered = (cmd: string) => new RegExp(`::${cmd},`).test(handlers);

describe("cabeceras de la cola de .bat", () => {
  it.each([
    ["BatchDropdown.tsx", batchDropdown],
    ["ProjectQuickActions.tsx", quickActions],
  ])("%s solo cita comandos registrados en handlers.rs", (_name, src) => {
    const cited = batchCommands(src);
    expect(cited.length).toBeGreaterThan(0);
    expect(cited.filter((c) => !registered(c))).toEqual([]);
  });

  it("ninguna da el RunBatch por vivo: si lo nombran, es como retirado", () => {
    for (const src of [batchDropdown, quickActions]) {
      const h = header(src);
      if (/RunBatch/.test(h)) expect(h).toMatch(/RunBatch[^.]*retirad/);
    }
  });
});
