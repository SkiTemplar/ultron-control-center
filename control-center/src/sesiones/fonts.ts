// Fuente del chat de ULTRON Sessions, independiente del tema. Se aplica por
// CSSOM en <html> (ver applyTheme: un <style> en tiempo de ejecución lo bloquea
// la CSP de Tauri). Las familias empaquetadas se importan en main.tsx; las del
// sistema caen a la siguiente de la pila si no están instaladas.

export type FontId = "geist-mono" | "jetbrains-mono" | "fira-code" | "cascadia" | "geist";

export interface FontOption {
  id: FontId;
  label: string;
  description: string;
  /** Pila monoespaciada (`--f-mono`): chat, código y metadatos. */
  mono: string;
  /** El chat usa la fuente proporcional (`--f-body`); el código sigue en `mono`. */
  isProportional: boolean;
}

const MONO_FALLBACK = '"Cascadia Code", Consolas, monospace';
const GEIST_MONO = `"Geist Mono Variable", ${MONO_FALLBACK}`;

export const FONTS: readonly FontOption[] = [
  { id: "geist-mono", label: "Geist Mono", description: "Monoespaciada geométrica (por defecto)", mono: GEIST_MONO, isProportional: false },
  { id: "jetbrains-mono", label: "JetBrains Mono", description: "Monoespaciada alta, con ligaduras", mono: `"JetBrains Mono Variable", ${MONO_FALLBACK}`, isProportional: false },
  { id: "fira-code", label: "Fira Code", description: "Monoespaciada redondeada, con ligaduras", mono: `"Fira Code Variable", ${MONO_FALLBACK}`, isProportional: false },
  { id: "cascadia", label: "Cascadia Code", description: "La de Windows Terminal (fuente del sistema)", mono: `"Cascadia Code", "Cascadia Mono", Consolas, monospace`, isProportional: false },
  { id: "geist", label: "Geist", description: "Chat en proporcional; el código sigue en Geist Mono", mono: GEIST_MONO, isProportional: true },
];

export const DEFAULT_FONT: FontId = "geist-mono";
const STORAGE_KEY = "ultron.sesiones.font";

export function isFontId(value: unknown): value is FontId {
  return typeof value === "string" && FONTS.some((f) => f.id === value);
}

export function getFont(id: FontId): FontOption {
  return FONTS.find((f) => f.id === id) ?? FONTS[0];
}

export function loadFontId(): FontId {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isFontId(raw) ? raw : DEFAULT_FONT;
  } catch {
    return DEFAULT_FONT;
  }
}

export function saveFontId(id: FontId): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Almacenamiento no disponible (modo privado o cuota): la fuente vive solo en memoria.
  }
}

/** Variables CSS de una fuente (`--nombre` → valor). */
export function fontVars(f: FontOption): Record<string, string> {
  return {
    "--f-mono": f.mono,
    "--f-chat": f.isProportional ? "var(--f-body)" : "var(--f-mono)",
  };
}

export function applyFont(id: FontId): void {
  const root = document.documentElement;
  root.setAttribute("data-font", id);
  for (const [k, v] of Object.entries(fontVars(getFont(id)))) root.style.setProperty(k, v);
}
