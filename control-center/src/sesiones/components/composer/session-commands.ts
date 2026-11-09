// Comandos propios de ULTRON Sessions que no llegan a la CLI: `/exportar`,
// `/segunda-opinion`, `/perfil` y `/motor-modelo`. Cada uno ofrece sus argumentos
// en un menú en línea del composer (`argChoices`): escribir el comando sin
// argumento abre el menú en vez de dejar una nota de error. Puro: el efecto lo
// aplica `useChatSubmit`.

import type { CommandDef, EngineId, EngineModel } from "../../types";

export interface ArgChoice {
  value: string;
  label: string;
  description?: string;
}

const SESSIONS = { source: "builtin", origin: "ULTRON Sessions", kind: "local", needsArgs: true, immediate: true } as const;

export const AUTO_REVIEW_COMMAND: CommandDef = {
  ...SESSIONS,
  name: "segunda-opinion",
  description: "Activa o desactiva la revisión automática de Codex al terminar turnos con muchas ediciones",
  argHint: "on|off",
};

export const PROFILE_COMMAND: CommandDef = {
  ...SESSIONS,
  name: "perfil",
  description: "Abre una sesión nueva aquí con un perfil de lanzamiento",
  argHint: "<perfil>",
};

export const ENGINE_MODEL_COMMAND: CommandDef = {
  ...SESSIONS,
  name: "motor-modelo",
  description: "Modelo con el que se lanzan Codex, Gemini u OpenCode",
  argHint: "codex|gemini|opencode <modelo>",
};

export const SESSION_ONLY_COMMANDS: readonly CommandDef[] = [AUTO_REVIEW_COMMAND, PROFILE_COMMAND, ENGINE_MODEL_COMMAND];

export const AUTO_REVIEW_USAGE = "Uso: /segunda-opinion on | /segunda-opinion off";
export const PROFILE_USAGE = "Uso: /perfil <nombre del perfil>";
export const ENGINE_MODEL_USAGE =
  "Uso: /motor-modelo codex <modelo> | /motor-modelo gemini <modelo> | /motor-modelo opencode <proveedor/modelo> (o «predeterminado»)";

const ON = new Set(["on", "si", "sí", "activar", "activa", "1", "true"]);
const OFF = new Set(["off", "no", "desactivar", "desactiva", "0", "false"]);

/** `true`/`false` para on/off y sinónimos; null si no se entiende. */
export function parseOnOff(args: string): boolean | null {
  const a = args.trim().toLocaleLowerCase("es");
  if (ON.has(a)) return true;
  if (OFF.has(a)) return false;
  return null;
}

export const DEFAULT_MODEL_WORDS = new Set(["predeterminado", "default", "por-defecto"]);

/** `codex <modelo>` → motor y modelo (`""` = predeterminado de la CLI); null si no encaja. */
export function parseEngineModel(args: string): { engine: EngineId; model: string } | null {
  const m = /^(codex|gemini|opencode)(?:\s+(\S+))?\s*$/i.exec(args.trim());
  if (!m || !m[2]) return null;
  const model = m[2];
  return { engine: m[1].toLowerCase() as EngineId, model: DEFAULT_MODEL_WORDS.has(model.toLowerCase()) ? "" : model };
}

export interface ArgContext {
  autoReviewOn: boolean;
  profiles: readonly { id: string; name: string }[];
  engineModels: Readonly<Record<EngineId, readonly EngineModel[] | null>>;
}

/** Opciones del menú en línea de un comando; null si el comando no tiene menú de argumentos. */
export function argChoices(command: string, ctx: ArgContext): ArgChoice[] | null {
  if (command === "exportar") {
    return [
      { value: "md", label: "md", description: "Markdown" },
      { value: "html", label: "html", description: "HTML autocontenido" },
    ];
  }
  if (command === AUTO_REVIEW_COMMAND.name) {
    const now = ctx.autoReviewOn ? "activada" : "desactivada";
    return [
      { value: "on", label: "on", description: `Activar (ahora: ${now})` },
      { value: "off", label: "off", description: `Desactivar (ahora: ${now})` },
    ];
  }
  if (command === PROFILE_COMMAND.name) {
    return ctx.profiles.map((p) => ({ value: p.name, label: p.name, description: "Sesión nueva aquí con este perfil" }));
  }
  if (command === ENGINE_MODEL_COMMAND.name) {
    return (["codex", "gemini", "opencode"] as const).flatMap((engine) => [
      { value: `${engine} predeterminado`, label: `${engine} predeterminado`, description: "El que tenga configurado la CLI" },
      ...(ctx.engineModels[engine] ?? []).map((m) => ({ value: `${engine} ${m.id}`, label: `${engine} ${m.id}`, description: m.label })),
    ]);
  }
  return null;
}

/** Filtra las opciones por lo escrito tras el comando (prefijo y, después, contenido). */
export function filterChoices(choices: readonly ArgChoice[], query: string): ArgChoice[] {
  const q = query.trim().toLocaleLowerCase("es");
  if (!q) return [...choices];
  const lower = (c: ArgChoice) => c.value.toLocaleLowerCase("es");
  const starts = choices.filter((c) => lower(c).startsWith(q));
  const contains = choices.filter((c) => !starts.includes(c) && lower(c).includes(q));
  return [...starts, ...contains];
}

export interface ArgTrigger {
  kind: "arg";
  command: string;
  query: string;
  start: number;
  end: number;
}

/**
 * Menú de argumentos: `/comando ` con el cursor tras el argumento (o sin él) y
 * nada más detrás. Solo para los comandos de `commands` (los que tienen menú).
 */
export function findArgTrigger(text: string, caret: number, commands: ReadonlySet<string>): ArgTrigger | null {
  if (text.slice(caret).trim()) return null;
  const m = /^\/([\w:.-]+)[ \t]+([^\n]*)$/.exec(text.slice(0, caret));
  if (!m || !commands.has(m[1])) return null;
  return { kind: "arg", command: m[1], query: m[2], start: caret - m[2].length, end: caret };
}

/** El comando escrito tal cual, sin argumento, es uno de los que abren menú. */
export function bareArgCommand(text: string, commands: ReadonlySet<string>): string | null {
  const m = /^\/([\w:.-]+)\s*$/.exec(text.trim());
  return m && commands.has(m[1]) ? m[1] : null;
}

export const ARG_MENU_COMMANDS: ReadonlySet<string> = new Set(["exportar", ...SESSION_ONLY_COMMANDS.map((c) => c.name)]);
