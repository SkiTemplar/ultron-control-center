// Incidente del 2026-10-15 (sesión f8e7249b): dos Esc seguidos dejaban dos
// notas «Interrupción en curso»; un turno nuevo abierto por el aviso de una
// tarea acababa en rojo con «reiníciala»; la cola en pausa por plazo no se
// entendía ni se podía reanudar; y un `find` de 7 min solo mostraba
// «Trabajando». Cada caso fallaba antes o fija un caso negativo.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { ChatStatus } from "../components/chat/ChatStatus";
import { TOOL_AVISO_MS, statusLine } from "../components/chat/status-line";
import { Composer } from "../components/composer/Composer";
import { FALLBACK_COMMANDS } from "../components/composer/commands";
import { IN_PROGRESS_TEXT, recoverNote, subagentResumeStore } from "../components/composer/recover-note";
import { ApiContext } from "../context";
import { addNoteTo, initialState, reducer } from "../reducer";
import type { ChatNote, LiveTool } from "../session-state";
import { store } from "../store";
import type { ChatMessage, QueueItem, RecoverOutcome, SessionInfo, ToolPayload } from "../types";

const NOW = Date.parse("2026-10-15T22:30:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const base: SessionInfo = {
  id: "inc1", projectId: "p", projectName: "p", cwd: "C:/p", title: "t", claudeSessionId: "c", status: "working", model: null,
  startedAt: "", bridgeConnected: true, waiting: null, stalled: null, workingSince: iso(0), lastActivityAt: "", turnId: "t1", screen: "prompt",
  permissionMode: "bypassPermissions", launchPermissionMode: "bypassPermissions", exitCode: null, bridgeProtocol: 2,
};

const item = (state: QueueItem["state"]): QueueItem => ({
  clientId: `q-${state}`, text: "Estas ahí?", attachments: [], delegate: false, kind: "prompt", origin: "ultron", state, createdAt: iso(0),
});

const out = (steps: string[], ok = false): RecoverOutcome => ({ ok, action: "interrupt", steps, status: "working" });

afterEach(() => {
  cleanup();
  subagentResumeStore.dispatch({ id: "inc1", resumed: false });
});

// ---------------------------------------------------------------------------
// Notas de la recuperación
// ---------------------------------------------------------------------------

describe("nota de la recuperación", () => {
  it("«antirrebote» (la anterior ya terminó) no deja nota; «enCurso» sí (caso negativo)", () => {
    expect(recoverNote(out(["antirrebote"], true))).toBeNull();
    expect(recoverNote(out(["enCurso"], true))).toEqual({ level: "info", text: IN_PROGRESS_TEXT });
  });

  it("un turno nuevo nunca da una nota de error (la máquina avisa en ámbar)", () => {
    expect(recoverNote(out(["turn.abort", "turnoNuevo", "turn.abort", "sigueTrabajando"]))).toBeNull();
    expect(recoverNote(out(["esc", "ctrlC", "sigueTrabajando", "retomaPorTarea"]))).toBeNull();
  });

  it("caso negativo: una tecla que no se pudo escribir sigue siendo error", () => {
    expect(recoverNote(out(["esc: el PTY no acepta escritura", "sigueTrabajando"]))?.level).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Dos Esc seguidos
// ---------------------------------------------------------------------------

function composerApi(recover: () => Promise<RecoverOutcome>): SesionesApi {
  const defaults: Record<string, unknown> = { promptHistory: [], listFiles: [], commands: FALLBACK_COMMANDS, engineModels: [] };
  const fns = new Map<string, unknown>([["recover", vi.fn(recover)]]);
  return new Proxy({ isMock: true }, {
    get(target, prop: string) {
      if (prop in target) return (target as Record<string, unknown>)[prop];
      if (prop === "then") return undefined;
      if (!fns.has(prop)) {
        fns.set(prop, prop === "gitSnapshot" ? vi.fn().mockRejectedValue(new Error("sin git")) : vi.fn().mockResolvedValue(defaults[prop]));
      }
      return fns.get(prop);
    },
  }) as SesionesApi;
}

const notesOf = (id: string): ChatNote[] => store.getState().bySession[id]?.notes ?? [];

describe("dos Esc seguidos con la interrupción en vuelo", () => {
  it("una sola llamada al backend y una sola nota «en curso»", async () => {
    let resolve: (o: RecoverOutcome) => void = () => {};
    const pending = new Promise<RecoverOutcome>((r) => { resolve = r; });
    const api = composerApi(() => pending);
    act(() => store.dispatch({ type: "sessions", sessions: [base] }));
    render(<ApiContext.Provider value={api}><Composer sessionId="inc1" /></ApiContext.Provider>);
    const box = screen.getByRole("textbox", { name: "Mensaje" });
    const before = notesOf("inc1").length;
    await act(async () => {
      for (let i = 0; i < 3; i += 1) fireEvent.keyDown(box, { key: "Escape", code: "Escape" });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(api.recover).toHaveBeenCalledTimes(1);
    const added = notesOf("inc1").slice(before);
    expect(added.map((n) => n.text)).toEqual([IN_PROGRESS_TEXT]);
    await act(async () => {
      resolve(out(["turn.abort"], true));
      await pending;
    });
    // Terminado el vuelo, el siguiente Esc vuelve a llamar (caso negativo).
    await act(async () => {
      fireEvent.keyDown(box, { key: "Escape", code: "Escape" });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(api.recover).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Notas repetidas
// ---------------------------------------------------------------------------

describe("notas repetidas", () => {
  const note = (id: string, text: string, at: string): ChatNote => ({ id, at, level: "info", text });

  it("dos notas idénticas seguidas quedan en una con count 2", () => {
    let s = reducer(initialState, { type: "note", id: "n1", note: note("a", "Interrupción en curso", iso(2000)) });
    s = reducer(s, { type: "note", id: "n1", note: note("b", "Interrupción en curso", iso(1000)) });
    expect(s.bySession.n1.notes).toHaveLength(1);
    expect(s.bySession.n1.notes[0]).toMatchObject({ id: "a", count: 2, at: iso(1000) });
  });

  it("caso negativo: otro texto, u otra igual pasados 10 s, añade otra nota", () => {
    const first = [note("a", "x", iso(30_000))];
    expect(addNoteTo(first, note("b", "y", iso(29_000)))).toHaveLength(2);
    expect(addNoteTo(first, note("b", "x", iso(15_000)))).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Cola en pausa por plazo
// ---------------------------------------------------------------------------

describe("cola en pausa por plazo en la línea de estado", () => {
  const idle: SessionInfo = { ...base, status: "idle", turnId: null };
  const pause = { reason: "deadline" as const, since: iso(12_000) };

  it("idle + cola + pausa: aviso con el tiempo y «Enviar ahora»", () => {
    const s = statusLine({ ...idle, queuePause: pause }, [], [], { now: NOW, queue: [item("queued")] });
    expect(s).toEqual({ tone: "warn", text: "Cola en pausa: esperando confirmación del fin de turno · 12 s", actions: ["sendNow"] });
  });

  it.each([
    ["interrupted", /^Cola en pausa: turno interrumpido.*Enviar ahora.* · 12 s$/],
    ["usageLimit", /^Cola en pausa: límite de uso de Claude.* · 12 s$/],
  ] as const)("el motivo %s se distingue y no dice que espera el fin de turno", (reason, text) => {
    const s = statusLine({ ...idle, queuePause: { reason, since: iso(12_000) } }, [], [], { now: NOW, queue: [item("queued")] });
    expect(s.text).toMatch(text);
    expect(s.text).not.toContain("fin de turno");
    expect(s.tone).toBe("warn");
    expect(s.actions).toEqual(["sendNow"]);
  });

  it("un motivo que el front no conoce sigue avisando de la pausa", () => {
    const unknown = { reason: "otro", since: iso(12_000) } as unknown as NonNullable<SessionInfo["queuePause"]>;
    const s = statusLine({ ...idle, queuePause: unknown }, [], [], { now: NOW, queue: [item("queued")] });
    expect(s.text).toBe("Cola en pausa: motivo no reconocido · 12 s");
    expect(s.actions).toEqual(["sendNow"]);
  });

  it("caso negativo: sin pausa, «Listo» sin acción; con pausa y la cola vacía, también", () => {
    expect(statusLine(idle, [], [], { now: NOW, queue: [item("queued")] })).toEqual({ tone: "idle", text: "Listo", actions: [] });
    expect(statusLine({ ...idle, queuePause: pause }, [], [], { now: NOW, queue: [] }).text).toBe("Listo");
  });

  it("«Enviar ahora» de la línea llama a queueSendNow", async () => {
    const queueSendNow = vi.fn(async () => []);
    const api = { queueSendNow } as unknown as SesionesApi;
    const info = { ...idle, queuePause: pause };
    act(() => {
      store.dispatch({ type: "sessions", sessions: [info] });
      store.dispatch({ type: "queue", id: info.id, items: [item("queued")] });
    });
    render(<ApiContext.Provider value={api}><ChatStatus info={info} /></ApiContext.Provider>);
    expect(screen.getByTestId("chat-status").textContent).toMatch(/Cola en pausa: esperando confirmación/);
    await act(async () => {
      fireEvent.click(screen.getByTestId("status-sendNow"));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(queueSendNow).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// «Recuperar» tras un turno nuevo
// ---------------------------------------------------------------------------

describe("«Recuperar» con un turno nuevo", () => {
  it("no encadena «Salir del menú» ni pinta «reiníciala»", async () => {
    const recover = vi.fn(async () => out(["turn.abort", "turnoNuevo", "turn.abort", "sigueTrabajando"]));
    const api = { recover } as unknown as SesionesApi;
    const info = { ...base, stalled: { reason: "noEvents" as const, since: iso(0), detail: "" } };
    act(() => store.dispatch({ type: "sessions", sessions: [info] }));
    render(<ApiContext.Provider value={api}><ChatStatus info={info} /></ApiContext.Provider>);
    await act(async () => {
      fireEvent.click(screen.getByTestId("status-recover"));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(recover).toHaveBeenCalledTimes(1);
    expect(store.getState().error ?? "").not.toMatch(/reiníciala/);
  });

  it("caso negativo: con un menú abierto, sí intenta salir de él", async () => {
    const recover = vi.fn(async () => out(["esc", "ctrlC", "sigueTrabajando"]));
    const api = { recover } as unknown as SesionesApi;
    const info: SessionInfo = { ...base, screen: "dialog", stalled: { reason: "noEvents", since: iso(0), detail: "" } };
    act(() => store.dispatch({ type: "sessions", sessions: [info] }));
    render(<ApiContext.Provider value={api}><ChatStatus info={info} /></ApiContext.Provider>);
    await act(async () => {
      fireEvent.click(screen.getByTestId("status-recover"));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(recover).toHaveBeenCalledTimes(2);
    expect(recover).toHaveBeenLastCalledWith({ id: "inc1", action: "exitMenu" });
  });
});

// ---------------------------------------------------------------------------
// Herramienta en curso con su tiempo
// ---------------------------------------------------------------------------

const FIND = "find . -maxdepth 4 -name '*.md'";
const toolEvent = (phase: ToolPayload["phase"]): ToolPayload => ({ id: "h1", agentId: null, toolUseId: "tu1", name: "Bash", summary: FIND, phase });
const useMsg: ChatMessage = {
  uuid: "m1", role: "assistant", timestamp: "", agentId: null,
  blocks: [{ kind: "toolUse", id: "tu1", name: "Bash", input: {}, summary: FIND }],
};
const resultMsg: ChatMessage = {
  uuid: "m2", role: "user", timestamp: "", agentId: null, blocks: [{ kind: "toolResult", toolUseId: "tu1", isError: false, text: "ok" }],
};

describe("herramienta del hilo principal en curso", () => {
  it("un toolUse persistido sin su toolResult sigue en la línea con su tiempo", () => {
    let s = reducer(initialState, { type: "tool", payload: toolEvent("start") });
    s = reducer(s, { type: "messages", id: "h1", messages: [useMsg] });
    const running = s.bySession.h1.mainRunning as LiveTool;
    expect(running.toolUseId).toBe("tu1");
    expect(s.bySession.h1.liveTools).toHaveLength(0);
    const at = (running.startedAt ?? 0) + 6 * 60_000 + 12_000;
    const line = statusLine({ ...base, id: "h1" }, [], [], { now: at, mainRunning: running });
    expect(line).toEqual({ tone: "warn", text: "Bash lleva 6 min 12 s: Esc para interrumpir", actions: [] });
  });

  it("antes de 2 min, la frase de la herramienta con su tiempo y lo que espera detrás", () => {
    const running: LiveTool = { toolUseId: "tu1", agentId: null, name: "Bash", summary: "npm test", phase: "start", startedAt: NOW - 45_000 };
    const queue = [item("cliQueued")];
    expect(statusLine(base, [], [], { now: NOW, mainRunning: running, queue }).text).toBe("Ejecutando npm test… · 45 s · 1 en cola tras Bash");
    expect(statusLine(base, [], [], { now: NOW + TOOL_AVISO_MS, mainRunning: running }).tone).toBe("warn");
  });

  it("caso negativo: con su toolResult, su end o el cierre del turno desaparece", () => {
    let s = reducer(initialState, { type: "tool", payload: toolEvent("start") });
    s = reducer(s, { type: "messages", id: "h1", messages: [useMsg, resultMsg] });
    expect(s.bySession.h1.mainRunning).toBeNull();
    s = reducer(reducer(initialState, { type: "tool", payload: toolEvent("start") }), { type: "tool", payload: toolEvent("end") });
    expect(s.bySession.h1.mainRunning).toBeNull();
    s = reducer(initialState, { type: "tool", payload: toolEvent("start") });
    s = reducer(s, { type: "turn", payload: { id: "h1", turnId: "t1", startedAt: "", endedAt: "", durationMs: 0, reason: "aborted" } });
    expect(s.bySession.h1.mainRunning).toBeNull();
  });
});
