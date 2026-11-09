// Envío con destino motor (Codex, Gemini): los adjuntos viajan al motor, Codex
// cloud los rechaza sin borrar el borrador, un `/comando` de Claude no se manda
// como texto y el dictado rellena el composer igual que con destino Claude.

import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { Composer } from "../components/composer/Composer";
import { engineSlashKind } from "../components/composer/composer-handlers";
import { FALLBACK_COMMANDS } from "../components/composer/commands";
import { clearDrafts, saveDraft } from "../components/composer/drafts";
import { ApiContext } from "../context";
import { store } from "../store";
import type { SendTarget, SessionInfo } from "../types";
import type { Attachment } from "../components/composer/useAttachments";

const dictation = vi.hoisted(() => ({ onText: null as ((t: string) => void) | null, toggle: vi.fn() }));

vi.mock("../components/composer/useDictation", async (importOriginal) => {
  const real = await importOriginal<typeof import("../components/composer/useDictation")>();
  return {
    ...real,
    useDictation: (onText: (t: string) => void) => {
      dictation.onText = onText;
      return { status: "off", pending: 0, toggle: dictation.toggle, stop: vi.fn() };
    },
  };
});

const base: SessionInfo = {
  id: "s1", projectId: "p", projectName: "p", cwd: "C:/p", title: "t", claudeSessionId: "c", status: "idle", model: "claude-opus-5-5",
  startedAt: "", bridgeConnected: false, waiting: null, stalled: null, workingSince: null, lastActivityAt: "", turnId: null, screen: "prompt",
  permissionMode: "default", launchPermissionMode: "default", exitCode: null, bridgeProtocol: 2,
};

const TASK = { id: "t1", engine: "gemini", kind: "task", mode: "local", status: "running", prompt: "x", events: [], startedAt: "", sessionId: "s1" };
const DEFAULTS: Record<string, unknown> = { promptHistory: [], listFiles: [], commands: FALLBACK_COMMANDS, engineModels: [], engineRun: TASK };

function fakeApi(): { api: SesionesApi; fn: (name: string) => ReturnType<typeof vi.fn> } {
  const fns = new Map<string, ReturnType<typeof vi.fn>>();
  const fn = (prop: string) => {
    if (!fns.has(prop)) fns.set(prop, vi.fn().mockResolvedValue(DEFAULTS[prop]));
    return fns.get(prop) as ReturnType<typeof vi.fn>;
  };
  const api = new Proxy({ isMock: true }, {
    get(target, prop: string) {
      if (prop in target) return (target as Record<string, unknown>)[prop];
      return fn(prop);
    },
  }) as SesionesApi;
  return { api, fn };
}

const IMG: Attachment = { path: "C:/p/captura.png", previewDataUrl: null, name: "captura.png", mediaType: "image/png" };
const DOC: Attachment = { path: "C:/p/notas.md", previewDataUrl: null, name: "notas.md", mediaType: "text/markdown" };

function mount(target: SendTarget, text: string, attachments: Attachment[] = []) {
  saveDraft("s1", { text, attachments, target, delegate: false });
  act(() => store.dispatch({ type: "sessions", sessions: [base] }));
  const f = fakeApi();
  const view = render(<ApiContext.Provider value={f.api}><Composer sessionId="s1" /></ApiContext.Provider>);
  const ta = view.container.querySelector("textarea") as HTMLTextAreaElement;
  return { ...f, ta };
}

async function pressEnter(ta: HTMLTextAreaElement) {
  await act(async () => {
    fireEvent.keyDown(ta, { key: "Enter", code: "Enter" });
  });
}

function notes(): string[] {
  const s = store.getState().bySession.s1 as unknown as { notes?: { text: string }[] } | undefined;
  return (s?.notes ?? []).map((n) => n.text);
}

beforeEach(() => {
  clearDrafts();
  dictation.onText = null;
  dictation.toggle.mockClear();
  store.dispatch({ type: "reset", id: "s1" });
});

describe("envío con destino motor", () => {
  it("Codex local recibe las rutas de los adjuntos y el borrador se vacía", async () => {
    const { fn, ta } = mount("codexLocal", "revisa esto", [IMG, DOC]);
    await pressEnter(ta);
    expect(fn("engineRun")).toHaveBeenCalledTimes(1);
    expect(fn("engineRun").mock.calls[0][0]).toMatchObject({ engine: "codex", mode: "local", attachments: [IMG.path, DOC.path] });
    expect(ta.value).toBe("");
  });

  it("sin adjuntos no manda el campo", async () => {
    const { fn, ta } = mount("gemini", "haz X");
    await pressEnter(ta);
    expect(fn("engineRun").mock.calls[0][0]).not.toHaveProperty("attachments");
  });

  it("Codex cloud con adjuntos no envía y conserva el borrador", async () => {
    const { fn, ta } = mount("codexCloud", "revisa esto", [IMG]);
    await pressEnter(ta);
    expect(fn("engineRun")).not.toHaveBeenCalled();
    expect(ta.value).toBe("revisa esto");
  });

  it("un /comando de Claude con destino motor avisa y no se manda", async () => {
    const { fn, ta } = mount("gemini", "/compact");
    await pressEnter(ta);
    expect(fn("engineRun")).not.toHaveBeenCalled();
    expect(fn("runCommand")).not.toHaveBeenCalled();
    expect(ta.value).toBe("/compact");
    expect(notes().some((t) => t.includes("no se aplican a Gemini"))).toBe(true);
  });

  it("clasifica los /comandos: Claude, propios de Sessions y texto", () => {
    expect(engineSlashKind("/compact", FALLBACK_COMMANDS)).toBe("claude");
    expect(engineSlashKind("/segunda-opinion on", FALLBACK_COMMANDS)).toBe("sessions");
    expect(engineSlashKind("haz /esto", FALLBACK_COMMANDS)).toBe("text");
    // Locales del contrato: se ejecutan igual que con destino Claude.
    expect(engineSlashKind("/compilar", FALLBACK_COMMANDS)).toBe("sessions");
    expect(engineSlashKind("/probar", FALLBACK_COMMANDS)).toBe("sessions");
    expect(engineSlashKind("!git status", FALLBACK_COMMANDS)).toBe("sessions");
  });

  it("el dictado rellena el composer con destino motor y se envía al motor", async () => {
    const { fn, ta } = mount("gemini", "");
    await act(async () => {
      fireEvent.keyDown(ta, { key: " ", code: "Space", ctrlKey: true });
    });
    expect(dictation.toggle).toHaveBeenCalledTimes(1);
    act(() => dictation.onText?.("refactoriza el parser"));
    expect(ta.value).toBe("refactoriza el parser");
    await pressEnter(ta);
    expect(fn("engineRun").mock.calls[0][0]).toMatchObject({ engine: "gemini", prompt: "refactoriza el parser" });
  });
});
