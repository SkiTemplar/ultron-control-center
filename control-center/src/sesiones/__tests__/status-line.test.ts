import { describe, expect, it } from "vitest";
import { STALL_RED_MS, TASK_RESUME_TEXT, basename, escAction, statusLine, toolPhrase } from "../components/chat/status-line";
import type { LiveTool } from "../session-state";
import type { Ask, SessionInfo } from "../types";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const base: SessionInfo = {
  id: "s1", projectId: "p", projectName: "p", cwd: "/p", title: "t", claudeSessionId: "c", status: "idle", model: null,
  startedAt: iso(0), bridgeConnected: true, waiting: null, stalled: null, workingSince: null, lastActivityAt: iso(0), turnId: null,
  screen: "prompt", permissionMode: "bypassPermissions", launchPermissionMode: "bypassPermissions", exitCode: null, bridgeProtocol: 2,
};
const tool = (name: string, summary: string, phase: LiveTool["phase"] = "start"): LiveTool => ({ toolUseId: name, agentId: null, name, summary, phase });
const ctx = { now: NOW };

describe("línea de estado única (§5.5, AC-12)", () => {
  it.each([
    ["Edit con ruta absoluta", [tool("Edit", "C:\\proyectos\\app\\src\\x.ts")], "Editando x.ts…"],
    ["Bash con su comando", [tool("Bash", "npm test")], "Ejecutando npm test…"],
    ["Read", [tool("Read", "/a/b/c.md")], "Leyendo c.md…"],
    ["Grep", [tool("Grep", "foo")], "Buscando…"],
  ])("working: %s", (_name, live, text) => {
    const s = statusLine({ ...base, status: "working", workingSince: iso(5000) }, live, [], ctx);
    expect(s.text).toBe(text);
    // Interrumpir vive solo en el composer (con Esc): la línea no lo repite.
    expect(s.actions).toEqual([]);
  });

  it("working sin herramienta: «Trabajando · tiempo»; una herramienta ya terminada no cuenta", () => {
    const s = statusLine({ ...base, status: "working", workingSince: iso(72000) }, [tool("Edit", "a.ts", "end")], [], ctx);
    expect(s.text).toBe("Trabajando · 1 min 12 s");
  });

  it("idle sin herramientas → «Listo» y no «Trabajando» (caso negativo)", () => {
    const s = statusLine(base, [], [], ctx);
    expect(s.text).toBe("Listo");
    expect(s.tone).toBe("idle");
  });

  it("idle tras un turno abortado → «Interrumpido» y ofrece enviar la cola", () => {
    const queue = [{ clientId: "a", text: "x", attachments: [], delegate: false, kind: "prompt" as const, origin: "ultron" as const, state: "queued" as const, createdAt: iso(0) }];
    const s = statusLine(base, [], [], { ...ctx, lastTurnAborted: true, queue });
    expect(s.text).toBe("Interrumpido");
    expect(s.actions).toEqual(["sendNow"]);
  });

  it("waiting por permiso → «Esperando tu respuesta: permiso Bash» sin Interrumpir repetido", () => {
    const ask: Ask = { askId: "k", id: "s1", kind: "permission", tool: "Bash", input: {}, summary: "", agentId: null };
    const s = statusLine({ ...base, status: "waiting", waiting: { kind: "permission", askId: "k", label: "permiso Bash", since: iso(0) } }, [], [ask], ctx);
    expect(s.text).toBe("Esperando tu respuesta: permiso Bash");
    expect(s.actions).toEqual([]);
  });

  it("menú abierto y confianza → sin acciones (Salir del menú va en el composer y la tarjeta)", () => {
    expect(statusLine({ ...base, status: "waiting", waiting: { kind: "menu", label: "/config", since: iso(0) } }, [], [], ctx).actions).toEqual([]);
    expect(statusLine({ ...base, status: "waiting", waiting: { kind: "trust", label: "", since: iso(0) } }, [], [], ctx)).toMatchObject({ text: "Confirma la carpeta", actions: [] });
  });

  it("colgado con su causa, en ámbar; a los 5 min en rojo con Reiniciar", () => {
    const stalled = { reason: "noEvents" as const, since: iso(120000), detail: "" };
    const amber = statusLine({ ...base, status: "working", stalled }, [], [], ctx);
    expect(amber).toMatchObject({ tone: "warn", text: "Sin eventos desde hace 2 min", actions: ["recover"] });
    const red = statusLine({ ...base, status: "working", stalled: { ...stalled, since: iso(STALL_RED_MS) } }, [], [], ctx);
    expect(red.tone).toBe("err");
    expect(red.actions).toContain("restart");
  });

  it("una herramienta abierta dentro de su límite no se rotula colgada (caso negativo)", () => {
    const s = statusLine({ ...base, status: "working" }, [tool("Bash", "npm test")], [], ctx);
    expect(s.tone).toBe("busy");
  });

  it("exited → «La sesión terminó (código N)» con Reiniciar", () => {
    expect(statusLine({ ...base, status: "exited", exitCode: 3 }, [], [], ctx)).toMatchObject({ text: "La sesión terminó (código 3)", actions: ["restart"] });
  });

  it("menú de un /comando: la etiqueta del backend nombra el comando", () => {
    expect(statusLine({ ...base, status: "waiting", waiting: { kind: "menu", label: "/config", since: iso(0) } }, [], [], ctx).text).toBe("Menú /config abierto en la TUI");
    expect(statusLine({ ...base, status: "waiting", waiting: { kind: "menu", label: "Menú abierto en la TUI", since: iso(0) } }, [], [], ctx).text).toBe("Menú abierto en la TUI");
  });

  it("#32: starting sin prompt en 30 s ofrece Reiniciar con la causa; sin stalled, sin acciones", () => {
    const stalled = { reason: "startupTimeout" as const, since: iso(0), detail: "Claude no ha llegado al prompt en 30 s (pantalla: unknown)" };
    expect(statusLine({ ...base, status: "starting", stalled }, [], [], ctx)).toEqual({ tone: "warn", text: stalled.detail, actions: ["restart"] });
    expect(statusLine({ ...base, status: "starting" }, [], [], ctx)).toEqual({ tone: "busy", text: "Arrancando Claude…", actions: [] });
  });

  it("#30: la CLI abrió otro turno con el aviso de una tarea tras interrumpir → lo dice y sin repetir Interrumpir", () => {
    const s = statusLine({ ...base, status: "working" }, [], [], { ...ctx, resumedBySubagent: true });
    expect(s).toEqual({ tone: "warn", text: TASK_RESUME_TEXT, actions: [] });
    expect(statusLine({ ...base, status: "working" }, [], [], ctx).text).not.toBe(TASK_RESUME_TEXT);
  });

  it("#31: cola con elementos y terminal del menú enganchada en idle → «Cola en pausa» con Soltar", () => {
    const queue = [{ clientId: "a", text: "x", attachments: [], delegate: false, kind: "prompt" as const, origin: "ultron" as const, state: "queued" as const, createdAt: iso(0) }];
    expect(statusLine({ ...base, terminalAttached: true }, [], [], { ...ctx, queue })).toEqual({
      tone: "warn", text: "Cola en pausa: terminal del menú enganchada", actions: ["releaseTerminal"],
    });
    expect(statusLine({ ...base, terminalAttached: true }, [], [], ctx).text).toBe("Listo");
    expect(statusLine(base, [], [], { ...ctx, queue }).text).toBe("Listo");
  });

  it("§3.4: la herramienta en primer plano del backend lleva su tiempo y «Segundo plano»", () => {
    const foregroundTool = { toolUseId: "Bash", name: "Bash", since: iso(133000), backgroundable: true };
    // La ventana vio el evento `tool` hace poco (recargada): manda el inicio del backend.
    const live = [{ ...tool("Bash", "npm test"), startedAt: NOW - 2000 }];
    const s = statusLine({ ...base, status: "working", foregroundTool }, live, [], ctx);
    expect(s.text).toBe("Bash lleva 2 min 13 s: Ctrl+B para pasarla a segundo plano o Esc para interrumpir");
    expect(s.actions).toEqual(["background"]);
    const fresh = statusLine({ ...base, status: "working", foregroundTool: { ...foregroundTool, since: iso(5000) } }, live, [], ctx);
    expect(fresh).toMatchObject({ tone: "busy", text: "Ejecutando npm test… · 5 s", actions: ["background"] });
    // Sin evento en esta ventana, la herramienta sale solo del backend.
    expect(statusLine({ ...base, status: "working", foregroundTool: { ...foregroundTool, since: iso(5000) } }, [], [], ctx).text).toBe("Ejecutando… · 5 s");
  });

  it("caso negativo: una herramienta que Ctrl+B no mueve (Read) no ofrece «Segundo plano»", () => {
    const foregroundTool = { toolUseId: "Read", name: "Read", since: iso(3000), backgroundable: false };
    const s = statusLine({ ...base, status: "working", foregroundTool }, [tool("Read", "/a/b.md")], [], ctx);
    expect(s.actions).toEqual([]);
    expect(statusLine({ ...base, status: "working" }, [tool("Bash", "npm test")], [], ctx).actions).toEqual([]);
  });

  it("toolOverdue con una herramienta movible antepone «Segundo plano»; otra causa no", () => {
    const foregroundTool = { toolUseId: "Bash", name: "Bash", since: iso(200000), backgroundable: true };
    const overdue = { reason: "toolOverdue" as const, since: iso(10000), tool: "Bash", detail: "Bash sigue sin terminar: 3 min 20 s (límite 2 min)" };
    expect(statusLine({ ...base, status: "working", stalled: overdue, foregroundTool }, [], [], ctx).actions).toEqual(["background", "recover"]);
    const noEvents = { reason: "noEvents" as const, since: iso(10000), detail: "" };
    expect(statusLine({ ...base, status: "working", stalled: noEvents, foregroundTool }, [], [], ctx).actions).toEqual(["recover"]);
  });

  it("verbos y nombres de fichero", () => {
    expect(basename("C:\\a\\b\\Composer.tsx")).toBe("Composer.tsx");
    expect(toolPhrase("Write", "/x/y.ts")).toBe("Editando y.ts…");
    expect(toolPhrase("Task", "revisa")).toBe("Delegando en un subagente…");
  });
});

describe("Esc en el composer (§3.1)", () => {
  it("waiting{menu} → exitMenu; working → interrupt; pregunta → interrupt", () => {
    expect(escAction({ ...base, status: "waiting", waiting: { kind: "menu", label: "", since: iso(0) }, screen: "dialog" }, true)).toBe("exitMenu");
    expect(escAction({ ...base, status: "working" }, true)).toBe("interrupt");
    expect(escAction({ ...base, status: "waiting", waiting: { kind: "question", label: "", since: iso(0) } }, true)).toBe("interrupt");
  });

  it("con texto en el composer, en idle o con la confianza no hace nada (caso negativo)", () => {
    expect(escAction({ ...base, status: "working" }, false)).toBeNull();
    expect(escAction(base, true)).toBeNull();
    expect(escAction({ ...base, status: "waiting", waiting: { kind: "trust", label: "", since: iso(0) }, screen: "trust" }, true)).toBeNull();
  });
});
