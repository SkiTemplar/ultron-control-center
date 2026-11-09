// Catalog — «Integrar con IA» abre Claude sobre un repo de GitHub ajeno.
//
// C1 (auditoría 2026-10-17): la sesión debe pedir permisos normales. Se abre
// en Sessions con `permissionMode: "default"` explícito; si alguien quita el
// campo, la sesión caería en el perfil de lanzamiento (que puede ser bypass)
// y este test falla.

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { Catalog } from "../Catalog";

vi.mock("../../../lib/button-prompts", () => ({
  getPrompt: vi.fn().mockResolvedValue("prompt de prueba"),
}));

const HIT = {
  full_name: "ajeno/repo-con-skills",
  owner: "ajeno",
  name: "repo-con-skills",
  description: "Repo de terceros",
  stars: 42,
  language: "TypeScript",
  html_url: "https://github.com/ajeno/repo-con-skills",
  updated_at: null,
  topics: [],
};

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === "github_search_trending" || cmd === "github_search_repos") return [HIT];
    if (cmd === "instruction_path") return "/home/u/.ultron/instructions/skills";
    if (cmd === "sesiones_create") return { id: "s-1" };
    return null;
  });
});

describe("Catalog — Integrar con IA", () => {
  it("abre la sesión en Sessions con permissionMode=default explícito", async () => {
    render(<Catalog />);
    fireEvent.click(await screen.findByText("Integrar con IA"));
    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("sesiones_send", expect.anything());
    });
    const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === "sesiones_create");
    const args = call?.[1] as { permissionMode?: unknown; cwd?: unknown };
    // Caso negativo implícito: `undefined` (campo ausente) también falla aquí.
    expect(args.permissionMode).toBe("default");
    expect(args.cwd).toBe("/home/u/.ultron/instructions/skills");
    // Ya no abre Windows Terminal.
    expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === "spawn_session")).toBe(false);
  });
});
