// Enrutado de un `/comando` escrito en el composer (§2.2 y cambio de diseño del
// 2026-10-08). Puro: decide qué hace el chat, sin tocar la API.
// - `prompt` y `local` → `sesiones_run_command` (la salida llega como tarjeta).
// - `menu` (y `panel`/`terminal` del cable antiguo) sin argumentos → se ejecuta y
//   el chat muestra el bloque de menú; con argumentos, la forma no interactiva.
// - `exit` → confirmación antes de cerrar la CLI.
// - `unsupported` → nota con el porqué, sin tocar el PTY.
// - Desconocido con lista viva → error con sugerencias; sin lista viva → se envía
//   tal cual con aviso (catálogo parcial: plugins del marketplace).

import type { CommandDef, EngineId, ExportFormat } from "../../types";
import { EXPORT_COMMAND, parseExportFormat } from "./commands";
import { AUTO_REVIEW_COMMAND, ENGINE_MODEL_COMMAND, PROFILE_COMMAND, parseEngineModel, parseOnOff } from "./session-commands";

export type SlashRoute =
  | { type: "run"; command: string; args: string; warn?: string }
  | { type: "export"; command: string; format: ExportFormat | null }
  | { type: "autoReview"; command: string; on: boolean | null }
  | { type: "profile"; command: string; name: string }
  | { type: "engineModel"; command: string; choice: { engine: EngineId; model: string } | null }
  | { type: "inspector"; command: string; tab: "git" | "agentes" | "uso" }
  | { type: "engine"; command: string }
  | { type: "menu"; command: string; args: string }
  | { type: "exit"; command: string }
  | { type: "unsupported"; command: string; note: string }
  | { type: "unknown"; command: string; suggestions: string[] };

export const UNCATALOGED_WARNING = "Comando no catalogado: se envía a Claude Code tal cual.";

const MENU_KINDS = new Set<CommandDef["kind"]>(["menu", "panel", "terminal"]);

const INSPECTOR_TABS = { git: "git", agentes: "agentes", uso: "uso" } as const;

export function parseSlash(text: string): { command: string; args: string } | null {
  const m = /^\/([\w:.-]+)(?:[ \t]+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  return { command: m[1], args: (m[2] ?? "").trim() };
}

export function findCommand(name: string, catalog: readonly CommandDef[]): CommandDef | undefined {
  return catalog.find((c) => c.name === name) ?? catalog.find((c) => c.aliases?.includes(name));
}

export function suggest(name: string, catalog: readonly CommandDef[], max = 3): string[] {
  const q = name.toLowerCase();
  const starts = catalog.filter((c) => c.name.startsWith(q.slice(0, 2)));
  const contains = catalog.filter((c) => !starts.includes(c) && (c.name.includes(q) || q.includes(c.name)));
  return [...starts, ...contains].slice(0, max).map((c) => `/${c.name}`);
}

/** `null` si el texto no es un comando (prompt normal o `!bash`). */
export function routeSlash(text: string, catalog: readonly CommandDef[], live: boolean): SlashRoute | null {
  const parsed = parseSlash(text);
  if (!parsed) return null;
  const { command, args } = parsed;
  // Comandos propios de Sessions: no llegan a la CLI aunque el catálogo no los traiga.
  if (command === EXPORT_COMMAND.name) return { type: "export", command, format: parseExportFormat(args) };
  if (command === AUTO_REVIEW_COMMAND.name) return { type: "autoReview", command, on: parseOnOff(args) };
  if (command === PROFILE_COMMAND.name) return { type: "profile", command, name: args };
  if (command === ENGINE_MODEL_COMMAND.name) return { type: "engineModel", command, choice: parseEngineModel(args) };
  const def = findCommand(command, catalog);
  if (!def) {
    if (live) return { type: "unknown", command, suggestions: suggest(command, catalog) };
    return { type: "run", command, args, warn: UNCATALOGED_WARNING };
  }
  const name = def.name;
  if (def.kind === "unsupported") return { type: "unsupported", command: name, note: def.note ?? "Este comando no aplica dentro de ULTRON Sessions." };
  if (def.kind === "exit") return { type: "exit", command: name };
  // Paneles de los mods de ULTRON con equivalente en la ventana (§2.3): pestaña del inspector o motor.
  if (!args && def.panel && def.panel in INSPECTOR_TABS) return { type: "inspector", command: name, tab: INSPECTOR_TABS[def.panel as keyof typeof INSPECTOR_TABS] };
  if (!args && def.panel === "engines") return { type: "engine", command: name };
  if (MENU_KINDS.has(def.kind)) return args ? { type: "run", command: name, args } : { type: "menu", command: name, args };
  return { type: "run", command: name, args };
}
