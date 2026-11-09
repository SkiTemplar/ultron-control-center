import { describe, expect, it } from "vitest";
import { applyStream, getStream, isPersisted, pushStream, setMessagesSource } from "../stream";
import type { ChatMessage } from "../types";
import { applyCompletion, findTrigger } from "../components/composer/commands";
import {
  MAX_PANES, closePane, closeTab, closeTabToNeighbor, emptyWorkspace, focusPane, loadWorkspace, pruneWorkspace, showInFocused, splitWith,
} from "../workspace";

describe("espacio de trabajo", () => {
  it("muestra una sesión en el panel con foco y abre su pestaña", () => {
    const ws = showInFocused(emptyWorkspace, "a");
    expect(ws.panes[0].sessionId).toBe("a");
    expect(ws.tabs).toEqual(["a"]);
    expect(emptyWorkspace.tabs).toEqual([]);
  });

  it("divide hasta 2×2 y fija la orientación con el primer borde", () => {
    let ws = showInFocused(emptyWorkspace, "a");
    ws = splitWith(ws, "b", "bottom");
    expect(ws.split).toBe("v");
    expect(ws.focused).toBe(1);
    ws = splitWith(ws, "c", "left");
    expect(ws.panes[0].sessionId).toBe("c");
    expect(ws.split).toBe("v");
    ws = splitWith(ws, "d", "right");
    expect(ws.panes).toHaveLength(MAX_PANES);
    const full = splitWith(ws, "e", "right");
    expect(full.panes).toHaveLength(MAX_PANES);
    expect(full.panes[full.focused].sessionId).toBe("e");
  });

  it("cierra paneles ajustando el foco y nunca deja la rejilla vacía", () => {
    let ws = splitWith(showInFocused(emptyWorkspace, "a"), "b", "right");
    ws = focusPane(ws, 1);
    ws = closePane(ws, 0);
    expect(ws.panes).toHaveLength(1);
    expect(ws.focused).toBe(0);
    ws = closePane(ws, 0);
    expect(ws.panes).toHaveLength(1);
    expect(ws.panes[0].sessionId).toBeNull();
  });

  it("una disposición guardada con vista de terminal se carga como chat (sin terminal visible)", () => {
    localStorage.setItem("ultron.sesiones.workspace", JSON.stringify({ tabs: ["a"], panes: [{ key: "k", sessionId: "a", agentId: null, view: "terminal" }], focused: 0, split: "h" }));
    const ws = loadWorkspace();
    expect(ws.panes[0]).not.toHaveProperty("view");
    expect(ws.panes[0].sessionId).toBe("a");
    localStorage.removeItem("ultron.sesiones.workspace");
  });

  it("limpia sesiones muertas", () => {
    let ws = splitWith(showInFocused(emptyWorkspace, "a"), "b", "right");
    ws = pruneWorkspace(ws, ["a"]);
    expect(ws.tabs).toEqual(["a"]);
    expect(ws.panes[1].sessionId).toBeNull();
    expect(pruneWorkspace(ws, ["a"])).toBe(ws);
    expect(closeTab(ws, "a").panes[0].sessionId).toBeNull();
  });
});

describe("cerrar pestaña", () => {
  const three = { ...emptyWorkspace, tabs: ["a", "b", "c"], panes: [{ key: "k", sessionId: "b", agentId: null }] };

  it("el panel pasa a la pestaña siguiente y, si era la última, a la anterior", () => {
    expect(closeTabToNeighbor(three, "b").panes[0].sessionId).toBe("c");
    const last = { ...three, panes: [{ key: "k", sessionId: "c", agentId: null }] };
    expect(closeTabToNeighbor(last, "c").panes[0].sessionId).toBe("b");
    expect(closeTabToNeighbor(three, "b").tabs).toEqual(["a", "c"]);
  });

  it("caso negativo: no duplica una sesión visible en otro panel ni inventa una vecina", () => {
    const split = { ...three, panes: [{ key: "k", sessionId: "b", agentId: null }, { key: "j", sessionId: "c", agentId: null }] };
    expect(closeTabToNeighbor(split, "b").panes.map((p) => p.sessionId)).toEqual(["a", "c"]);
    const lone = { ...emptyWorkspace, tabs: ["a"], panes: [{ key: "k", sessionId: "a", agentId: null }] };
    expect(closeTabToNeighbor(lone, "a").panes[0].sessionId).toBeNull();
    const other = { ...three, panes: [{ key: "k", sessionId: "a", agentId: null }] };
    expect(closeTabToNeighbor(other, "b").panes[0].sessionId).toBe("a");
  });
});

describe("streaming", () => {
  it("acumula deltas del mismo turno y reinicia con un turno nuevo", () => {
    const p = { id: "s", agentId: null, step: 0, block: 0, done: false };
    let e = applyStream(undefined, { ...p, turnId: "1", text: "Hola" });
    e = applyStream(e, { ...p, turnId: "1", text: " mundo" });
    e = applyStream(e, { ...p, turnId: "1", text: "pienso", thinking: true });
    expect(e.text).toBe("Hola mundo");
    expect(e.thinking).toBe("pienso");
    e = applyStream(e, { ...p, turnId: "2", text: "Otro" });
    expect(e.text).toBe("Otro");
    expect(e.thinking).toBe("");
  });

  const answer = (text: string): ChatMessage => ({ uuid: "a", role: "assistant", timestamp: "", agentId: null, blocks: [{ kind: "text", text }] });

  it("reconoce el texto en vivo que ya llegó al transcript y no otro (caso negativo)", () => {
    expect(isPersisted("Resumen final del turno.", [answer("Intro.\n\nResumen final del turno.")])).toBe(true);
    expect(isPersisted("Otra cosa distinta", [answer("Resumen final del turno.")])).toBe(false);
    expect(isPersisted("", [answer("x")])).toBe(false);
  });

  it("si el «done» llega después del mensaje definitivo, la burbuja desaparece (no se duplica)", async () => {
    setMessagesSource(() => [answer("Hola, todo listo.")]);
    pushStream({ id: "s9", agentId: null, turnId: "t", step: 0, block: 0, text: "Hola, todo listo.", done: true });
    await new Promise((r) => window.setTimeout(r, 50));
    expect(getStream("s9", null)).toBeUndefined();
    setMessagesSource(() => []);
    pushStream({ id: "s9", agentId: null, turnId: "t2", step: 0, block: 0, text: "Aún no guardado", done: true });
    await new Promise((r) => window.setTimeout(r, 50));
    expect(getStream("s9", null)?.text).toBe("Aún no guardado");
  });
});

describe("autocompletado del composer", () => {
  it("detecta / al inicio de línea y @ tras espacio", () => {
    expect(findTrigger("/mej", 4)).toEqual({ kind: "slash", query: "/mej", start: 0, end: 4 });
    expect(findTrigger("mira @src/a", 11)).toEqual({ kind: "at", query: "src/a", start: 5, end: 11 });
    expect(findTrigger("a/b", 3)).toBeNull();
    expect(findTrigger("correo@dominio", 14)).toBeNull();
  });

  it("detecta comandos con espacio de nombres de plugin", () => {
    expect(findTrigger("/codex:res", 10)).toEqual({ kind: "slash", query: "/codex:res", start: 0, end: 10 });
  });

  it("sustituye el disparador", () => {
    const t = findTrigger("lee @vi", 7);
    expect(t).not.toBeNull();
    if (t) expect(applyCompletion("lee @vi", t, "view.tsx")).toEqual({ text: "lee @view.tsx ", caret: 14 });
  });
});
