import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { Composer } from "../components/composer/Composer";
import { FALLBACK_COMMANDS } from "../components/composer/commands";
import {
  CONTINUATION_UNSAVED_NOTICE,
  MAX_FLUSH_FAILURES,
  clearContinuations,
  continuationStore,
  mergeContinuation,
  offerContinuation,
} from "../components/composer/continuation";
import { clearDrafts, saveDraft } from "../components/composer/drafts";
import { ApiContext } from "../context";
import { store } from "../store";
import type { SessionInfo } from "../types";

const CONT = "La sesión se cortó a mitad de turno al cerrar ULTRON.\nAntes de seguir, revisa el estado real con `git status`.";

const base: SessionInfo = {
  id: "s1", projectId: "p", projectName: "p", cwd: "C:/p", title: "t", claudeSessionId: "c", status: "starting", model: "claude-opus-5-5",
  startedAt: "", bridgeConnected: false, waiting: null, stalled: null, workingSince: null, lastActivityAt: "", turnId: null, screen: "prompt",
  permissionMode: "default", launchPermissionMode: "default", exitCode: null, bridgeProtocol: 2,
};

const DEFAULTS: Record<string, unknown> = {
  promptHistory: [], listFiles: [], commands: FALLBACK_COMMANDS, queueEnqueue: [], engineModels: [],
  send: { clientId: "x", disposition: "written" }, runCommand: { disposition: "written" },
};

function fakeApi(): SesionesApi & Record<string, ReturnType<typeof vi.fn>> {
  const fns = new Map<string, ReturnType<typeof vi.fn>>();
  return new Proxy({ isMock: true }, {
    get(target, prop: string) {
      if (prop in target) return (target as Record<string, unknown>)[prop];
      if (!fns.has(prop)) {
        fns.set(prop, prop === "gitSnapshot" ? vi.fn().mockRejectedValue(new Error("sin git")) : vi.fn().mockResolvedValue(DEFAULTS[prop]));
      }
      return fns.get(prop);
    },
  }) as SesionesApi & Record<string, ReturnType<typeof vi.fn>>;
}

function mount() {
  const api = fakeApi();
  act(() => store.dispatch({ type: "sessions", sessions: [base] }));
  render(<ApiContext.Provider value={api}><Composer sessionId="s1" /></ApiContext.Provider>);
  const box = screen.getByRole("textbox", { name: "Mensaje" }) as HTMLTextAreaElement;
  return { api, box };
}

function expectNothingSent(api: Record<string, ReturnType<typeof vi.fn>>) {
  expect(api.send).not.toHaveBeenCalled();
  expect(api.queueEnqueue).not.toHaveBeenCalled();
  expect(api.runCommand).not.toHaveBeenCalled();
}

beforeEach(() => {
  clearDrafts();
  clearContinuations();
  store.dispatch({ type: "reset", id: "s1" });
});

describe("continuación tras cerrar a mitad de turno", () => {
  it("mergeContinuation: caja vacía, borrador previo y sin duplicar", () => {
    expect(mergeContinuation("", CONT)).toBe(CONT);
    expect(mergeContinuation("  \n", CONT)).toBe(CONT);
    expect(mergeContinuation("mi borrador\n", CONT)).toBe(`mi borrador\n\n${CONT}`);
    expect(mergeContinuation(`mi borrador\n\n${CONT}`, CONT)).toBe(`mi borrador\n\n${CONT}`);
  });

  it("llega antes de montar el composer: queda en la caja sin enviarse", () => {
    offerContinuation("s1", CONT);
    const { api, box } = mount();
    expect(box.value).toBe(CONT);
    expect(continuationStore.getState().s1).toBeUndefined();
    expectNothingSent(api);
  });

  it("no pisa un borrador existente: la continuación va debajo", () => {
    saveDraft("s1", { text: "lo que estaba escribiendo", attachments: [], target: "claude", delegate: false });
    offerContinuation("s1", CONT);
    const { api, box } = mount();
    expect(box.value).toBe(`lo que estaba escribiendo\n\n${CONT}`);
    expectNothingSent(api);
  });

  it("llega con el composer montado y con texto escrito: se añade debajo, sin enviar", () => {
    saveDraft("s1", { text: "a medias", attachments: [], target: "claude", delegate: false });
    const { api, box } = mount();
    expect(box.value).toBe("a medias");
    act(() => offerContinuation("s1", CONT));
    expect(box.value).toBe(`a medias\n\n${CONT}`);
    expectNothingSent(api);
  });

  it("la continuación de otra sesión o vacía no toca esta caja", () => {
    offerContinuation("s2", CONT);
    offerContinuation("s1", "   ");
    const { box } = mount();
    expect(box.value).toBe("");
    expect(continuationStore.getState().s2).toBe(CONT);
  });
});

describe("continuación sin sessionStorage utilizable", () => {
  afterEach(() => vi.restoreAllMocks());

  function storageFull() {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
  }

  it("si el borrador no se puede guardar varias veces, se retira con aviso visible", () => {
    storageFull();
    offerContinuation("s1", CONT);
    const { box } = mount();
    expect(box.value).toBe(CONT);
    for (let i = 1; i < MAX_FLUSH_FAILURES; i += 1) fireEvent.change(box, { target: { value: `${CONT}${"!".repeat(i)}` } });
    expect(continuationStore.getState().s1).toBeUndefined();
    expect(store.getState().error).toBe(CONTINUATION_UNSAVED_NOTICE);
  });

  it("enviada o borrada tras un fallo de guardado, no vuelve al remontar el composer", () => {
    storageFull();
    offerContinuation("s1", CONT);
    const { box } = mount();
    fireEvent.change(box, { target: { value: "" } });
    expect(continuationStore.getState().s1).toBeUndefined();
    vi.restoreAllMocks();
    cleanup();
    expect(mount().box.value).toBe("");
  });
});
