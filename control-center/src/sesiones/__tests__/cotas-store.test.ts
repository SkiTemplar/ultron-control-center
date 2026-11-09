import { describe, expect, it } from "vitest";
import { MAX_DISMISSED, MAX_ENGINES, initialState, reducer, type State } from "../reducer";
import { PERSISTED_KEEP, PERSISTED_MAX } from "../session-state";
import type { ChatMessage, EngineTask, SessionInfo } from "../types";
import { longThread, toolUse } from "./fixtures/long-thread";

const info = (id: string, status: SessionInfo["status"] = "idle"): SessionInfo => ({
  id, projectId: null, projectName: "p", cwd: "/p", title: id, claudeSessionId: `c-${id}`, status, model: null, startedAt: "", bridgeConnected: true,
  waiting: null, stalled: null, workingSince: null, lastActivityAt: "", turnId: null, screen: "prompt", permissionMode: null,
  launchPermissionMode: "bypassPermissions", exitCode: null, bridgeProtocol: 2,
});

const task = (i: number, status: EngineTask["status"] = "done"): EngineTask => ({
  id: `t${i}`, engine: "codex", kind: "task", sessionId: "s1", status, startedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(),
} as EngineTask);

describe("el store no crece sin cota en una sesión de días", () => {
  it("una sesión que sale de la lista se purga; una exited que sigue listada no (caso negativo)", () => {
    let s: State = reducer(initialState, { type: "sessions", sessions: [info("a"), info("b", "exited"), info("c")] });
    for (const id of ["a", "b", "c"]) s = reducer(s, { type: "messages", id, messages: longThread(5, id) });
    s = reducer(s, { type: "settings", id: "c", settings: { model: null, effort: "high", permissionMode: null, socratic: null, projectId: null } as never });
    s = reducer(s, { type: "sessions", sessions: [info("a"), info("b", "exited")] });
    expect(Object.keys(s.bySession).sort()).toEqual(["a", "b"]);
    expect(s.settings).toEqual({});
    expect(s.bySession.b.messages).toHaveLength(5);
  });

  it(`las intervenciones se quedan en ${MAX_ENGINES} sin soltar ninguna en marcha`, () => {
    let s: State = reducer(initialState, { type: "engine", task: task(0, "running") });
    for (let i = 1; i <= MAX_ENGINES + 50; i += 1) s = reducer(s, { type: "engine", task: task(i) });
    expect(s.engines).toHaveLength(MAX_ENGINES);
    expect(s.engines.some((t) => t.id === "t0")).toBe(true);
    expect(s.engines.some((t) => t.id === "t1")).toBe(false);
    expect(s.engines.some((t) => t.id === `t${MAX_ENGINES + 50}`)).toBe(true);
  });

  it(`los descartes se quedan en los ${MAX_DISMISSED} más recientes`, () => {
    let s: State = initialState;
    for (let i = 0; i < MAX_DISMISSED + 10; i += 1) s = reducer(s, { type: "engineDismiss", taskId: `d${i}` });
    expect(s.dismissed).toHaveLength(MAX_DISMISSED);
    expect(s.dismissed[0]).toBe("d10");
  });

  it(`los ids de herramientas persistidas pasan de ${PERSISTED_MAX} a ${PERSISTED_KEEP} soltando los más antiguos`, () => {
    const many: ChatMessage[] = Array.from({ length: PERSISTED_MAX + 1 }, (_, i) => toolUse(`m${i}`, i, `tool-${i}`));
    let s: State = reducer(initialState, { type: "messages", id: "s1", messages: many.slice(0, PERSISTED_MAX) });
    expect(s.bySession.s1.persistedToolIds.size).toBe(PERSISTED_MAX);
    s = reducer(s, { type: "messages", id: "s1", messages: [many[PERSISTED_MAX]] });
    const ids = s.bySession.s1.persistedToolIds;
    expect(ids.size).toBe(PERSISTED_KEEP);
    expect(ids.has(`tool-${PERSISTED_MAX}`)).toBe(true);
    expect(ids.has("tool-0")).toBe(false);
  });
});
