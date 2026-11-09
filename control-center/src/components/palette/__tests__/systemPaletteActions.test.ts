// Paleta Ctrl+K (frontend-e2e-2 y frontend-e2e-4): las acciones destructivas
// piden confirmación, un `success:false` o una excepción se enseñan, y el
// Rebuild sigue el flujo canónico (confirmación + terminal, sin cerrar la app).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("../../../lib/dialog", () => ({ confirmDialog: vi.fn() }));
vi.mock("../../../lib/notify", () => ({ notify: vi.fn() }));

import { confirmDialog } from "../../../lib/dialog";
import { notify } from "../../../lib/notify";
import {
  maintenancePaletteActions,
  rebuildPaletteAction,
  runMaintenanceFromPalette,
  runRebuildWithFeedback,
  type MaintenanceCommand,
} from "../systemPaletteActions";

const CLEAR_TEMP: MaintenanceCommand = {
  kind: "pc-clear-temp",
  label: "Borrar ficheros temporales",
  description: "Borra %TEMP%.",
  group: "pc",
  destructive: true,
};

const FLUSH_DNS: MaintenanceCommand = {
  kind: "pc-flush-dns",
  label: "Vaciar la caché DNS",
  description: "ipconfig /flushdns.",
  group: "pc",
  destructive: false,
};

function result(success: boolean, extra: Partial<{ stderr: string; exit_code: number }> = {}) {
  return {
    kind: "x",
    success,
    stdout: "",
    stderr: extra.stderr ?? "",
    exit_code: extra.exit_code ?? (success ? 0 : 1),
    elapsed_ms: 12,
  };
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(confirmDialog).mockReset();
  vi.mocked(notify).mockReset();
});

describe("runMaintenanceFromPalette", () => {
  it("una acción destructiva cancelada no se lanza", async () => {
    vi.mocked(confirmDialog).mockResolvedValue(false);
    await expect(runMaintenanceFromPalette(CLEAR_TEMP)).resolves.toBe("cancelled");
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("una acción destructiva confirmada se lanza", async () => {
    vi.mocked(confirmDialog).mockResolvedValue(true);
    vi.mocked(invoke).mockResolvedValue(result(true));
    await expect(runMaintenanceFromPalette(CLEAR_TEMP)).resolves.toBe("ok");
    expect(invoke).toHaveBeenCalledWith("run_maintenance_command", { kind: "pc-clear-temp" });
  });

  it("una acción no destructiva no pregunta", async () => {
    vi.mocked(invoke).mockResolvedValue(result(true));
    await runMaintenanceFromPalette(FLUSH_DNS);
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "info", message: expect.stringMatching(/hecho/) }),
    );
  });

  it("success:false se enseña como fallo con código y salida", async () => {
    vi.mocked(invoke).mockResolvedValue(
      result(false, { exit_code: 2, stderr: "unrecognized arguments: --non-interactive" }),
    );
    await expect(runMaintenanceFromPalette(FLUSH_DNS)).resolves.toBe("failed");
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "warn",
        message: expect.stringMatching(/ha fallado \(código 2\).*unrecognized/),
      }),
    );
  });

  it("una excepción del comando se enseña", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("unknown maintenance kind: x"));
    await expect(runMaintenanceFromPalette(FLUSH_DNS)).resolves.toBe("failed");
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "warn", message: expect.stringMatching(/unknown maintenance kind/) }),
    );
  });
});

describe("maintenancePaletteActions", () => {
  it("anuncia la confirmación en las destructivas y agrupa por grupo", () => {
    const [temp, dns] = maintenancePaletteActions([CLEAR_TEMP, FLUSH_DNS]);
    expect(temp.id).toBe("maint.pc-clear-temp");
    expect(temp.description).toMatch(/Pide confirmación/);
    expect(dns.description).not.toMatch(/Pide confirmación/);
    expect(temp.group).toBe("Mantenimiento (PC)");
  });
});

describe("Rebuild desde la paleta", () => {
  it("sigue el flujo canónico: confirma, abre la terminal y no cierra la app", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "sesiones_busy" ? { working: 0, queued: 0, sessions: [] } : undefined,
    );
    vi.mocked(confirmDialog).mockResolvedValue(true);
    await runRebuildWithFeedback("palette");
    const cmds = vi.mocked(invoke).mock.calls.map((c) => c[0]);
    expect(cmds).toEqual(["sesiones_busy", "run_app_lifecycle"]);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/reinicia ULTRON/) }),
    );
  });

  it("cancelar no abre nada", async () => {
    vi.mocked(invoke).mockResolvedValue({ working: 0, queued: 0, sessions: [] });
    vi.mocked(confirmDialog).mockResolvedValue(false);
    await runRebuildWithFeedback("palette");
    expect(invoke).not.toHaveBeenCalledWith("run_app_lifecycle", expect.anything());
    expect(notify).not.toHaveBeenCalled();
  });

  it("si la terminal no se abre, se avisa", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "sesiones_busy") return { working: 0, queued: 0, sessions: [] };
      throw new Error("control-center/ missing");
    });
    vi.mocked(confirmDialog).mockResolvedValue(true);
    await runRebuildWithFeedback("update-banner");
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "warn", source: "update-banner", message: expect.stringMatching(/missing/) }),
    );
  });

  it("la entrada de la paleta no promete `tauri build`", () => {
    expect(rebuildPaletteAction().description).not.toMatch(/tauri build/);
    expect(rebuildPaletteAction().description).toMatch(/build:local/);
  });
});
