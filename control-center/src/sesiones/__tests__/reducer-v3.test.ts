import { describe, expect, it } from "vitest";
import { initialState, reducer, type State } from "../reducer";
import type { Ask, ChatMessage, SessionInfo, ToolPayload } from "../types";

const toolMsg = (uuid: string, id: string, agentId: string | null = null): ChatMessage => ({
  uuid, role: "assistant", timestamp: "2026-10-08T10:00:00Z", agentId, blocks: [{ kind: "toolUse", id, name: "Bash", input: {}, summary: "ls" }],
});
const tp = (toolUseId: string, phase: ToolPayload["phase"], agentId: string | null = null): ToolPayload => ({ id: "s1", agentId, toolUseId, name: "Bash", summary: "ls", phase });
const info = (status: SessionInfo["status"]): SessionInfo => ({
  id: "s1", projectId: null, projectName: "p", cwd: "/p", title: "t", claudeSessionId: "c", status, model: null, startedAt: "", bridgeConnected: true,
  waiting: null, stalled: null, workingSince: null, lastActivityAt: "", turnId: null, screen: "prompt", permissionMode: null,
  launchPermissionMode: "bypassPermissions", exitCode: null, bridgeProtocol: 2,
});

describe("herramientas en vivo por identidad (chat-orden:M1, EST-06)", () => {
  it("start → mensaje con el tool_use → end deja liveTools vacío", () => {
    let s = reducer(initialState, { type: "tool", payload: tp("t1", "start") });
    s = reducer(s, { type: "messages", id: "s1", messages: [toolMsg("m", "t1")] });
    s = reducer(s, { type: "tool", payload: tp("t1", "end") });
    expect(s.bySession.s1.liveTools).toEqual([]);
  });

  it("una herramienta sin persistir sigue visible (caso negativo) y un end de id desconocido se ignora", () => {
    let s = reducer(initialState, { type: "tool", payload: tp("t2", "start") });
    s = reducer(s, { type: "tool", payload: tp("nadie", "end") });
    expect(s.bySession.s1.liveTools.map((t) => t.toolUseId)).toEqual(["t2"]);
  });

  it("el hilo principal se vacía con el turno cerrado y al pasar a idle; los subagentes no", () => {
    let s = reducer(initialState, { type: "tool", payload: tp("a", "start") });
    s = reducer(s, { type: "tool", payload: tp("b", "start", "ag1") });
    s = reducer(s, { type: "sessions", sessions: [info("idle")] });
    expect(s.bySession.s1.liveTools.map((t) => t.toolUseId)).toEqual(["b"]);
    s = reducer(s, { type: "tool", payload: tp("c", "start") });
    s = reducer(s, { type: "turn", payload: { id: "s1", turnId: "T", startedAt: "", endedAt: "", durationMs: 1, reason: "answer" } });
    expect(s.bySession.s1.liveTools.map((t) => t.toolUseId)).toEqual(["b"]);
    expect(s.bySession.s1.turns).toHaveLength(1);
  });
});

describe("eco por clientId (§5.2, VEL-01, AC-11)", () => {
  const user = (clientId: string): ChatMessage => ({ uuid: `u-${clientId}`, role: "user", timestamp: "", agentId: null, blocks: [{ kind: "text", text: "hola" }], clientId });

  it("eco X + mensaje con clientId X → una sola burbuja; otro clientId no lo retira", () => {
    let s = reducer(initialState, { type: "echo", id: "s1", echo: { clientId: "X", text: "hola", attachments: [], at: "2026-10-08T10:00:00Z" } });
    s = reducer(s, { type: "echo", id: "s1", echo: { clientId: "X", text: "hola", attachments: [], at: "2026-10-08T10:00:00Z" } });
    expect(s.bySession.s1.echoes).toHaveLength(1);
    s = reducer(s, { type: "messages", id: "s1", messages: [user("Y")] });
    expect(s.bySession.s1.echoes).toHaveLength(1);
    s = reducer(s, { type: "messages", id: "s1", messages: [user("X")] });
    expect(s.bySession.s1.echoes).toEqual([]);
  });
});

describe("cambio de conversación y subagentes", () => {
  it("reset vacía mensajes, herramientas y preguntas de esa sesión y conserva la cola", () => {
    const ask: Ask = { askId: "k", id: "s1", kind: "plan", plan: "p" };
    const other: Ask = { askId: "k2", id: "s2", kind: "plan", plan: "p" };
    let s: State = reducer(initialState, { type: "messages", id: "s1", messages: [toolMsg("m", "t1")] });
    s = reducer(s, { type: "tool", payload: tp("t9", "start") });
    s = reducer(s, { type: "ask", ask });
    s = reducer(s, { type: "ask", ask: other });
    s = reducer(s, { type: "queue", id: "s1", items: [{ clientId: "q", text: "x", attachments: [], delegate: false, kind: "prompt", origin: "ultron", state: "queued", createdAt: "" }] });
    s = reducer(s, { type: "reset", id: "s1" });
    expect(s.bySession.s1.messages).toEqual([]);
    expect(s.bySession.s1.liveTools).toEqual([]);
    expect(s.asks.map((a) => a.askId)).toEqual(["k2"]);
    expect(s.bySession.s1.queue).toHaveLength(1);
  });

  it("el historial de un subagente se fusiona con lo llegado por evento antes (F16)", () => {
    let s = reducer(initialState, { type: "messages", id: "s1", messages: [toolMsg("nuevo", "x", "ag1")] });
    s = reducer(s, { type: "history", id: "s1", agentId: "ag1", messages: [toolMsg("viejo", "y", "ag1")] });
    expect(s.bySession.s1.agentMessages.ag1.map((m) => m.uuid)).toEqual(["viejo", "nuevo"]);
  });
});

describe("preguntas recuperables e interrupción", () => {
  const ask: Ask = { askId: "k", id: "s1", kind: "question", questions: [] };

  it("pending_asks añade sin duplicar lo que ya estaba", () => {
    let s = reducer(initialState, { type: "ask", ask });
    const same = reducer(s, { type: "asks", asks: [ask] });
    expect(same).toBe(s);
    s = reducer(s, { type: "asks", asks: [{ ...ask, askId: "k3" }] });
    expect(s.asks).toHaveLength(2);
  });

  it("Interrumpir oculta la tarjeta y ask-resolved la saca; si falla, vuelve a verse", () => {
    let s = reducer(initialState, { type: "ask", ask });
    s = reducer(s, { type: "askInterrupting", askIds: ["k"] });
    expect(s.interruptingAsks).toEqual(["k"]);
    expect(reducer(s, { type: "askInterruptFailed", askIds: ["k"] }).interruptingAsks).toEqual([]);
    s = reducer(s, { type: "askResolved", askId: "k" });
    expect(s.asks).toEqual([]);
    expect(s.interruptingAsks).toEqual([]);
  });
});
