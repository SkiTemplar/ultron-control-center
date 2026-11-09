// Los botones de IA de Plans y Library abren Sessions, no Windows Terminal.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { openInSessionsMessage, openPromptInSessions } from "../sessionsLaunch";

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("openPromptInSessions", () => {
  it("crea la sesión en el cwd, envía el prompt y enfoca Sessions", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "sesiones_create" ? { id: "s-1" } : null,
    );
    const r = await openPromptInSessions({ cwd: " /tmp/plans ", prompt: "hola", permissionMode: "default" });
    expect(r).toEqual({ sessionId: "s-1", sent: true, copied: false, warning: null });
    const cmds = vi.mocked(invoke).mock.calls.map(([c]) => c);
    expect(cmds).toEqual(["sesiones_create", "sesiones_send", "sesiones_focus_session"]);
    expect(vi.mocked(invoke).mock.calls[0][1]).toEqual({ cwd: "/tmp/plans", permissionMode: "default" });
    expect(cmds).not.toContain("spawn_session");
  });

  it("sin permissionMode no lo manda: decide el perfil de Sessions", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "sesiones_create" ? { id: "s-2" } : null,
    );
    await openPromptInSessions({ cwd: "/x", prompt: "p" });
    expect(vi.mocked(invoke).mock.calls[0][1]).toEqual({ cwd: "/x" });
  });

  it("si el envío falla lo dice y copia el prompt (caso negativo)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "sesiones_create") return { id: "s-3" };
      if (cmd === "sesiones_send") throw new Error("sesión cerrada");
      return null;
    });
    const r = await openPromptInSessions({ cwd: "/x", prompt: "p" });
    expect(r.sent).toBe(false);
    expect(r.copied).toBe(true);
    expect(r.warning).toMatch(/sesión cerrada/);
    expect(writeText).toHaveBeenCalledWith("p");
    expect(openInSessionsMessage("Sprint AI", r)).toMatch(/portapapeles/);
  });

  it("sin cwd o si no se crea la sesión, lanza", async () => {
    await expect(openPromptInSessions({ cwd: "  ", prompt: "p" })).rejects.toThrow(/directorio de trabajo/);
    vi.mocked(invoke).mockRejectedValue("no existe el directorio");
    await expect(openPromptInSessions({ cwd: "/x", prompt: "p" })).rejects.toBe("no existe el directorio");
  });
});
