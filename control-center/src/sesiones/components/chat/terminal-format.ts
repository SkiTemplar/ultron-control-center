// Formato de la vista de terminal (E2): línea `⎿` de resultado de herramienta
// y corte estable del texto en streaming. Puro, para poder probarlo.

import type { DiffStats, ToolResultBlock } from "../../parse";

const MAX_LINE = 140;

function lines(text: string): string[] {
  return text.replace(/\s+$/, "").split("\n");
}

function firstLine(text: string): string {
  const first = lines(text).find((l) => l.trim().length > 0) ?? "";
  const clean = first.trim();
  return clean.length > MAX_LINE ? `${clean.slice(0, MAX_LINE - 1)}…` : clean;
}

function n(value: number): string {
  return value.toLocaleString("es-ES");
}

function plural(value: number, one: string, many: string): string {
  return `${n(value)} ${value === 1 ? one : many}`;
}

/** Texto de la línea `⎿` bajo una herramienta. */
export function resultLine(name: string, result: ToolResultBlock | undefined, stats: DiffStats | null, running = false): string {
  if (running) return "En curso…";
  if (!result) return "Sin resultado todavía";
  if (result.isError) return `Error: ${firstLine(result.text) || "sin detalle"}`;
  if (stats && name === "Write") return `Escrito: ${plural(stats.added, "línea", "líneas")}`;
  if (stats) return `Actualizado: +${n(stats.added)} −${n(stats.removed)}`;
  const count = result.text.trim() ? lines(result.text).length : 0;
  if (name === "Read") return `Leídas ${plural(count, "línea", "líneas")}`;
  if (name === "Grep" || name === "Glob") return count === 0 ? "Sin coincidencias" : plural(count, "resultado", "resultados");
  if (count === 0) return "Sin salida";
  const head = firstLine(result.text);
  return count > 1 ? `${head}  … +${plural(count - 1, "línea", "líneas")}` : head;
}

/** Línea que continúa el bloque anterior tras una línea en blanco: lista, cita, tabla o sangría. */
const CONTINUES = /^(\s*([-*+]|\d+[.)])\s|\s{2,}\S|\s*>|\s*\|)/;

const FENCE = /^\s*(```|~~~)/;

/**
 * Construcciones que enlazan bloques separados por una línea en blanco (HTML en
 * bruto de bloque, definiciones de enlace, notas al pie, fórmulas `$$`): con
 * ellas, analizar cada trozo por separado no daría el mismo árbol que el texto
 * entero, así que la parte estable se analiza de una vez.
 */
const CROSS_BLOCK = /^ {0,3}(<[A-Za-z/!]|\[[^\]\n]+\]:\s|\$\$)|\[\^/m;

/**
 * Posiciones de corte del texto en streaming: tras cada párrafo cerrado fuera de
 * un bloque de código, y solo si la línea siguiente ya ha llegado y no continúa
 * una lista, una cita, una tabla o un bloque sangrado (F12): cortar ahí pintaría
 * dos árboles Markdown distintos. Una sola pasada: antes, cada línea en blanco
 * volvía a recorrer el resto del texto (cuadrático).
 */
function cutPoints(text: string): number[] {
  const all = text.split("\n");
  // Índice de la siguiente línea no vacía desde cada posición, de atrás adelante.
  const nextFilled = new Array<number>(all.length + 1);
  nextFilled[all.length] = -1;
  for (let i = all.length - 1; i >= 0; i -= 1) nextFilled[i] = all[i].trim() !== "" ? i : nextFilled[i + 1];
  const cuts: number[] = [];
  let fenceOpen = false;
  let pos = 0;
  for (let i = 0; i < all.length; i += 1) {
    const line = all[i];
    const end = pos + line.length + 1;
    if (FENCE.test(line)) fenceOpen = !fenceOpen;
    else if (!fenceOpen && line.trim() === "" && end <= text.length) {
      const next = nextFilled[i + 1];
      if (next !== -1 && !CONTINUES.test(all[next])) cuts.push(end);
    }
    pos = end;
  }
  return cuts;
}

/** Corte del texto en streaming por el último párrafo cerrado (ver `cutPoints`): parte estable y cola. */
export function splitStable(text: string): { stable: string; tail: string } {
  const cuts = cutPoints(text);
  const cut = cuts.length > 0 ? cuts[cuts.length - 1] : 0;
  return { stable: text.slice(0, cut), tail: text.slice(cut) };
}

/**
 * Como `splitStable`, pero con la parte estable troceada por párrafos cerrados.
 * Cada trozo no cambia entre deltas y su Markdown memoizado no se vuelve a
 * analizar: al cerrar un párrafo solo se analiza el nuevo, no toda la parte
 * estable. Con construcciones que cruzan bloques (`CROSS_BLOCK`), la parte
 * estable va en un solo trozo, como antes.
 */
export function splitBlocks(text: string): { blocks: string[]; tail: string } {
  const cuts = cutPoints(text);
  const cut = cuts.length > 0 ? cuts[cuts.length - 1] : 0;
  const tail = text.slice(cut);
  if (cut === 0) return { blocks: [], tail };
  const stable = text.slice(0, cut);
  if (CROSS_BLOCK.test(stable)) return { blocks: [stable], tail };
  const blocks: string[] = [];
  let from = 0;
  for (const at of cuts) {
    blocks.push(text.slice(from, at));
    from = at;
  }
  return { blocks, tail };
}

/** Nombre corto de una herramienta MCP: `mcp__claude-in-chrome__navigate` → `chrome·navigate`. */
export function toolLabel(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!m) return name;
  const server = m[1].replace(/^plugin_[^_]+_/, "").replace(/^claude-in-/, "");
  return `${server}·${m[2]}`;
}
