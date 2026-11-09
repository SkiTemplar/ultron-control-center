import { describe, expect, it } from "vitest";
import { initialState, reducer, type State } from "../reducer";
import type { Ask, ChatMessage, SessionInfo } from "../types";

const msg = (uuid: string, agentId: string | null = null, role: ChatMessage["role"] = "assistant"): ChatMessage => ({
  uuid, role, timestamp: "2026-10-07T10:00:00Z", agentId, blocks: [{ kind: "text", text: uuid }],
});

const session: SessionInfo = {
  id: "s1", projectId: "p", projectName: "p", cwd: "/p", title: "t", claudeSessionId: null,
  status: "idle", model: null, startedAt: "2026-10-07T10:00:00Z", bridgeConnected: true,
  waiting: null, stalled: null, workingSince: null, lastActivityAt: "2026-10-07T10:00:00Z", turnId: null,
  screen: "prompt", permissionMode: "bypassPermissions", launchPermissionMode: "bypassPermissions",
  exitCode: null, bridgeProtocol: 2,
};

describe("reducer", () => {
  it("no muta el estado anterior", () => {
    const before: State = Object.freeze({ ...initialState }) as State;
    const after = reducer(before, { type: "sessions", sessions: [session] });
    expect(after).not.toBe(before);
    expect(before.sessions).toEqual([]);
    expect(after.sessions).toEqual([session]);
  });

  it("el inicio de working se conserva entre eventos y se borra al dejar de trabajar", () => {
    const working = { ...session, status: "working" as const };
    let s = reducer(initialState, { type: "sessions", sessions: [working], at: 1000 });
    expect(s.workingSince).toEqual({ s1: 1000 });
    s = reducer(s, { type: "sessions", sessions: [working], at: 9000 });
    expect(s.workingSince.s1).toBe(1000);
    s = reducer(s, { type: "sessions", sessions: [session], at: 12000 });
    expect(s.workingSince).toEqual({});
    s = reducer(s, { type: "sessions", sessions: [working], at: 20000 });
    expect(s.workingSince.s1).toBe(20000);
  });

  it("separa mensajes del hilo principal y de subagentes y no duplica por uuid", () => {
    let s = reducer(initialState, { type: "messages", id: "s1", messages: [msg("a"), msg("b", "ag1")] });
    s = reducer(s, { type: "messages", id: "s1", messages: [msg("a"), msg("c")] });
    expect(s.bySession.s1.messages.map((m) => m.uuid)).toEqual(["a", "c"]);
    expect(s.bySession.s1.agentMessages.ag1.map((m) => m.uuid)).toEqual(["b"]);
  });

  it("el historial conserva los mensajes llegados por evento antes que él", () => {
    let s = reducer(initialState, { type: "messages", id: "s1", messages: [msg("nuevo")] });
    s = reducer(s, { type: "history", id: "s1", agentId: null, messages: [msg("viejo"), msg("nuevo")] });
    expect(s.bySession.s1.messages.map((m) => m.uuid)).toEqual(["viejo", "nuevo"]);
    expect(s.bySession.s1.historyLoaded).toBe(true);
  });

  it("una herramienta en vivo desaparece cuando llega al transcript", () => {
    let s = reducer(initialState, { type: "tool", payload: { id: "s1", agentId: null, toolUseId: "t1", name: "Bash", summary: "ls", phase: "start" } });
    s = reducer(s, { type: "tool", payload: { id: "s1", agentId: null, toolUseId: "t1", name: "Bash", summary: "", phase: "end" } });
    expect(s.bySession.s1.liveTools).toHaveLength(1);
    expect(s.bySession.s1.liveTools[0].summary).toBe("ls");
    expect(s.bySession.s1.liveTools[0].phase).toBe("end");
    const m: ChatMessage = { ...msg("x"), blocks: [{ kind: "toolUse", id: "t1", name: "Bash", input: {}, summary: "ls" }] };
    s = reducer(s, { type: "messages", id: "s1", messages: [m] });
    expect(s.bySession.s1.liveTools).toHaveLength(0);
  });

  it("el historial también retira las herramientas en vivo que ya están en el transcript", () => {
    let s = reducer(initialState, { type: "tool", payload: { id: "s1", agentId: null, toolUseId: "t1", name: "Bash", summary: "ls", phase: "end" } });
    s = reducer(s, { type: "tool", payload: { id: "s1", agentId: null, toolUseId: "t2", name: "Read", summary: "a.ts", phase: "start" } });
    const m: ChatMessage = { ...msg("x"), blocks: [{ kind: "toolUse", id: "t1", name: "Bash", input: {}, summary: "ls" }] };
    s = reducer(s, { type: "history", id: "s1", agentId: null, messages: [m] });
    expect(s.bySession.s1.liveTools.map((t) => t.toolUseId)).toEqual(["t2"]);
  });

  it("añade asks sin duplicar y los quita al resolverse", () => {
    const ask: Ask = { askId: "k", id: "s1", kind: "plan", plan: "p" };
    let s = reducer(initialState, { type: "ask", ask });
    const same = reducer(s, { type: "ask", ask });
    expect(same).toBe(s);
    s = reducer(s, { type: "askResolved", askId: "k" });
    expect(s.asks).toEqual([]);
  });

  it("actualiza intervenciones de motores por id y las descarta sin duplicar", () => {
    const t = { id: "c1", engine: "codex" as const, kind: "task" as const, mode: "local" as const, cwd: "/p", prompt: "x", status: "running" as const, startedAt: "", events: [] };
    let s = reducer(initialState, { type: "engine", task: t });
    s = reducer(s, { type: "engine", task: { ...t, status: "done" } });
    expect(s.engines).toHaveLength(1);
    expect(s.engines[0].status).toBe("done");
    s = reducer(s, { type: "engineDismiss", taskId: "c1" });
    expect(reducer(s, { type: "engineDismiss", taskId: "c1" })).toBe(s);
    expect(s.dismissed).toEqual(["c1"]);
  });
});
