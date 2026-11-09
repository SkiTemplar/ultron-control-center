// rebuildFlow — el Rebuild pide confirmación antes de abrir la terminal y ya no
// cierra la app: el build aparta el .exe en uso y el nuevo entra al reiniciar.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("../../../lib/dialog", () => ({
  confirmDialog: vi.fn(),
}));

import { confirmDialog } from "../../../lib/dialog";
import { rebuildConfirmMessage, startRebuild, type BusySessions } from "../rebuildFlow";

const BUSY: BusySessions = {
  working: 1,
  queued: 1,
  sessions: [
    { id: "a", title: "Arreglar backups", working: true, queued: false },
    { id: "b", title: "Kanban", working: false, queued: true },
  ],
};

function mockInvoke(busy: BusySessions | Error) {
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === "sesiones_busy") {
      if (busy instanceof Error) throw busy;
      return busy;
    }
    return undefined;
  });
}

describe("rebuildConfirmMessage", () => {
  it("sin sesiones ocupadas explica que ULTRON sigue abierto y cuándo entra el binario", () => {
    const msg = rebuildConfirmMessage({ working: 0, queued: 0, sessions: [] });
    expect(msg).toMatch(/ULTRON sigue abierto/);
    expect(msg).toMatch(/entra al reiniciar/);
    expect(msg).not.toMatch(/Atención/);
  });

  it("con sesiones ocupadas las nombra y acota cuándo se cortarían", () => {
    const msg = rebuildConfirmMessage(BUSY);
    expect(msg).toMatch(/2 sesión\(es\)/);
    expect(msg).toMatch(/«Arreglar backups»/);
    expect(msg).toMatch(/a la fuerza/);
  });

  it("si no se pudo consultar Sessions, lo dice", () => {
    expect(rebuildConfirmMessage(null)).toMatch(/No se ha podido comprobar/);
  });
});

describe("startRebuild", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(confirmDialog).mockReset();
  });

  it("cancelar no abre la terminal", async () => {
    mockInvoke(BUSY);
    vi.mocked(confirmDialog).mockResolvedValue(false);
    await expect(startRebuild()).resolves.toBe("cancelled");
    expect(invoke).not.toHaveBeenCalledWith("run_app_lifecycle", expect.anything());
  });

  it("confirmar abre la terminal y NO cierra la app (el .exe se aparta)", async () => {
    mockInvoke({ working: 0, queued: 0, sessions: [] });
    vi.mocked(confirmDialog).mockResolvedValue(true);
    await expect(startRebuild()).resolves.toBe("started");
    const cmds = vi.mocked(invoke).mock.calls.map((c) => c[0]);
    expect(cmds).toEqual(["sesiones_busy", "run_app_lifecycle"]);
    expect(confirmDialog).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ kind: "warning" }),
    );
  });

  it("con sesiones ocupadas el diálogo va en rojo", async () => {
    mockInvoke(BUSY);
    vi.mocked(confirmDialog).mockResolvedValue(false);
    await startRebuild();
    expect(confirmDialog).toHaveBeenCalledWith(
      expect.stringMatching(/Atención/),
      expect.objectContaining({ kind: "error" }),
    );
  });

  it("si la terminal no se abre, el error se propaga", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "sesiones_busy") return { working: 0, queued: 0, sessions: [] };
      if (cmd === "run_app_lifecycle") throw new Error("control-center/ missing");
      return undefined;
    });
    vi.mocked(confirmDialog).mockResolvedValue(true);
    await expect(startRebuild()).rejects.toThrow(/missing/);
    expect(invoke).not.toHaveBeenCalledWith("close_control_center");
  });

  it("un fallo de sesiones_busy no bloquea el Rebuild", async () => {
    mockInvoke(new Error("sin Sessions"));
    vi.mocked(confirmDialog).mockResolvedValue(true);
    await expect(startRebuild()).resolves.toBe("started");
    expect(confirmDialog).toHaveBeenCalledWith(
      expect.stringMatching(/No se ha podido comprobar/),
      expect.anything(),
    );
  });
});
