// Comandos y menús de la TUI simulados (cambio de diseño del 2026-10-08): los
// comandos locales imprimen texto sin abrir turno; los de menú ponen la sesión
// en waiting{menu} con la pantalla del PTY, que el bloque del chat muestra y
// maneja con flechas, Enter y Esc por `terminalInput`. `/model <id>` simula el
// aviso de caché como diálogo con opciones (AC-1).

import type { ChatMessage, CommandOutcome, DialogOption, SessionId, WaitInfo } from "../types";
import type { SimDeps } from "./sim";

interface MenuDeps extends SimDeps {
  idle(id: SessionId): void;
  wait(id: SessionId, waiting: WaitInfo, screen?: "prompt" | "dialog" | "trust"): void;
  emitPty?(id: SessionId, text: string): void;
  startTurn?(id: SessionId, prompt: string): void;
}

interface MenuState {
  command: string;
  label: string;
  rows: string[];
  cursor: number;
  options?: DialogOption[];
  onPick: (row: number) => string;
}

const now = () => new Date().toISOString();

const LOCAL_OUTPUT: Record<string, string> = {
  cost: "Total cost:            $3.42\nTotal duration (API):  12m 4s\nTotal duration (wall): 42m 10s\nUsage:                 1.2M input, 84k output, 9.8M cache read",
  status: "Version: 2.1.293\nModel: claude-opus-5-5\nAccount: plan Max\nPermission mode: bypassPermissions",
  context: "Context usage: 168k / 1M tokens (17 %)\n  System prompt: 9k\n  Tools: 21k\n  Messages: 138k",
  help: "Escribe / para ver los comandos. Esc interrumpe; Ctrl+Enter envía a mitad de turno; Ctrl+Mayús+Enter interrumpe y envía; Ctrl+B pasa la herramienta en curso a segundo plano; Ctrl+Mayús+D delega en un subagente.",
  "reload-plugins": "Plugins recargados: 12.",
  relevo: "Relevo preparado: resumen y siguiente paso en la caja de entrada.",
  compilar: "Compilación correcta (4,2 s).",
  probar: "31 tests en verde.",
  arrancar: "App arrancada en http://localhost:1420.",
};

const MENU_ROWS: Record<string, string[]> = {
  config: ["Auto-compact        true", "Tema                dark", "Estilo de salida    default", "Verbose             false"],
  model: ["Opus 5.5", "Opus 5.5 · 1M", "Sonnet 5.5"],
  effort: ["low", "medium", "high", "xhigh", "max"],
  permissions: ["Allow  Bash(npm test:*)", "Ask    Bash(git push:*)", "Deny   Read(.env)"],
  mcp: ["context7      conectado", "github        conectado", "codegraph     conectado"],
  doctor: ["Instalación  OK", "Ripgrep      OK", "Plugins      12 cargados"],
  resume: ["Jurado A/B de la memoria", "Build rota de Explored", "Shadow mapping con PCF"],
};

function render(m: MenuState): string {
  const rows = m.rows.map((r, i) => `${i === m.cursor ? "\x1b[38;5;173m❯ " : "  "}${i + 1}. ${r}\x1b[0m`);
  return ["\x1b[2J\x1b[H", `\x1b[1m ${m.label}\x1b[0m`, "", ...rows, "", "\x1b[2m Enter para confirmar · Esc para cancelar\x1b[0m"].join("\r\n");
}

export function createMenus(deps: MenuDeps) {
  const open = new Map<SessionId, MenuState>();

  function commandMessage(id: SessionId, name: string, args: string, stdout: string, isError = false): void {
    const msg: ChatMessage = {
      uuid: deps.uid("c"), role: "user", kind: "command", timestamp: now(), agentId: null,
      blocks: [{ kind: "text", text: `/${name}${args ? ` ${args}` : ""}` }], command: { name, args, stdout, isError },
    };
    deps.addMessages(id, [msg]);
  }

  function show(id: SessionId, m: MenuState): void {
    open.set(id, m);
    deps.wait(id, { kind: "menu", label: m.label, since: now(), options: m.options }, "dialog");
    deps.emitPty?.(id, render(m));
  }

  function close(id: SessionId, result: string): void {
    const m = open.get(id);
    open.delete(id);
    if (m) commandMessage(id, m.command, "", result);
    deps.idle(id);
  }

  function openMenu(id: SessionId, command: string): void {
    const rows = MENU_ROWS[command] ?? [`Opciones de /${command}`, "Volver"];
    show(id, { command, label: `/${command}`, rows, cursor: 0, onPick: (row) => {
      if (command === "model") deps.patch(id, { model: ["claude-opus-5-5", "claude-opus-5-5[1m]", "claude-sonnet-5-5"][row] ?? null });
      return `${command === "config" ? "Ajuste cambiado" : "Elegido"}: ${rows[row].replace(/\s{2,}/g, " ")}`;
    } });
  }

  /** Diálogo genérico con opciones leídas de la pantalla (aviso de caché, diálogos de la TUI). */
  function openDialog(id: SessionId, label: string, options: DialogOption[], command = "dialogo", onPick?: (row: number) => string): void {
    show(id, { command, label, rows: options.map((o) => o.label), cursor: 0, options, onPick: onPick ?? ((row) => `Elegido: ${options[row]?.label ?? "?"}`) });
  }

  function cacheWarning(id: SessionId, model: string): void {
    const options = [{ index: 0, label: "Sí, cambiar de modelo", selected: true }, { index: 1, label: "No, mantener el actual", selected: false }];
    openDialog(id, "Cambiar de modelo invalida la caché del prompt", options, "model", (row) => {
      if (row !== 0) return "Cancelado: se mantiene el modelo.";
      deps.patch(id, { model });
      return `Modelo: ${model}`;
    });
  }

  function key(id: SessionId, data: string): boolean {
    const m = open.get(id);
    if (!m) return false;
    if (data === "\x1b") {
      close(id, "Cancelado.");
      return true;
    }
    if (data === "\r") {
      close(id, m.onPick(m.cursor));
      return true;
    }
    const step = data === "\x1b[A" ? -1 : data === "\x1b[B" ? 1 : 0;
    if (step) {
      const next = { ...m, cursor: (m.cursor + step + m.rows.length) % m.rows.length };
      show(id, { ...next, options: m.options?.map((o) => ({ ...o, selected: o.index === next.cursor })) });
    }
    return true;
  }

  function run(id: SessionId, command: string, args: string): CommandOutcome {
    if (command === "model" && args) {
      window.setTimeout(() => cacheWarning(id, args), 200);
      return { disposition: "written" };
    }
    if (LOCAL_OUTPUT[command] !== undefined) {
      window.setTimeout(() => commandMessage(id, command, args, LOCAL_OUTPUT[command]), 150);
      return { disposition: "written" };
    }
    if (MENU_ROWS[command] || ["agents", "hooks", "memory", "skills", "tasks", "plugin", "login", "logout", "export", "rewind", "add-dir", "fast"].includes(command)) {
      window.setTimeout(() => openMenu(id, command), 200);
      return { disposition: "written" };
    }
    deps.startTurn?.(id, `/${command} ${args}`.trim());
    return { disposition: "written" };
  }

  return {
    open: (id: SessionId, label: string, options: DialogOption[]) => openDialog(id, label, options),
    key,
    answer: (id: SessionId, index: number) => {
      const m = open.get(id);
      if (!m) throw new Error("No hay ningún diálogo abierto en la pantalla.");
      close(id, m.onPick(index));
    },
    isOpen: (id: SessionId) => open.has(id),
    screen: (id: SessionId) => {
      const m = open.get(id);
      return m ? render(m) : null;
    },
    commandMessage,
    commands: { run },
  };
}
