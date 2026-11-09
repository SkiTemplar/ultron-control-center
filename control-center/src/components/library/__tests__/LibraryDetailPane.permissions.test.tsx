// LibraryDetailPane — «Editar con IA» abre Claude sobre un fichero de la
// biblioteca, que puede venir de un repo ajeno instalado desde el catálogo.
//
// Antes, spawn_session mandaba `dangerouslySkipPermissions: false`; al pasar a
// Sessions, sin `permissionMode` la sesión heredaría el perfil de lanzamiento
// (que puede ser bypass). Si alguien quita el campo, este test falla.

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { LibraryDetailPane } from "../LibraryDetailPane";

vi.mock("../../../lib/button-prompts", () => ({
  getPrompt: vi.fn().mockResolvedValue("prompt de prueba"),
}));

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === "read_text_file") return "---\nname: ajena\n---\ncuerpo";
    if (cmd === "list_skill_files") return [];
    if (cmd === "sesiones_create") return { id: "s-1" };
    return null;
  });
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

describe("LibraryDetailPane — Editar con IA", () => {
  it("abre Sessions en la carpeta del fichero con permissionMode=default explícito", async () => {
    render(
      <LibraryDetailPane
        kind="skill"
        name="ajena"
        subtitle="global"
        filePath="/home/u/.claude/skills/ajena/SKILL.md"
        folderPath="/home/u/.claude/skills/ajena"
        onClose={() => {}}
      />,
    );
    const button = await screen.findByText("Editar con IA");
    await waitFor(() => expect(button.closest("button")).not.toBeDisabled());
    fireEvent.click(button);
    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("sesiones_send", expect.anything());
    });
    const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === "sesiones_create");
    const args = call?.[1] as { permissionMode?: unknown; cwd?: unknown };
    // Caso negativo implícito: `undefined` (campo ausente) también falla aquí.
    expect(args.permissionMode).toBe("default");
    expect(args.cwd).toBe("/home/u/.claude/skills/ajena");
    expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === "spawn_session")).toBe(false);
  });
});
