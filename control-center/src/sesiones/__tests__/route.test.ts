import { describe, expect, it } from "vitest";
import { FALLBACK_COMMANDS } from "../components/composer/commands";
import { UNCATALOGED_WARNING, parseSlash, routeSlash } from "../components/composer/route";
import { DIALOG_BLOCK_REASON, WAITING_NOW_REASON, itemKind, submitAction } from "../components/composer/submit";
import type { CommandDef, SessionInfo } from "../types";

const live: CommandDef[] = [
  ...FALLBACK_COMMANDS,
  { name: "codex:rescue", description: "Codex", source: "plugin", kind: "prompt", needsArgs: false, immediate: false },
];

describe("enrutado de /comandos (§2.2, cambio de diseño del 2026-10-08)", () => {
  it("/cost es local y /compact es prompt: los dos van por run_command", () => {
    expect(routeSlash("/cost", live, true)).toEqual({ type: "run", command: "cost", args: "" });
    expect(routeSlash("/compact foco en tests", live, true)).toEqual({ type: "run", command: "compact", args: "foco en tests" });
  });

  it("/config, /model, /permissions, /mcp, /doctor y /resume sin argumentos abren el menú en el chat", () => {
    for (const c of ["config", "model", "permissions", "mcp", "doctor", "resume", "skills", "tasks"]) {
      expect(routeSlash(`/${c}`, live, true)).toEqual({ type: "menu", command: c, args: "" });
    }
  });

  it("con argumento, el comando de menú va en su forma no interactiva", () => {
    expect(routeSlash("/model claude-sonnet-5-5", live, true)).toEqual({ type: "run", command: "model", args: "claude-sonnet-5-5" });
  });

  it("los alias resuelven al comando: /settings → config, /quit → exit", () => {
    expect(routeSlash("/settings", live, true)).toMatchObject({ type: "menu", command: "config" });
    expect(routeSlash("/quit", live, true)).toEqual({ type: "exit", command: "exit" });
  });

  it("los panel y terminal del cable antiguo también son menú del chat", () => {
    const old: CommandDef[] = [{ name: "rewind", description: "", source: "builtin", kind: "terminal", needsArgs: false, immediate: false }, { name: "hooks", description: "", source: "builtin", kind: "panel", panel: "hooks", needsArgs: false, immediate: false }];
    expect(routeSlash("/rewind", old, true)).toMatchObject({ type: "menu" });
    expect(routeSlash("/hooks", old, true)).toMatchObject({ type: "menu" });
  });

  it("/git, /agentes y /uso de los mods abren su pestaña; /codex sin argumentos, el motor; con argumentos se ejecuta", () => {
    const mods: CommandDef[] = [
      { name: "git", description: "", source: "mod", kind: "panel", panel: "git", needsArgs: false, immediate: true },
      { name: "uso", description: "", source: "mod", kind: "panel", panel: "uso", needsArgs: false, immediate: true },
      { name: "codex", description: "", source: "mod", kind: "panel", panel: "engines", needsArgs: false, immediate: true },
    ];
    expect(routeSlash("/git", mods, true)).toEqual({ type: "inspector", command: "git", tab: "git" });
    expect(routeSlash("/uso", mods, true)).toEqual({ type: "inspector", command: "uso", tab: "uso" });
    expect(routeSlash("/codex", mods, true)).toEqual({ type: "engine", command: "codex" });
    expect(routeSlash("/codex revisa el puente", mods, true)).toEqual({ type: "run", command: "codex", args: "revisa el puente" });
  });

  it("unsupported deja una nota y no se ejecuta", () => {
    expect(routeSlash("/vim", live, true)).toMatchObject({ type: "unsupported", command: "vim" });
  });

  it("sin lista viva, /codex:rescue desconocido se envía con aviso; con lista viva y ausente, error", () => {
    expect(routeSlash("/codex:rescue x", FALLBACK_COMMANDS, false)).toEqual({ type: "run", command: "codex:rescue", args: "x", warn: UNCATALOGED_WARNING });
    expect(routeSlash("/nada", live, true)).toMatchObject({ type: "unknown", command: "nada" });
  });

  it("un prompt normal o un !bash no son comandos (caso negativo)", () => {
    expect(routeSlash("arregla /tmp", live, true)).toBeNull();
    expect(routeSlash("!git status", live, true)).toBeNull();
    expect(parseSlash("/ con espacio")).toBeNull();
  });
});

describe("decisión de envío (EST-04, AC-13)", () => {
  const base: SessionInfo = {
    id: "s1", projectId: null, projectName: "p", cwd: "/p", title: "t", claudeSessionId: "c", status: "idle", model: null, startedAt: "",
    bridgeConnected: true, waiting: null, stalled: null, workingSince: null, lastActivityAt: "", turnId: null, screen: "prompt",
    permissionMode: null, launchPermissionMode: "bypassPermissions", exitCode: null, bridgeProtocol: 2,
  };

  it("idle → send; waiting y working → enqueue (Enter nunca escribe en un diálogo)", () => {
    expect(submitAction(base, "auto")).toEqual({ type: "send" });
    expect(submitAction({ ...base, status: "waiting", waiting: { kind: "question", label: "", since: "" } }, "auto")).toEqual({ type: "enqueue" });
    expect(submitAction({ ...base, status: "working" }, "auto")).toEqual({ type: "enqueue" });
    expect(submitAction({ ...base, status: "starting" }, "auto")).toEqual({ type: "enqueue" });
  });

  it("Ctrl+Enter trabajando → now; con un menú en pantalla se bloquea con su motivo (caso negativo)", () => {
    expect(submitAction({ ...base, status: "working" }, "now")).toEqual({ type: "now" });
    expect(submitAction({ ...base, status: "working", screen: "dialog" }, "now")).toEqual({ type: "blocked", reason: DIALOG_BLOCK_REASON });
    expect(submitAction({ ...base, screen: "dialog" }, "auto")).toEqual({ type: "enqueue" });
  });

  it("exited → bloqueado con «la sesión terminó» y el código", () => {
    expect(submitAction({ ...base, status: "exited", exitCode: 1 }, "auto")).toEqual({ type: "blocked", reason: "La sesión terminó (código 1): reiníciala para seguir." });
  });

  it("§3.4: tabla de los modos forzados (now e interrupt)", () => {
    const question = { kind: "question" as const, label: "", since: "" };
    const menu = { kind: "menu" as const, label: "/config", since: "" };
    // Libre: los tres modos son un envío normal.
    for (const mode of ["auto", "now", "interrupt"] as const) expect(submitAction(base, mode)).toEqual({ type: "send" });
    expect(submitAction({ ...base, status: "working" }, "interrupt")).toEqual({ type: "interruptSend" });
    expect(submitAction({ ...base, status: "waiting", waiting: question }, "interrupt")).toEqual({ type: "interruptSend" });
    expect(submitAction({ ...base, status: "waiting", waiting: question }, "now")).toEqual({ type: "blocked", reason: WAITING_NOW_REASON });
    expect(submitAction({ ...base, status: "starting" }, "interrupt")).toEqual({ type: "enqueue" });
    // Casos negativos: menú, confianza o sesión terminada nunca escriben.
    expect(submitAction({ ...base, status: "waiting", waiting: menu, screen: "dialog" }, "interrupt")).toEqual({ type: "blocked", reason: DIALOG_BLOCK_REASON });
    expect(submitAction({ ...base, status: "waiting", waiting: { ...menu, kind: "trust" }, screen: "trust" }, "now")).toEqual({ type: "blocked", reason: DIALOG_BLOCK_REASON });
    expect(submitAction({ ...base, status: "exited", exitCode: 0 }, "interrupt").type).toBe("blocked");
    expect(submitAction(null, "now").type).toBe("blocked");
  });

  it("tipo del elemento de cola según el texto", () => {
    expect(itemKind("/cost", live, false)).toBe("command");
    expect(itemKind("/compact foco en tests", live, false)).toBe("command");
    expect(itemKind("!ls", live, false)).toBe("bash");
    expect(itemKind("hola", live, false)).toBe("prompt");
    // Cola antigua, sin catálogo: basta con que el comando esté bien formado.
    expect(itemKind("/cost", null, false)).toBe("command");
  });

  it("caso negativo: rutas, comandos fuera del catálogo y comandos con adjuntos no son «command»", () => {
    // CommandRun no lleva adjuntos ni sirve para texto libre: van como prompt por el PTY.
    expect(itemKind("/c/Users/p/captura.png mira esto", live, false)).toBe("prompt");
    expect(itemKind("/c/Users/p/captura.png", null, false)).toBe("prompt");
    expect(itemKind("/inexistente", live, false)).toBe("prompt");
    expect(itemKind("/cost", live, true)).toBe("prompt");
    expect(itemKind("/cost", null, true)).toBe("prompt");
    expect(itemKind("/", live, false)).toBe("prompt");
  });
});
