// HUD: elegir un modo de permisos fuera del ciclo de Shift+Tab deja un aviso visible
// con «Reiniciar en…» (antes vivía dentro del desplegable, que se cierra al elegir).
// Caso negativo: un cambio aceptado no deja aviso.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { PermSeg } from "../components/hud/SegmentsSession";
import { ApiContext } from "../context";
import type { SessionInfo } from "../types";

const info = {
  id: "s1", projectId: "p", projectName: "p", cwd: "C:/p", title: "t", claudeSessionId: "c", status: "idle", model: null,
  startedAt: "", bridgeConnected: true, waiting: null, stalled: null, workingSince: null, lastActivityAt: "", turnId: null, screen: "prompt",
  permissionMode: "acceptEdits", launchPermissionMode: "acceptEdits", exitCode: null, bridgeProtocol: 2,
} as SessionInfo;

function mount(setPermissionMode: ReturnType<typeof vi.fn>, recover = vi.fn(async () => ({ ok: true, action: "restart", steps: [], status: "starting" }))) {
  const api = { isMock: true, setPermissionMode, recover } as unknown as SesionesApi;
  render(<ApiContext.Provider value={api}><PermSeg info={info} mode="acceptEdits" /></ApiContext.Provider>);
  return recover;
}

async function pick(name: RegExp) {
  fireEvent.click(screen.getByTestId("hud-perm"));
  await act(async () => fireEvent.click(screen.getByRole("option", { name })));
}

afterEach(cleanup);

describe("modo de permisos fuera del ciclo en el HUD", () => {
  it("el aviso queda a la vista con el desplegable cerrado y reinicia en ese modo", async () => {
    const recover = mount(vi.fn(async () => {
      throw new Error("bypassPermissions está fuera del ciclo de Shift+Tab de esta sesión");
    }));
    await pick(/sin confirmar/);
    expect(screen.queryByRole("listbox")).toBeNull();
    const alert = screen.getByTestId("hud-perm-restart");
    expect(alert.textContent).toContain("no está en el ciclo");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Reiniciar en/ })));
    expect(recover).toHaveBeenCalledWith({ id: "s1", action: "restart", opts: { permissionMode: "bypassPermissions" } });
    expect(screen.queryByTestId("hud-perm-restart")).toBeNull();
  });

  it("caso negativo: un cambio aceptado no deja aviso", async () => {
    mount(vi.fn(async () => ({ ok: true })));
    await pick(/^pregunta/);
    expect(screen.queryByTestId("hud-perm-restart")).toBeNull();
  });
});
