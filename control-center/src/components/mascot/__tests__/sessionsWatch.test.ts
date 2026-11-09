import { describe, expect, it } from "vitest";
import {
  LONG_TURN_MS,
  PENDING_TTL_MS,
  cueFor,
  diffSessions,
  nextPending,
  type ActionableAlert,
  type SessionAlert,
  type WatchedSession,
} from "../sessionsWatch";

function actionable(a: SessionAlert | undefined): ActionableAlert {
  if (!a || a.kind === "gone") throw new Error("se esperaba un aviso accionable");
  return a;
}

const NOW = Date.parse("2026-10-16T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function s(patch: Partial<WatchedSession> = {}): WatchedSession {
  return {
    id: "s1",
    projectId: "ultron",
    projectName: "ULTRON",
    title: "Refactor",
    status: "idle",
    waiting: null,
    stalled: null,
    workingSince: null,
    exitCode: null,
    ...patch,
  };
}
const working = (sinceMs: number) => s({ status: "working", workingSince: iso(sinceMs) });
const waitingOn = (kind: "permission" | "question") =>
  s({ status: "waiting", waiting: { kind, label: "¿Permitir?", since: iso(NOW) }, workingSince: iso(NOW - 5000) });

describe("diffSessions", () => {
  it("la primera lista no genera avisos de arranque", () => {
    expect(diffSessions(null, [waitingOn("permission"), s({ id: "s2", status: "exited", exitCode: 1 })], NOW)).toEqual([]);
  });

  it("turno largo terminado: working → idle tras más de un minuto", () => {
    const a = diffSessions([working(NOW - LONG_TURN_MS - 1)], [s()], NOW);
    expect(a).toEqual([{ kind: "turnDone", session: { id: "s1", projectId: "ultron", title: "Refactor" }, workedMs: LONG_TURN_MS + 1 }]);
  });

  it("caso negativo: turno corto, o working → working, no avisan", () => {
    expect(diffSessions([working(NOW - 5000)], [s()], NOW)).toEqual([]);
    expect(diffSessions([working(NOW - 2 * LONG_TURN_MS)], [working(NOW - 2 * LONG_TURN_MS)], NOW)).toEqual([]);
  });

  it("pasa a esperar (permiso, pregunta…) y avisa una sola vez", () => {
    const a = diffSessions([working(NOW - 1000)], [waitingOn("permission")], NOW);
    expect(a).toMatchObject([{ kind: "waiting", waitKind: "permission" }]);
    expect(diffSessions([waitingOn("permission")], [waitingOn("permission")], NOW)).toEqual([]);
    expect(diffSessions([waitingOn("permission")], [waitingOn("question")], NOW)).toMatchObject([
      { kind: "waiting", waitKind: "question" },
    ]);
  });

  it("caída con código distinto de 0 o atascada: avisa", () => {
    expect(diffSessions([working(NOW)], [s({ status: "exited", exitCode: 2 })], NOW)).toMatchObject([
      { kind: "failed", reason: "exit" },
    ]);
    const stall: WatchedSession["stalled"] = { reason: "noEvents", since: iso(NOW), detail: "sin eventos" };
    expect(diffSessions([working(NOW)], [{ ...working(NOW), stalled: stall }], NOW)).toMatchObject([
      { kind: "failed", reason: "stalled" },
    ]);
  });

  it("caso negativo: salir con código 0 no es un fallo", () => {
    expect(diffSessions([working(NOW)], [s({ status: "exited", exitCode: 0 })], NOW)).toEqual([]);
  });

  it("una sesión que desaparece da «gone»; una nueva no avisa", () => {
    expect(diffSessions([s()], [], NOW)).toEqual([{ kind: "gone", sessionId: "s1" }]);
    expect(diffSessions([], [waitingOn("permission")], NOW)).toEqual([]);
  });
});

describe("nextPending", () => {
  const sessions = [waitingOn("permission")];
  const waitAlert = diffSessions([working(NOW)], sessions, NOW);

  it("un aviso nuevo queda pendiente hasta el clic", () => {
    const p = nextPending(null, waitAlert, sessions, NOW);
    expect(p?.alert.kind).toBe("waiting");
    expect(nextPending(p, [], sessions, NOW + 1000)).toBe(p);
  });

  it("se retira solo si la espera se resuelve, la sesión desaparece o caduca", () => {
    const p = nextPending(null, waitAlert, sessions, NOW);
    expect(nextPending(p, [], [working(NOW)], NOW + 1000)).toBeNull();
    expect(nextPending(p, [], [], NOW + 1000)).toBeNull();
    expect(nextPending(p, [], sessions, NOW + PENDING_TTL_MS)).toBeNull();
  });

  it("un turno terminado no tapa una espera pendiente", () => {
    const p = nextPending(null, waitAlert, [...sessions, s({ id: "s2" })], NOW);
    const done = diffSessions([working(NOW - 2 * LONG_TURN_MS)], [s()], NOW).map((a) =>
      a.kind === "turnDone" ? { ...a, session: { ...a.session, id: "s2" } } : a,
    );
    expect(nextPending(p, done, [...sessions, s({ id: "s2" })], NOW)?.alert.kind).toBe("waiting");
  });
});

describe("cueFor", () => {
  it("cada aviso tiene su icono, y el recordatorio va sin gesto", () => {
    const w = actionable(diffSessions([working(NOW)], [waitingOn("permission")], NOW)[0]);
    expect(cueFor(w, false)).toEqual({ glyph: "exclaim", emote: "hop" });
    expect(cueFor(w, true)).toEqual({ glyph: "exclaim", emote: null });
    const f = actionable(diffSessions([working(NOW)], [s({ status: "exited", exitCode: 1 })], NOW)[0]);
    expect(cueFor(f, false).glyph).toBe("sweat");
  });
});
