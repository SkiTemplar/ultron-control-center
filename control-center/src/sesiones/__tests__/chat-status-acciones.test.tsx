// Acciones nuevas de la línea de estado: «Soltar la terminal» (#31) actúa sobre
// el PTY y «Reiniciar sesión» en un arranque vencido (#32) llama a recover.
// Ningún botón puede quedarse en un no-op.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { ChatStatus } from "../components/chat/ChatStatus";
import { NEW_CONVERSATION_TEXT, recoverNote } from "../components/composer/recover-note";
import { ApiContext } from "../context";
import { store } from "../store";
import type { QueueItem, SessionInfo } from "../types";

const base: SessionInfo = {
  id: "cs1", projectId: "p", projectName: "p", cwd: "C:/p", title: "t", claudeSessionId: "c", status: "idle", model: null,
  startedAt: "", bridgeConnected: true, waiting: null, stalled: null, workingSince: null, lastActivityAt: "", turnId: null, screen: "prompt",
  permissionMode: "bypassPermissions", launchPermissionMode: "bypassPermissions", exitCode: null, bridgeProtocol: 2,
};

const queued: QueueItem = {
  clientId: "q1", text: "x", attachments: [], delegate: false, kind: "prompt", origin: "ultron", state: "queued", createdAt: "2026-10-14T10:00:00.000Z",
};

function fakeApi() {
  const calls: string[] = [];
  const record = (name: string, value: unknown) => vi.fn(async () => {
    calls.push(name);
    return value;
  });
  const api = {
    terminalRestoreSize: record("terminalRestoreSize", undefined),
    terminalDetach: record("terminalDetach", undefined),
    recover: record("recover", { ok: true, action: "restart", steps: ["restart"], status: "starting" }),
    background: record("background", { ok: true, toolUseId: "t1", tool: "Bash", evidence: "toolEnd", steps: ["pista", "ctrlB", "toolEnd"] }),
  } as unknown as SesionesApi;
  return { api, calls };
}

async function mount(info: SessionInfo, items: QueueItem[] = []) {
  act(() => {
    store.dispatch({ type: "sessions", sessions: [info] });
    store.dispatch({ type: "queue", id: info.id, items });
  });
  const fake = fakeApi();
  render(<ApiContext.Provider value={fake.api}><ChatStatus info={info} /></ApiContext.Provider>);
  return fake;
}

async function click(testId: string) {
  await act(async () => {
    fireEvent.click(screen.getByTestId(testId));
    await new Promise((r) => setTimeout(r, 0));
  });
}

afterEach(() => cleanup());

describe("acciones de la línea de estado", () => {
  it("#31: «Soltar la terminal» restaura el tamaño y suelta la terminal, en ese orden", async () => {
    const { calls } = await mount({ ...base, terminalAttached: true }, [queued]);
    expect(screen.getByTestId("chat-status").textContent).toMatch(/Cola en pausa/);
    await click("status-releaseTerminal");
    expect(calls).toEqual(["terminalRestoreSize", "terminalDetach"]);
  });

  it("«Soltar la terminal» suelta aunque falle la restauración del tamaño (y lo notifica)", async () => {
    const { api, calls } = await mount({ ...base, terminalAttached: true }, [queued]);
    vi.mocked(api.terminalRestoreSize).mockRejectedValueOnce(new Error("resize rechazado"));
    await click("status-releaseTerminal");
    expect(api.terminalDetach).toHaveBeenCalledWith("cs1");
    expect(calls).toContain("terminalDetach");
    expect(store.getState().error).toMatch(/resize rechazado/);
  });

  it("un reinicio que abre una conversación nueva (sin transcript) deja una nota warn", async () => {
    const stalled = { reason: "startupTimeout" as const, since: "", detail: "x" };
    const { api } = await mount({ ...base, status: "starting", stalled });
    vi.mocked(api.recover).mockResolvedValueOnce({
      ok: true, action: "restart", steps: ["kill", "sinTranscriptConversacionNueva", "spawn"], status: "starting",
    });
    await click("status-restart");
    const notes = store.getState().bySession.cs1?.notes ?? [];
    expect(notes[notes.length - 1]).toMatchObject({ level: "warn", text: NEW_CONVERSATION_TEXT });
  });

  it("caso negativo: un reinicio que retoma la conversación no deja nota", () => {
    expect(recoverNote({ ok: true, action: "restart", steps: ["kill", "spawn"], status: "starting" })).toBeNull();
  });

  it("caso negativo: sin terminal enganchada no aparece el botón", async () => {
    await mount(base, [queued]);
    expect(screen.queryByTestId("status-releaseTerminal")).toBeNull();
  });

  it("§3.4: «Segundo plano» con un Bash en primer plano llama a background y confirma", async () => {
    const foregroundTool = { toolUseId: "t1", name: "Bash", since: new Date().toISOString(), backgroundable: true };
    const { api, calls } = await mount({ ...base, id: "cs2", status: "working", foregroundTool });
    expect(screen.getByTestId("status-background").title).toMatch(/Ctrl\+B/);
    await click("status-background");
    expect(calls).toEqual(["background"]);
    expect(api.background).toHaveBeenCalledWith({ id: "cs2" });
    const notes = store.getState().bySession.cs2?.notes ?? [];
    expect(notes[notes.length - 1]).toMatchObject({ level: "info" });
  });

  it("§3.4: un «Segundo plano» sin confirmar deja una nota de error con el motivo", async () => {
    const foregroundTool = { toolUseId: "t1", name: "Bash", since: new Date().toISOString(), backgroundable: true };
    const { api } = await mount({ ...base, id: "cs3", status: "working", foregroundTool });
    vi.mocked(api.background).mockResolvedValueOnce({
      ok: false, toolUseId: "t1", tool: "Bash", evidence: "none", steps: ["sinPista", "ctrlB", "sinCierre"], reason: "Claude Code no confirmó el paso a segundo plano en 3 s",
    });
    await click("status-background");
    const notes = store.getState().bySession.cs3?.notes ?? [];
    expect(notes[notes.length - 1]).toMatchObject({ level: "error", text: expect.stringMatching(/no confirmó el paso a segundo plano/) });
  });

  it("caso negativo: con una herramienta que no se mueve (Read) no hay botón «Segundo plano»", async () => {
    const foregroundTool = { toolUseId: "t2", name: "Read", since: new Date().toISOString(), backgroundable: false };
    await mount({ ...base, id: "cs4", status: "working", foregroundTool });
    expect(screen.queryByTestId("status-background")).toBeNull();
    // Interrumpir vive solo en el composer: la línea de estado no lo repite.
    expect(screen.queryByTestId("status-interrupt")).toBeNull();
  });

  it("#32: un arranque vencido ofrece Reiniciar y llama a recover(restart)", async () => {
    const stalled = { reason: "startupTimeout" as const, since: "", detail: "Claude no ha llegado al prompt en 30 s (pantalla: unknown)" };
    const { api, calls } = await mount({ ...base, status: "starting", stalled });
    await click("status-restart");
    expect(calls).toEqual(["recover"]);
    expect(api.recover).toHaveBeenCalledWith({ id: "cs1", action: "restart" });
  });
});
