// M5: borradores del composer y continuaciones pendientes sobreviven a una
// recarga de la página (la que sigue a una caída del renderer). La recarga se
// simula volviendo a evaluar el módulo (`vi.resetModules` + import dinámico),
// que lee `sessionStorage` como lo haría la página nueva.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { Composer } from "../components/composer/Composer";
import { FALLBACK_COMMANDS } from "../components/composer/commands";
import { CONTINUATIONS_STORAGE_KEY, clearContinuations, continuationStore, offerContinuation, parseStoredContinuations } from "../components/composer/continuation";
import { DRAFTS_STORAGE_KEY, PERSIST_DELAY_MS, clearDrafts, flushDrafts, parseStoredDrafts, saveDraft, type ComposerDraft } from "../components/composer/drafts";
import { ApiContext } from "../context";
import { store } from "../store";
import type { SessionInfo } from "../types";

const base: SessionInfo = {
  id: "s1", projectId: "p", projectName: "p", cwd: "C:/p", title: "t", claudeSessionId: "c", status: "starting", model: "claude-opus-5-5",
  startedAt: "", bridgeConnected: false, waiting: null, stalled: null, workingSince: null, lastActivityAt: "", turnId: null, screen: "prompt",
  permissionMode: "default", launchPermissionMode: "default", exitCode: null, bridgeProtocol: 2,
};

const DEFAULTS: Record<string, unknown> = {
  promptHistory: [], listFiles: [], commands: FALLBACK_COMMANDS, queueEnqueue: [], engineModels: [],
  send: { clientId: "x", disposition: "written" }, runCommand: { disposition: "written" },
};

function fakeApi(): SesionesApi {
  const fns = new Map<string, ReturnType<typeof vi.fn>>();
  return new Proxy({ isMock: true }, {
    get(target, prop: string) {
      if (prop in target) return (target as Record<string, unknown>)[prop];
      if (!fns.has(prop)) fns.set(prop, prop === "gitSnapshot" ? vi.fn().mockRejectedValue(new Error("sin git")) : vi.fn().mockResolvedValue(DEFAULTS[prop]));
      return fns.get(prop);
    },
  }) as unknown as SesionesApi;
}

function mount(): HTMLTextAreaElement {
  act(() => store.dispatch({ type: "sessions", sessions: [base] }));
  render(<ApiContext.Provider value={fakeApi()}><Composer sessionId="s1" /></ApiContext.Provider>);
  return screen.getByRole("textbox", { name: "Mensaje" }) as HTMLTextAreaElement;
}

const draft = (text: string, extra: Partial<ComposerDraft> = {}): ComposerDraft => ({ text, attachments: [], target: "claude", delegate: false, ...extra });

/** Módulo recién evaluado, como tras recargar la página. */
async function reloaded<T>(path: string): Promise<T> {
  vi.resetModules();
  return (await import(path)) as T;
}

beforeEach(() => {
  clearDrafts();
  clearContinuations();
  store.dispatch({ type: "reset", id: "s1" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("borradores en sessionStorage", () => {
  it("se copian tras el debounce y una recarga los restaura", async () => {
    vi.useFakeTimers();
    saveDraft("s1", draft("a medias", { target: "codexLocal", delegate: true }));
    expect(window.sessionStorage.getItem(DRAFTS_STORAGE_KEY)).toBeNull();
    vi.advanceTimersByTime(PERSIST_DELAY_MS);
    expect(window.sessionStorage.getItem(DRAFTS_STORAGE_KEY)).toContain("a medias");
    const m = await reloaded<typeof import("../components/composer/drafts")>("../components/composer/drafts");
    expect(m.readDraft("s1")).toEqual(draft("a medias", { target: "codexLocal", delegate: true }));
  });

  it("caso negativo: un borrador vaciado desaparece también del almacenamiento", async () => {
    saveDraft("s1", draft("algo"));
    flushDrafts();
    saveDraft("s1", draft(""));
    flushDrafts();
    expect(window.sessionStorage.getItem(DRAFTS_STORAGE_KEY)).toBeNull();
    const m = await reloaded<typeof import("../components/composer/drafts")>("../components/composer/drafts");
    expect(m.readDraft("s1")).toBeNull();
  });

  it("lo escrito en el composer se guarda sin desmontarlo", () => {
    vi.useFakeTimers();
    const box = mount();
    fireEvent.change(box, { target: { value: "texto sin enviar" } });
    act(() => vi.advanceTimersByTime(PERSIST_DELAY_MS));
    expect(parseStoredDrafts(window.sessionStorage.getItem(DRAFTS_STORAGE_KEY)).get("s1")?.text).toBe("texto sin enviar");
  });

  it("sin cuota para las vistas previas, guarda el adjunto sin ellas", () => {
    const real = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k: string, v: string) {
      if (v.includes("data:image")) throw new DOMException("cuota", "QuotaExceededError");
      real.call(this, k, v);
    });
    const att = { path: "C:/tmp/a.png", previewDataUrl: "data:image/png;base64,AAAA", name: "a.png", mediaType: "image/png" };
    saveDraft("s1", draft("con imagen", { attachments: [att] }));
    expect(flushDrafts()).toBe(true);
    const restored = parseStoredDrafts(window.sessionStorage.getItem(DRAFTS_STORAGE_KEY)).get("s1");
    expect(restored?.attachments).toEqual([{ ...att, previewDataUrl: null }]);
  });

  it("lo mal formado se descarta entrada a entrada", () => {
    expect(parseStoredDrafts("no es json").size).toBe(0);
    const raw = JSON.stringify({ ok: draft("vale"), malo: { text: 1 }, destino: draft("x", { target: "otro" as never }) });
    expect([...parseStoredDrafts(raw).keys()]).toEqual(["ok"]);
  });
});

describe("continuaciones pendientes en sessionStorage", () => {
  const CONT = "La sesión se cortó a mitad de turno al cerrar ULTRON.";

  it("una recarga antes de colocarla no la pierde", async () => {
    offerContinuation("s1", CONT);
    expect(parseStoredContinuations(window.sessionStorage.getItem(CONTINUATIONS_STORAGE_KEY))).toEqual({ s1: CONT });
    const m = await reloaded<typeof import("../components/composer/continuation")>("../components/composer/continuation");
    expect(m.continuationStore.getState()).toEqual({ s1: CONT });
  });

  it("colocada en la caja, sale de pendientes y queda en el borrador guardado", async () => {
    offerContinuation("s1", CONT);
    const box = mount();
    expect(box.value).toBe(CONT);
    expect(continuationStore.getState().s1).toBeUndefined();
    expect(window.sessionStorage.getItem(CONTINUATIONS_STORAGE_KEY)).toBeNull();
    const m = await reloaded<typeof import("../components/composer/drafts")>("../components/composer/drafts");
    expect(m.readDraft("s1")?.text).toBe(CONT);
  });

  it("sin cuota para el borrador, la continuación sigue pendiente y sobrevive a una recarga", async () => {
    offerContinuation("s1", CONT);
    const real = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k: string, v: string) {
      if (k === DRAFTS_STORAGE_KEY) throw new DOMException("cuota", "QuotaExceededError");
      real.call(this, k, v);
    });
    const box = mount();
    expect(box.value).toBe(CONT);
    expect(continuationStore.getState().s1).toBe(CONT);
    expect(parseStoredContinuations(window.sessionStorage.getItem(CONTINUATIONS_STORAGE_KEY))).toEqual({ s1: CONT });

    // Con cuota de nuevo, el siguiente cambio de la caja guarda el borrador y la retira.
    vi.restoreAllMocks();
    fireEvent.change(box, { target: { value: `${CONT} x` } });
    expect(continuationStore.getState().s1).toBeUndefined();
    expect(parseStoredDrafts(window.sessionStorage.getItem(DRAFTS_STORAGE_KEY)).get("s1")?.text).toContain(CONT);

    const m = await reloaded<typeof import("../components/composer/continuation")>("../components/composer/continuation");
    expect(m.continuationStore.getState()).toEqual({});
  });

  it("sin cuota, una recarga antes de liberarla conserva la continuación", async () => {
    offerContinuation("s1", CONT);
    const real = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k: string, v: string) {
      if (k === DRAFTS_STORAGE_KEY) throw new DOMException("cuota", "QuotaExceededError");
      real.call(this, k, v);
    });
    mount();
    const m = await reloaded<typeof import("../components/composer/continuation")>("../components/composer/continuation");
    expect(m.continuationStore.getState()).toEqual({ s1: CONT });
  });

  it("solo textos no vacíos y JSON válido", () => {
    expect(parseStoredContinuations("{")).toEqual({});
    expect(parseStoredContinuations(JSON.stringify({ a: "x", b: "  ", c: 3 }))).toEqual({ a: "x" });
  });
});
