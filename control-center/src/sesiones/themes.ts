// Temas de la ventana «ULTRON Sessions». Fuente única de los tokens: se generan como
// reglas `:root[data-theme="…"]` y se aplican con `data-theme` en <html>.
// El test de temas comprueba el contraste AA de cada combinación de texto.

export type ThemeId =
  | "obsidiana" | "vacio" | "fosforo" | "acero" | "grafito" | "medianoche" | "ambar"
  | "bosque" | "vino" | "pizarra" | "carbon" | "neon";

export interface ThemeTokens {
  bg: string;
  panel: string;
  raised: string;
  line: string;
  lineSoft: string;
  fg: string;
  muted: string;
  faint: string;
  accent: string;
  accentFg: string;
  info: string;
  ok: string;
  warn: string;
  err: string;
  codex: string;
  gemini: string;
  add: string;
  del: string;
}

export interface Theme {
  id: ThemeId;
  label: string;
  description: string;
  /** Obsoleto desde v0.2: la fuente del chat no depende del tema (ver fonts.ts). */
  chatMono: boolean;
  tokens: ThemeTokens;
}

export const THEMES: readonly Theme[] = [
  {
    id: "obsidiana",
    label: "Obsidiana",
    description: "Negro puro con acento cobre",
    chatMono: false,
    tokens: {
      bg: "#000000", panel: "#0a0a0a", raised: "#111111", line: "#1c1c1c", lineSoft: "#151515",
      fg: "#e8e8e8", muted: "#a3a3a3", faint: "#7c7c7c",
      accent: "#d08a5c", accentFg: "#140b05", info: "#93a7cc",
      ok: "#7fbf95", warn: "#d9a95c", err: "#e2716e", codex: "#a3adff", gemini: "#e79bd2",
      add: "#11291b", del: "#33161a",
    },
  },
  {
    id: "vacio",
    label: "Vacío",
    description: "Negro puro con cian frío",
    chatMono: false,
    tokens: {
      bg: "#000000", panel: "#05080a", raised: "#0b1114", line: "#16222a", lineSoft: "#101a20",
      fg: "#e2eef3", muted: "#97aab4", faint: "#72858f",
      accent: "#6fd3e8", accentFg: "#03151a", info: "#9fb8e6",
      ok: "#79cfa0", warn: "#e0b46a", err: "#ef7b7b", codex: "#b4a8ff", gemini: "#f0a0d8",
      add: "#0d2a22", del: "#331820",
    },
  },
  {
    id: "fosforo",
    label: "Fósforo",
    description: "Negro puro, verde fósforo y chat en monoespaciada",
    chatMono: true,
    tokens: {
      bg: "#000000", panel: "#020803", raised: "#061108", line: "#123019", lineSoft: "#0b1f10",
      fg: "#c9f7d3", muted: "#86c795", faint: "#62a072",
      accent: "#7cf29a", accentFg: "#021006", info: "#8fd3e0",
      ok: "#5fd0b0", warn: "#e6d36c", err: "#ff7a6e", codex: "#a9c4ff", gemini: "#f2a7dc",
      add: "#0c2e15", del: "#331512",
    },
  },
  {
    id: "acero",
    label: "Acero",
    description: "Gris azulado de la maqueta",
    chatMono: false,
    tokens: {
      bg: "#12161a", panel: "#171c21", raised: "#1e252b", line: "#2a333a", lineSoft: "#222a30",
      fg: "#dfe5e9", muted: "#9aa6ae", faint: "#7f8b93",
      accent: "#c8875e", accentFg: "#1b1410", info: "#8fa3c8",
      ok: "#7fae8f", warn: "#e6c35a", err: "#df7270", codex: "#9aa7ff", gemini: "#e8a2d4",
      add: "#1f3329", del: "#3d2326",
    },
  },
  {
    id: "grafito",
    label: "Grafito",
    description: "Gris neutro con acento azul",
    chatMono: false,
    tokens: {
      bg: "#18181b", panel: "#1d1d21", raised: "#24242a", line: "#34343c", lineSoft: "#2a2a31",
      fg: "#e4e4e7", muted: "#a1a1aa", faint: "#8b8b94",
      accent: "#7aa2f7", accentFg: "#0b1220", info: "#9ab8e0",
      ok: "#86c99a", warn: "#e0b36a", err: "#ef8080", codex: "#b0a8ff", gemini: "#f0a6d6",
      add: "#1d3326", del: "#3d2228",
    },
  },
  {
    id: "medianoche",
    label: "Medianoche",
    description: "Azul marino con acento violeta",
    chatMono: false,
    tokens: {
      bg: "#0b1020", panel: "#10162a", raised: "#161d35", line: "#252e4d", lineSoft: "#1c2440",
      fg: "#e3e8f7", muted: "#a0aac8", faint: "#8590b3",
      accent: "#a78bfa", accentFg: "#140b2e", info: "#8ec5ff",
      ok: "#7fd1a8", warn: "#e8c070", err: "#f28b8b", codex: "#b8b0ff", gemini: "#f4a8d8",
      add: "#123326", del: "#3a1c2a",
    },
  },
  {
    id: "ambar",
    label: "Ámbar",
    description: "Fondo cálido con ámbar de terminal clásica",
    chatMono: false,
    tokens: {
      bg: "#0d0a06", panel: "#14100a", raised: "#1c160e", line: "#33281a", lineSoft: "#261e13",
      fg: "#f3e2c4", muted: "#c9ad80", faint: "#a88f66",
      accent: "#f5a524", accentFg: "#1a0f00", info: "#9cc3d5",
      ok: "#a6cf86", warn: "#ead85f", err: "#f08a6c", codex: "#b3b0ff", gemini: "#f2a6cf",
      add: "#1f2a12", del: "#3a1a12",
    },
  },
  {
    id: "bosque",
    label: "Bosque",
    description: "Verde musgo con acento lima",
    chatMono: false,
    tokens: {
      bg: "#0c120e", panel: "#111913", raised: "#18221a", line: "#28382b", lineSoft: "#1e2b21",
      fg: "#e1ebdf", muted: "#a3b5a2", faint: "#86998a",
      accent: "#a8d672", accentFg: "#0f1a05", info: "#8fc4d6",
      ok: "#7fd19a", warn: "#e3c46a", err: "#ef8473", codex: "#b3b2ff", gemini: "#f0a5d3",
      add: "#173322", del: "#3a1d1c",
    },
  },
  {
    id: "vino",
    label: "Vino",
    description: "Burdeos oscuro con acento rosa",
    chatMono: false,
    tokens: {
      bg: "#140a0f", panel: "#1b0f15", raised: "#24151d", line: "#3d2531", lineSoft: "#2e1b25",
      fg: "#f1e2e8", muted: "#c3a4b1", faint: "#a68895",
      accent: "#f08fb0", accentFg: "#2a0715", info: "#9dbfe8",
      ok: "#8fd0a2", warn: "#e8c070", err: "#ff8a7a", codex: "#b9b2ff", gemini: "#e3a8f2",
      add: "#16301f", del: "#45161f",
    },
  },
  {
    id: "pizarra",
    label: "Pizarra",
    description: "Azul pizarra con acento turquesa",
    chatMono: false,
    tokens: {
      bg: "#0f1419", panel: "#141b22", raised: "#1b242d", line: "#2b3845", lineSoft: "#222d38",
      fg: "#dde6ee", muted: "#9aabb9", faint: "#8193a1",
      accent: "#4fd1b5", accentFg: "#04201a", info: "#8fb8ee",
      ok: "#84d39b", warn: "#e6c066", err: "#f08585", codex: "#b0acff", gemini: "#f0a3d6",
      add: "#143328", del: "#3c2028",
    },
  },
  {
    id: "carbon",
    label: "Carbón",
    description: "Gris carbón neutro con acento coral",
    chatMono: false,
    tokens: {
      bg: "#101010", panel: "#161616", raised: "#1e1e1e", line: "#303030", lineSoft: "#262626",
      fg: "#e9e6e3", muted: "#aba6a1", faint: "#8f8a85",
      accent: "#ff8f70", accentFg: "#2a0d04", info: "#93b4e0",
      ok: "#85c99a", warn: "#e2bd68", err: "#f27f8c", codex: "#b1abff", gemini: "#eea4d6",
      add: "#18301f", del: "#3d1c22",
    },
  },
  {
    id: "neon",
    label: "Neón",
    description: "Violeta casi negro con magenta y cian",
    chatMono: false,
    tokens: {
      bg: "#0a0612", panel: "#100a1b", raised: "#181027", line: "#2c1f47", lineSoft: "#201636",
      fg: "#ece6fa", muted: "#b0a5cc", faint: "#9287b0",
      accent: "#ff7ad9", accentFg: "#2a0522", info: "#7fd6f2",
      ok: "#7fe0a8", warn: "#f0d06a", err: "#ff8585", codex: "#b5adff", gemini: "#f5b8a8",
      add: "#12301f", del: "#401a2c",
    },
  },
];

export const DEFAULT_THEME: ThemeId = "acero";
const STORAGE_KEY = "ultron.sesiones.theme";

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && THEMES.some((t) => t.id === value);
}

export function getTheme(id: ThemeId): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

export function loadThemeId(): ThemeId {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isThemeId(raw) ? raw : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function saveThemeId(id: ThemeId): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Almacenamiento no disponible (modo privado o cuota): el tema vive solo en memoria.
  }
}

function kebab(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** Variables CSS de un tema (`--nombre` → valor). */
export function themeVars(t: Theme): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(t.tokens)) vars[`--${kebab(k)}`] = v;
  vars["--accent-soft"] = `${t.tokens.accent}24`;
  vars["--info-soft"] = `${t.tokens.info}1f`;
  vars["--codex-soft"] = `${t.tokens.codex}1f`;
  vars["--gemini-soft"] = `${t.tokens.gemini}1f`;
  // OpenCode no tiene color propio en los temas: toma el de información.
  vars["--opencode"] = t.tokens.info;
  vars["--opencode-soft"] = `${t.tokens.info}1f`;
  vars["--warn-soft"] = `${t.tokens.warn}14`;
  vars["--err-soft"] = `${t.tokens.err}14`;
  return vars;
}

/**
 * Aplica el tema escribiendo las variables en el estilo de <html> vía CSSOM.
 * No se inyecta un <style>: Tauri añade un nonce a `style-src` cuando el HTML
 * lleva estilos inline y, con nonce, la CSP ignora 'unsafe-inline' y bloquea
 * cualquier <style> creado en tiempo de ejecución. El CSSOM no pasa por la CSP.
 */
export function applyTheme(id: ThemeId): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", id);
  root.style.colorScheme = "dark";
  for (const [k, v] of Object.entries(themeVars(getTheme(id)))) root.style.setProperty(k, v);
}

// ---------------------------------------------------------------------------
// Contraste WCAG 2.x
// ---------------------------------------------------------------------------

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
