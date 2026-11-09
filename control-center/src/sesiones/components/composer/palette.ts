// Paleta de comandos `/` (E6): catálogo de `sesiones_commands`, filtrado y
// sección «Recomendados» según el estado de la sesión. Puro.

import type { CommandDef } from "../../types";

export interface RecoContext {
  /** Porcentaje de contexto usado; null si el puente aún no lo ha dado. */
  contextPct: number | null;
  gitDirty: boolean;
  testsTouched: boolean;
}

export interface Recommendation {
  name: string;
  reason: string;
}

export const CONTEXT_HIGH = 70;
const COMMIT_CANDIDATES = ["commit", "commit-push-pr", "git-commit"];
const TEST_PATH = /(^|[\\/])(tests?|__tests__|e2e|spec)[\\/]|\.(test|spec)\.\w+$/i;

export function touchesTests(paths: readonly string[]): boolean {
  return paths.some((p) => TEST_PATH.test(p));
}

/** Recomendaciones deterministas; solo comandos que existen en el catálogo. */
export function recommendCommands(ctx: RecoContext, available: readonly CommandDef[]): Recommendation[] {
  const has = (name: string) => available.some((c) => c.name === name);
  const out: Recommendation[] = [];
  const add = (name: string | undefined, reason: string) => {
    if (name && has(name) && !out.some((r) => r.name === name)) out.push({ name, reason });
  };
  if (ctx.contextPct !== null && ctx.contextPct > CONTEXT_HIGH) {
    const pct = Math.round(ctx.contextPct);
    add("compact", `Contexto al ${pct} %: compacta antes de seguir`);
    add("relevo", `Contexto al ${pct} %: o pasa el relevo a una sesión limpia`);
  }
  if (ctx.gitDirty) add(COMMIT_CANDIDATES.find(has), "Hay cambios sin commit en el repositorio");
  if (ctx.testsTouched) add("probar", "Has tocado tests: ejecútalos");
  return out;
}

export interface PaletteItem {
  key: string;
  name: string;
  description: string;
  argHint?: string;
  source: CommandDef["source"] | "recomendado";
  origin?: string;
  kind: CommandDef["kind"];
}

export interface PaletteSection {
  title: string;
  items: PaletteItem[];
}

const SOURCE_RANK: Record<CommandDef["source"], number> = { project: 0, mod: 1, user: 2, skill: 3, plugin: 3, mcp: 3, builtin: 4 };

function score(c: CommandDef, q: string): number {
  if (!q || c.name.startsWith(q)) return 0;
  if (c.name.includes(q)) return 1;
  if (c.description.toLocaleLowerCase("es").includes(q)) return 2;
  return -1;
}

function toItem(c: CommandDef): PaletteItem {
  return { key: `${c.source}:${c.origin ?? ""}:${c.name}`, name: c.name, description: c.description, argHint: c.argHint, source: c.source, origin: c.origin, kind: c.kind };
}

/** Secciones de la paleta para la consulta (con o sin barra). Recomendados arriba. */
export function buildPalette(commands: readonly CommandDef[], recos: readonly Recommendation[], query: string, limit = 400): PaletteSection[] {
  const q = query.replace(/^\//, "").toLocaleLowerCase("es");
  const recoItems: PaletteItem[] = [];
  for (const r of recos) {
    const c = commands.find((x) => x.name === r.name);
    if (c && score(c, q) >= 0) recoItems.push({ ...toItem(c), key: `r:${r.name}`, description: r.reason, source: "recomendado" });
  }
  // Un recomendado sale una sola vez: arriba, con el motivo.
  const recommended = new Set(recoItems.map((r) => r.name));
  const rest = commands
    .map((c) => ({ c, s: score(c, q) }))
    .filter(({ c, s }) => s >= 0 && !recommended.has(c.name))
    .sort((a, b) => a.s - b.s || SOURCE_RANK[a.c.source] - SOURCE_RANK[b.c.source] || a.c.name.localeCompare(b.c.name))
    .slice(0, limit)
    .map(({ c }) => toItem(c));
  const sections: PaletteSection[] = [];
  if (recoItems.length) sections.push({ title: "Recomendados", items: recoItems });
  if (rest.length) sections.push({ title: "Comandos", items: rest });
  return sections;
}

export const SOURCE_LABEL: Record<PaletteItem["source"], string> = {
  builtin: "Claude Code",
  mod: "mod",
  skill: "skill",
  user: "usuario",
  project: "proyecto",
  plugin: "plugin",
  mcp: "MCP",
  recomendado: "recomendado",
};

/** Etiqueta del tipo de comando en la paleta. */
export const KIND_LABEL: Record<CommandDef["kind"], string> = {
  prompt: "prompt",
  local: "texto",
  menu: "menú",
  panel: "menú",
  terminal: "menú",
  exit: "cierra",
  unsupported: "no aplica",
};
