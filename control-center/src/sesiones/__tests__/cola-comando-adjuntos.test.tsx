// Encolar con Claude ocupado: un texto que empieza por «/» solo va como `command`
// si es un comando del catálogo sin adjuntos. Una ruta de Git Bash o un comando
// con capturas se encola como `prompt` con sus adjuntos (el backend despacha un
// `command` con CommandRun, que los perdería). Caso negativo: un comando del
// catálogo sin adjuntos sigue yendo por `run_command` y no se encola aquí.

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { FALLBACK_COMMANDS } from "../components/composer/commands";
import type { Attachment } from "../components/composer/useAttachments";
import { useChatSubmit, type SubmitInput } from "../components/composer/useChatSubmit";
import { store } from "../store";
import type { SessionInfo } from "../types";

const info = (id: string): SessionInfo => ({
  id, projectId: "p", projectName: "p", cwd: "C:/p", title: "t", claudeSessionId: `conv-${id}`, status: "working", model: null,
  startedAt: "", bridgeConnected: true, waiting: null, stalled: null, workingSince: null, lastActivityAt: "", turnId: null, screen: "prompt",
  permissionMode: "bypassPermissions", launchPermissionMode: "bypassPermissions", exitCode: null, bridgeProtocol: 2,
});

const shot: Attachment = { path: "C:/tmp/captura.png", previewDataUrl: null, name: "captura.png", mediaType: "image/png" };

function fakeApi() {
  const queueEnqueue = vi.fn(async () => []);
  const runCommand = vi.fn(async () => ({ disposition: "queued" as const }));
  const api = new Proxy({ isMock: true, queueEnqueue, runCommand } as Record<string, unknown>, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (prop === "then") return undefined;
      return async () => [];
    },
  }) as unknown as SesionesApi;
  return { api, queueEnqueue, runCommand };
}

function submitter(id: string) {
  store.dispatch({ type: "sessions", sessions: [info(id)] });
  const fakes = fakeApi();
  const { result } = renderHook(() => useChatSubmit(fakes.api, id, { commands: FALLBACK_COMMANDS, live: true }, () => undefined));
  const submit = async (input: Partial<SubmitInput>) => {
    let ok = false;
    await act(async () => {
      ok = await result.current({ text: "", attachments: [], delegate: false, mode: "auto", ...input });
    });
    return ok;
  };
  return { ...fakes, submit };
}

const enqueued = (fn: ReturnType<typeof vi.fn>) => (fn.mock.calls[0] as unknown as [{ item: { kind: string; attachments: string[]; text: string } }])[0].item;

afterEach(() => store.dispatch({ type: "sessions", sessions: [] }));

describe("cola con Claude ocupado: «/» no siempre es un comando", () => {
  it("una ruta de Git Bash se encola como prompt", async () => {
    const { submit, queueEnqueue, runCommand } = submitter("cq1");
    expect(await submit({ text: "/c/Users/p/notas.md resume esto" })).toBe(true);
    expect(runCommand).not.toHaveBeenCalled();
    expect(enqueued(queueEnqueue)).toMatchObject({ kind: "prompt", text: "/c/Users/p/notas.md resume esto" });
  });

  it("un comando con una captura se encola como prompt y conserva el adjunto", async () => {
    const { submit, queueEnqueue, runCommand } = submitter("cq2");
    expect(await submit({ text: "/cost", attachments: [shot] })).toBe(true);
    expect(runCommand).not.toHaveBeenCalled();
    expect(enqueued(queueEnqueue)).toMatchObject({ kind: "prompt", attachments: [shot.path] });
  });

  it("caso negativo: un comando del catálogo sin adjuntos va por run_command, no por la cola del composer", async () => {
    const { submit, queueEnqueue, runCommand } = submitter("cq3");
    expect(await submit({ text: "/cost" })).toBe(true);
    expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({ id: "cq3", command: "cost" }));
    expect(queueEnqueue).not.toHaveBeenCalled();
  });
});
