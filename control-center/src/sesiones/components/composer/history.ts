// Historial de prompts del composer (E5): navegación con ↑/↓ que conserva el
// borrador y búsqueda tipo Ctrl+R. Puro, para poder probarlo.

export const HISTORY_MAX = 500;

/** `index` -1 = el borrador; 0 = el prompt más reciente. */
export interface HistoryNav {
  index: number;
  draft: string;
}

export const initialNav: HistoryNav = { index: -1, draft: "" };

export function caretOnFirstLine(text: string, caret: number): boolean {
  return !text.slice(0, caret).includes("\n");
}

export function caretOnLastLine(text: string, caret: number): boolean {
  return !text.slice(caret).includes("\n");
}

/**
 * Un paso por el historial. Al salir del borrador lo guarda; al volver a él
 * lo restaura. Devuelve `null` si no hay a dónde ir (la tecla sigue al textarea).
 */
export function stepHistory(
  entries: readonly string[],
  nav: HistoryNav,
  dir: "older" | "newer",
  current: string,
): { nav: HistoryNav; text: string } | null {
  if (dir === "older") {
    const index = nav.index + 1;
    if (index >= entries.length) return null;
    const draft = nav.index === -1 ? current : nav.draft;
    return { nav: { index, draft }, text: entries[index] };
  }
  if (nav.index === -1) return null;
  const index = nav.index - 1;
  return { nav: { index, draft: nav.draft }, text: index === -1 ? nav.draft : entries[index] };
}

/** Añade un prompt enviado al principio, sin duplicar el último y con tope. */
export function pushHistory(entries: readonly string[], prompt: string, max = HISTORY_MAX): string[] {
  const p = prompt.trim();
  if (!p || entries[0] === p) return [...entries];
  return [p, ...entries].slice(0, max);
}

/** Une lo enviado en esta ventana (primero) con lo sembrado de los transcripts, sin duplicados consecutivos. */
export function mergeHistory(local: readonly string[], seeded: readonly string[], max = HISTORY_MAX): string[] {
  const out: string[] = [];
  for (const p of [...local, ...seeded]) {
    const t = p.trim();
    if (t && out[out.length - 1] !== t) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** Búsqueda incremental: contiene la consulta (sin distinguir mayúsculas), sin repetidos, más recientes primero. */
export function searchHistory(entries: readonly string[], query: string, limit = 40): string[] {
  const q = query.trim().toLocaleLowerCase("es");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of entries) {
    if (seen.has(e) || (q && !e.toLocaleLowerCase("es").includes(q))) continue;
    seen.add(e);
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}
