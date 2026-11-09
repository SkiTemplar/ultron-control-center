// Derivados que el chat rehace con cada evento: se extienden en vez de recorrer
// todo el hilo, y el store conserva las referencias de lo que llega repetido,
// así el chat no se repinta entero por eventos que no cambian nada.

import { describe, expect, it } from "vitest";
import { buildResultIndex, visibleMessages } from "../parse";
import { initialState, reducer, reuseSessions, trackWorking, type State } from "../reducer";
import { isPersisted } from "../stream";
import { createThreadDerivedCache, deriveThread } from "../timeline";
import type { ChatMessage, SessionInfo, StatusPayload } from "../types";
import { answer, longThread, prompt, toolResult, toolUse } from "./fixtures/long-thread";

function full(raw: readonly ChatMessage[]) {
  return { visible: visibleMessages(raw), results: buildResultIndex(raw) };
}

describe("deriveThread", () => {
  it("al añadir al final da lo mismo que recalcular todo el hilo", () => {
    const cache = createThreadDerivedCache();
    let raw = longThread(200);
    deriveThread(cache, raw);
    for (const m of [toolUse("n1", 500, "nt1"), toolResult("n2", 501, "nt1"), answer("n3", 502)]) {
      raw = [...raw, m];
      const got = deriveThread(cache, raw);
      expect(got.visible).toEqual(full(raw).visible);
      expect([...got.results.entries()]).toEqual([...full(raw).results.entries()]);
    }
  });

  it("sin nada visible ni resultados nuevos conserva los mismos objetos", () => {
    const cache = createThreadDerivedCache();
    const raw = longThread(50);
    const first = deriveThread(cache, raw);
    const grown = [...raw, { ...answer("vacío", 900), blocks: [] }];
    const next = deriveThread(cache, grown);
    expect(next.visible).toBe(first.visible);
    expect(next.results).toBe(first.results);
    const withAnswer = deriveThread(cache, [...grown, answer("n", 901)]);
    expect(withAnswer.results).toBe(first.results);
    expect(withAnswer.visible).not.toBe(first.visible);
  });

  it("si cambia un mensaje anterior o se recorta la cabeza, recalcula entero (caso negativo)", () => {
    const cache = createThreadDerivedCache();
    const raw = [prompt("p", 1), toolUse("a", 2, "t1"), toolResult("r", 3, "t1")];
    deriveThread(cache, raw);
    const replaced = [raw[0], raw[1], { ...toolResult("r", 3, "t1"), blocks: [{ kind: "toolResult" as const, toolUseId: "t1", text: "otra", isError: true }] }];
    expect(deriveThread(cache, replaced).results.get("t1")?.text).toBe("otra");
    const capped = replaced.slice(1);
    expect(deriveThread(cache, capped).visible).toEqual(full(capped).visible);
  });
});

const info = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  id, projectId: null, projectName: "p", cwd: "C:\\p", title: id, claudeSessionId: null, status: "working", model: null,
  startedAt: "2026-10-13T00:00:00Z", bridgeConnected: true, waiting: null, stalled: null, workingSince: null,
  lastActivityAt: "2026-10-13T00:00:00Z", turnId: null, screen: "idle" as SessionInfo["screen"], permissionMode: null,
  launchPermissionMode: "default" as SessionInfo["launchPermissionMode"], exitCode: null, bridgeProtocol: 2, ...extra,
});

describe("referencias estables en el store", () => {
  it("una lista de sesiones reemitida igual conserva los objetos; la que cambia, no", () => {
    let s: State = reducer(initialState, { type: "sessions", sessions: [info("a"), info("b")], at: 1 });
    const before = s.sessions;
    s = reducer(s, { type: "sessions", sessions: [info("a"), info("b")], at: 2 });
    expect(s.sessions).toBe(before);
    s = reducer(s, { type: "sessions", sessions: [info("a", { lastActivityAt: "2026-10-13T00:00:05Z" }), info("b")], at: 3 });
    expect(s.sessions).not.toBe(before);
    expect(s.sessions[0]).not.toBe(before[0]);
    expect(s.sessions[1]).toBe(before[1]);
    expect(s.sessions[0].lastActivityAt).toBe("2026-10-13T00:00:05Z");
  });

  it("reuseSessions respeta el orden nuevo y las altas (caso negativo)", () => {
    const prev = [info("a"), info("b")];
    const next = reuseSessions(prev, [info("b"), info("a"), info("c")]);
    expect(next.map((x) => x.id)).toEqual(["b", "a", "c"]);
    expect(next[0]).toBe(prev[1]);
  });

  it("trackWorking sin cambios devuelve la misma referencia", () => {
    const prev = { a: 5 };
    expect(trackWorking(prev, [info("a")], 9)).toBe(prev);
    expect(trackWorking(prev, [info("a"), info("b")], 9)).toEqual({ a: 5, b: 9 });
  });

  it("un estado de la línea de estado repetido no cambia la sesión; uno distinto sí", () => {
    const status: StatusPayload = { id: "a", model: "claude-opus-5-5", contextTokens: 10, contextWindow: 200, costUsd: 0.1 };
    const s1 = reducer(initialState, { type: "status", payload: status });
    expect(reducer(s1, { type: "status", payload: { ...status } })).toBe(s1);
    const s2 = reducer(s1, { type: "status", payload: { ...status, contextTokens: 11 } });
    expect(s2.bySession.a.status?.contextTokens).toBe(11);
  });
});

describe("isPersisted", () => {
  it("mira solo las últimas respuestas, desde el final", () => {
    const thread = [...longThread(5000), answer("fin", 9000, "párrafo final")];
    expect(isPersisted("párrafo final", thread)).toBe(true);
    expect(isPersisted("Respuesta **m0**", thread)).toBe(false);
  });
});
