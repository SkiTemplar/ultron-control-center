// Disparadores del composer (`/` y `@`) y catálogo de reserva de comandos para
// cuando `sesiones_commands` no responde. Cambio de diseño del 2026-10-08: todos
// los slash commands se usan desde el chat; los que abren un menú de la TUI
// (`menu`) se ven y se manejan en un bloque de menú dentro del chat.

import type { CommandDef, CommandKind, ExportFormat } from "../../types";
import { SESSION_ONLY_COMMANDS } from "./session-commands";

type Row = [name: string, kind: CommandKind, description: string, extra?: Partial<CommandDef>];

const BUILTINS: Row[] = [
  ["compact", "prompt", "Compacta el contexto de la conversación", { argHint: "[instrucciones]" }],
  ["init", "prompt", "Crea el CLAUDE.md del proyecto"],
  ["review", "prompt", "Revisa los cambios pendientes"],
  ["security-review", "prompt", "Revisión de seguridad de los cambios"],
  ["plan", "prompt", "Entra en modo plan", { argHint: "[descripción]" }],
  ["clear", "local", "Empieza una conversación limpia", { aliases: ["new", "reset"] }],
  ["cost", "local", "Coste y duración de la sesión"],
  ["status", "local", "Estado de la sesión: modelo, cuenta y conexión"],
  ["context", "local", "Uso del contexto por categoría"],
  ["help", "local", "Ayuda de Claude Code"],
  ["reload-plugins", "local", "Recarga los plugins"],
  ["config", "menu", "Ajustes de Claude Code", { aliases: ["settings"] }],
  ["model", "menu", "Cambia el modelo de la sesión", { argHint: "[modelo]" }],
  ["effort", "menu", "Esfuerzo de razonamiento", { argHint: "[nivel]" }],
  ["fast", "menu", "Modo rápido", { argHint: "[on|off]" }],
  ["permissions", "menu", "Modo y reglas de permisos", { aliases: ["allowed-tools"] }],
  ["mcp", "menu", "Servidores MCP", { argHint: "[acción servidor]" }],
  ["plugin", "menu", "Plugins instalados", { argHint: "[acción plugin]" }],
  ["doctor", "menu", "Diagnóstico de la instalación"],
  ["agents", "menu", "Subagentes configurados"],
  ["hooks", "menu", "Hooks configurados"],
  ["memory", "menu", "Ficheros de memoria (CLAUDE.md)"],
  ["resume", "menu", "Retoma una conversación anterior", { aliases: ["continue"], argHint: "[id]" }],
  ["export", "menu", "Exporta la conversación", { argHint: "[fichero]" }],
  ["login", "menu", "Inicia sesión en Claude"],
  ["logout", "menu", "Cierra la sesión de Claude"],
  ["skills", "menu", "Skills disponibles"],
  ["tasks", "menu", "Tareas en segundo plano", { aliases: ["bashes"] }],
  ["rewind", "menu", "Vuelve a un punto anterior", { aliases: ["checkpoint", "undo"] }],
  ["add-dir", "menu", "Añade un directorio de trabajo", { argHint: "<ruta>" }],
  ["exit", "exit", "Cierra Claude Code y termina la sesión", { aliases: ["quit"] }],
  ["vim", "unsupported", "Modo vim de la caja de entrada", { note: "El modo vim cambiaría la caja de entrada oculta y rompería los envíos desde el chat." }],
  ["voice", "unsupported", "Dictado por voz", { note: "Voz: botón Voz o Ctrl+Espacio en el composer." }],
  ["background", "unsupported", "Pasa la sesión a segundo plano", { aliases: ["bg"], note: "Una sesión en segundo plano desconectaría esta ventana del proceso. Para la herramienta en curso: Ctrl+B o «Segundo plano» en la línea de estado." }],
];

/**
 * Descripción de `/mejorar` en Sessions: aquí no lo ejecuta el mod (que usa
 * Claude), sino la app con el AI Router (`sesiones_mejorar`, Groq primero), así
 * que se declara el proveedor también sobre el catálogo vivo.
 */
export const MEJORAR_DESCRIPTION = "Reescribe el borrador con contexto del proyecto (sale a Groq, sin secretos ni la cuenta en las rutas)";

/** Reserva: integrados de Claude Code y los comandos de los mods ULTRON más usados. */
export const FALLBACK_COMMANDS: readonly CommandDef[] = [
  ...BUILTINS.map(([name, kind, description, extra]): CommandDef => ({
    name, kind, description, source: "builtin", needsArgs: false, immediate: false, ...extra,
  })),
  { name: "mejorar", description: MEJORAR_DESCRIPTION, argHint: "<borrador>", source: "mod", origin: "ultron-mejorar", kind: "prompt", needsArgs: true, immediate: false },
  { name: "relevo", description: "Prepara el relevo para otra sesión", source: "mod", origin: "ultron-relevo", kind: "local", needsArgs: false, immediate: false },
  { name: "compilar", description: "Compila el proyecto con su receta", source: "mod", origin: "ultron-atajos", kind: "local", needsArgs: false, immediate: true },
  { name: "probar", description: "Ejecuta los tests del proyecto", source: "mod", origin: "ultron-atajos", kind: "local", needsArgs: false, immediate: true },
  { name: "arrancar", description: "Arranca la app del proyecto", source: "mod", origin: "ultron-atajos", kind: "local", needsArgs: false, immediate: true },
];

/** `/exportar`: comando propio de Sessions; no pisa el `/export` nativo de Claude Code. */
export const EXPORT_COMMAND: CommandDef = {
  name: "exportar",
  description: "Exporta la conversación completa a Markdown o HTML",
  argHint: "md|html",
  source: "builtin",
  origin: "ULTRON Sessions",
  kind: "local",
  needsArgs: true,
  immediate: true,
};

export const EXPORT_USAGE = "Uso: /exportar md | /exportar html";

/** Formato de los argumentos de `/exportar`; `null` si no es válido. */
export function parseExportFormat(args: string): ExportFormat | null {
  const a = args.trim().toLowerCase().replace(/^\./, "");
  if (a === "md" || a === "markdown") return "md";
  if (a === "html" || a === "htm") return "html";
  return null;
}

/**
 * Catálogo del composer más los comandos propios de Sessions (sin duplicar), con
 * la descripción de `/mejorar` que declara a dónde sale el borrador.
 */
export function withSessionCommands(commands: readonly CommandDef[]): readonly CommandDef[] {
  const missing = [EXPORT_COMMAND, ...SESSION_ONLY_COMMANDS].filter((own) => !commands.some((c) => c.name === own.name));
  const undeclared = commands.some((c) => c.name === "mejorar" && c.description !== MEJORAR_DESCRIPTION);
  if (missing.length === 0 && !undeclared) return commands;
  const declared = undeclared
    ? commands.map((c) => (c.name === "mejorar" ? { ...c, description: MEJORAR_DESCRIPTION } : c))
    : commands;
  return [...declared, ...missing];
}

export interface Trigger {
  kind: "slash" | "at";
  query: string;
  start: number;
  end: number;
}

/** Detecta un `/comando` al principio de línea o un `@fichero` justo antes del cursor. */
export function findTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const at = /(^|\s)@([^\s@]*)$/.exec(before);
  if (at) return { kind: "at", query: at[2], start: caret - at[2].length - 1, end: caret };
  const slash = /(^|\n)(\/[\w:.-]*)$/.exec(before);
  if (slash) return { kind: "slash", query: slash[2], start: caret - slash[2].length, end: caret };
  return null;
}

export function filterFiles(files: readonly string[], query: string): string[] {
  const q = query.toLowerCase();
  if (!q) return files.slice(0, 8);
  const starts = files.filter((f) => (f.split("/").pop() ?? f).toLowerCase().startsWith(q));
  const contains = files.filter((f) => !starts.includes(f) && f.toLowerCase().includes(q));
  return [...starts, ...contains].slice(0, 8);
}

/**
 * Sustituye el disparador por el valor elegido y devuelve texto y nueva posición del
 * cursor. Si detrás ya hay un espacio (texto que pasa a ser argumento), no añade otro.
 */
export function applyCompletion(text: string, t: Trigger, value: string): { text: string; caret: number } {
  const spaced = /^\s/.test(text.slice(t.end));
  const insert = t.kind === "at" ? `@${value}${spaced ? "" : " "}` : `${value}${spaced ? "" : " "}`;
  const next = text.slice(0, t.start) + insert + text.slice(t.end);
  return { text: next, caret: t.start + insert.length };
}
