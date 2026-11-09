// WP-MOTORES en la UI: Uso no se queda en «Consultando…» (motores-ventanas:F12),
// la terminal escribe por `terminalInput` y nunca por `key`, Ajustes → Sesión
// actual cambia el modo o reinicia en él, y el diálogo de sesión nueva pasa su
// modo de permisos a `create`.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { Motores } from "../components/inspector/Motores";
import { Uso } from "../components/inspector/Uso";
import { usageErrorStore } from "../components/inspector/uso-state";
import { SettingsDialog } from "../components/SettingsDialog";
import { Sidebar } from "../components/Sidebar";
import { ApiContext } from "../context";
import { resetEngineModelsCache } from "../engines";
import { PAST, SESSIONS } from "../mock/data";
import { store } from "../store";
import type { SessionInfo, SessionPrefs } from "../types";

function fakeApi(overrides: Partial<Record<keyof SesionesApi, unknown>>): SesionesApi {
  return new Proxy({ isMock: true } as unknown as SesionesApi, {
    get(target, key: string) {
      if (key in overrides) return overrides[key as keyof SesionesApi];
      if (key in target) return (target as unknown as Record<string, unknown>)[key];
      return () => Promise.reject(new Error(`${key}: no implementado en el test`));
    },
  });
}

const withApi = (api: SesionesApi, node: ReactNode) => <ApiContext.Provider value={api}>{node}</ApiContext.Provider>;
const PREFS: SessionPrefs = { launchPermissionMode: "bypassPermissions", stallSeconds: 120 };

beforeEach(() => resetEngineModelsCache());

describe("Uso", () => {
  afterEach(() => usageErrorStore.dispatch(null));

  it("con el plan fallando muestra el error en vez de la espera", async () => {
    const api = fakeApi({
      usage: () => Promise.reject(new Error("sin red")),
      usagePace: () => Promise.reject(new Error("sin datos del plan")),
    });
    render(withApi(api, <Uso sessionId={null} />));
    expect(await screen.findByText(/No se pudo leer el uso del plan: sin red/)).toBeTruthy();
    expect(screen.getByText(/No se pudo calcular el ritmo/)).toBeTruthy();
    expect(screen.queryByText(/Consultando el uso del plan/)).toBeNull();
  });

  it("Actualizar vuelve a pedir el plan y el ritmo", async () => {
    const usage = vi.fn(async () => ({ fiveHour: null, sevenDay: null, subscriptionType: null, stale: false }));
    const usagePace = vi.fn(async () => ({ windows: [], weekInFiveHourPct: null }));
    render(withApi(fakeApi({ usage, usagePace }), <Uso sessionId={null} />));
    await waitFor(() => expect(usagePace).toHaveBeenCalledTimes(1));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Actualizar" })));
    await waitFor(() => expect(usage).toHaveBeenCalledTimes(2));
    expect(usagePace).toHaveBeenCalledTimes(2);
  });
});

describe("Motores", () => {
  it("«Detectar» fuerza la detección; abrir la pestaña usa la caché (caso negativo)", async () => {
    const engines = vi.fn(async () => []);
    render(withApi(fakeApi({ engines, engineList: async () => [], engineModels: async () => [] }), <Motores session={null} />));
    await waitFor(() => expect(engines).toHaveBeenCalledTimes(1));
    expect(engines).toHaveBeenLastCalledWith({});
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Detectar/ })));
    expect(engines).toHaveBeenLastCalledWith({ force: true });
  });
});

describe("bloque de menú del chat (única vista del PTY)", () => {
  it("escribe con terminalInput y nunca con key", async () => {
    let onData: (d: string) => void = () => undefined;
    vi.doMock("@xterm/xterm", () => ({
      Terminal: class {
        cols = 80;
        rows = 24;
        loadAddon() {}
        open() {}
        write() {}
        focus() {}
        dispose() {}
        onData(cb: (d: string) => void) {
          onData = cb;
          return { dispose() {} };
        }
        onWriteParsed() {
          return { dispose() {} };
        }
      },
    }));
    vi.resetModules();
    const { MenuBlock } = await import("../components/chat/SessionCards");
    const { ApiContext: Ctx } = await import("../context");
    const terminalInput = vi.fn(async () => undefined);
    const key = vi.fn(async () => undefined);
    const api = fakeApi({
      terminalInput, key,
      terminalAttach: async () => "",
      terminalDetach: async () => undefined,
      onPty: async () => () => undefined,
    });
    const info = { ...SESSIONS[0], id: "s1", status: "waiting" as const, waiting: { kind: "menu" as const, label: "/config", since: "" } };
    render(<Ctx.Provider value={api}><MenuBlock info={info} /></Ctx.Provider>);
    act(() => onData("\x1b[B"));
    expect(terminalInput).toHaveBeenCalledWith({ id: "s1", data: "\x1b[B" });
    expect(key).not.toHaveBeenCalled();
    vi.doUnmock("@xterm/xterm");
  });
});

function withSession(patch: Partial<SessionInfo>): SessionInfo {
  const s = { ...SESSIONS[0], ...patch };
  store.dispatch({ type: "sessions", sessions: [s] });
  return s;
}

function settingsApi(extra: Partial<Record<keyof SesionesApi, unknown>>) {
  return fakeApi({ prefsGet: async () => PREFS, engineModels: async () => [], ...extra });
}

describe("Ajustes → Sesión actual", () => {
  it("elegir Preguntar en una sesión en bypass llama a setPermissionMode", async () => {
    const s = withSession({ permissionMode: "bypassPermissions" });
    const setPermissionMode = vi.fn(async () => ({ ok: true }));
    render(withApi(settingsApi({ setPermissionMode }), <SettingsDialog onClose={() => undefined} sessionId={s.id} />));
    fireEvent.click(screen.getByTestId("current-permission-mode"));
    await act(async () => fireEvent.click(screen.getByRole("option", { name: /Preguntar/ })));
    expect(setPermissionMode).toHaveBeenCalledWith({ id: s.id, mode: "default" });
  });

  it("si el modo está fuera del ciclo ofrece reiniciar en él", async () => {
    const s = withSession({ permissionMode: "acceptEdits" });
    const setPermissionMode = vi.fn(async () => {
      throw new Error("bypassPermissions está fuera del ciclo de Shift+Tab de esta sesión");
    });
    const recover = vi.fn(async () => ({ ok: true, action: "restart", steps: [], status: "starting" }));
    render(withApi(settingsApi({ setPermissionMode, recover }), <SettingsDialog onClose={() => undefined} sessionId={s.id} />));
    fireEvent.click(screen.getByTestId("current-permission-mode"));
    await act(async () => fireEvent.click(screen.getByRole("option", { name: /Sin permisos/ })));
    const restart = await screen.findByRole("button", { name: /Reiniciar en Sin permisos/ });
    await act(async () => fireEvent.click(restart));
    expect(recover).toHaveBeenCalledWith({ id: s.id, action: "restart", opts: { permissionMode: "bypassPermissions" } });
  });

  it("Motores aparece en Ajustes sin cambiar el destino del composer", async () => {
    render(withApi(settingsApi({}), <SettingsDialog onClose={() => undefined} />));
    expect(screen.getByTestId("engine-model-codex")).toBeTruthy();
    expect(screen.getByTestId("engine-model-gemini")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("launch-permission-mode")).toBeTruthy());
  });
});

describe("Sesión nueva con modo de permisos", () => {
  async function createWith(choose?: string) {
    withSession({});
    const create = vi.fn(async (args: { permissionMode?: string }) => ({ ...SESSIONS[0], id: "nueva", ...args }));
    const api = fakeApi({ create, projects: async () => [], prefsGet: async () => PREFS });
    render(withApi(api, <Sidebar onPicked={() => undefined} />));
    fireEvent.click(screen.getByRole("button", { name: /\+ Claude/ }));
    const group = await screen.findByTestId("new-session-permission-mode");
    expect(group.querySelector("[aria-checked='true']")?.textContent).toBe("Bypass");
    if (choose) fireEvent.click(screen.getByRole("radio", { name: choose }));
    await act(async () => fireEvent.click(screen.getByRole("option", { name: /Aquí/ })));
    await waitFor(() => expect(create).toHaveBeenCalled());
    return create.mock.calls[0][0];
  }

  it("con acceptEdits, create recibe ese modo", async () => {
    expect((await createWith("Ediciones")).permissionMode).toBe("acceptEdits");
  });

  it("sin tocarlo, create recibe el de SessionPrefs", async () => {
    expect((await createWith()).permissionMode).toBe("bypassPermissions");
  });

  it("«Retomar conversación» lanza --resume en el directorio de esa conversación", async () => {
    withSession({});
    const create = vi.fn(async (args: object) => ({ ...SESSIONS[0], id: "retomada", ...args }));
    const past = vi.fn(async () => PAST);
    render(withApi(fakeApi({ create, past, projects: async () => [], prefsGet: async () => PREFS }), <Sidebar onPicked={() => undefined} />));
    fireEvent.click(screen.getByRole("button", { name: /\+ Claude/ }));
    const opt = await screen.findByRole("option", { name: /Build rota de Explored/ });
    expect(past).toHaveBeenCalledWith(undefined, 6);
    await act(async () => fireEvent.click(opt));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0]).toMatchObject({ cwd: PAST[1].cwd, resume: "p-2" });
  });
});
