import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { Composer } from "../components/composer/Composer";
import { FALLBACK_COMMANDS } from "../components/composer/commands";
import { clearDrafts } from "../components/composer/drafts";
import { ApiContext } from "../context";
import { store } from "../store";
import type { SessionInfo } from "../types";

const base: SessionInfo = {
  id: "s1", projectId: "p", projectName: "p", cwd: "C:/p", title: "t", claudeSessionId: "c", status: "idle", model: "claude-opus-5-5",
  startedAt: "", bridgeConnected: true, waiting: null, stalled: null, workingSince: null, lastActivityAt: "", turnId: null, screen: "prompt",
  permissionMode: "bypassPermissions", launchPermissionMode: "bypassPermissions", exitCode: null, bridgeProtocol: 2,
};

const DEFAULTS: Record<string, unknown> = {
  promptHistory: [], commands: FALLBACK_COMMANDS, engineModels: [],
  settings: { model: null, effort: "high", permissionMode: null, socratic: null, projectId: "p", launchPermissionMode: "bypassPermissions" },
};

function fakeApi(overrides: Record<string, unknown> = {}): SesionesApi {
  const fns = new Map<string, unknown>();
  return new Proxy({ isMock: true }, {
    get(target, prop: string) {
      if (prop in target) return (target as Record<string, unknown>)[prop];
      if (!fns.has(prop)) fns.set(prop, prop in overrides ? overrides[prop] : vi.fn().mockResolvedValue(DEFAULTS[prop]));
      return fns.get(prop);
    },
  }) as SesionesApi;
}

function setup(cwd: string, overrides: Record<string, unknown> = {}) {
  act(() => store.dispatch({ type: "sessions", sessions: [{ ...base, cwd }] }));
  const view = render(<ApiContext.Provider value={fakeApi(overrides)}><Composer sessionId="s1" /></ApiContext.Provider>);
  return { view, box: screen.getByRole("textbox", { name: "Mensaje" }) };
}

async function typeAt(box: HTMLElement) {
  await act(async () => {
    fireEvent.change(box, { target: { value: "mira @", selectionStart: 6 } });
    await Promise.resolve();
  });
}

// El composer recupera el borrador de la sesión al remontarse: cada test parte de uno vacío.
beforeEach(() => clearDrafts());

describe("autocompletado @ con sesiones_files", () => {
  it("lista los ficheros del proyecto que devuelve listFiles", async () => {
    const listFiles = vi.fn().mockResolvedValue(["src/main.ts", "README.md"]);
    const { box } = setup("C:/files-ok", { listFiles });
    await typeAt(box);
    expect(listFiles).toHaveBeenCalledWith("C:/files-ok");
    expect(await screen.findByRole("option", { name: /main\.ts/ })).toBeTruthy();
    expect(screen.queryByTestId("files-note")).toBeNull();
  });

  it("si sesiones_files falla, avisa en el desplegable en vez de quedarse vacío (caso negativo)", async () => {
    const listFiles = vi.fn().mockRejectedValue(new Error("sin permiso"));
    const { box } = setup("C:/files-ko", { listFiles });
    await typeAt(box);
    expect((await screen.findByTestId("files-note")).textContent).toMatch(/No se pudo listar los ficheros del proyecto: sin permiso/);
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });
});

describe("barra del composer (req. 19)", () => {
  it("una sola barra, sin botones «Fichero» ni «Historial», con Adjuntar, Comandos, Voz y Enviar", () => {
    const { view } = setup("C:/barra");
    const bars = view.container.querySelectorAll(".cbar");
    expect(bars).toHaveLength(1);
    const labels = [...bars[0].querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(labels.some((l) => /Fichero|Historial/.test(l))).toBe(false);
    for (const name of [/Adjuntar/, /Comandos/, /Voz/, /Enviar/]) expect(labels.some((l) => name.test(l))).toBe(true);
  });
});
