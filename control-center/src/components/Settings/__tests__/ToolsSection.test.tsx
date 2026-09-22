// ToolsSection — informe de CLIs standalone (markitdown, rumdl, mmdc, glow,
// agy, codex): instalada/no instalada, version, y el "Volver a comprobar".

import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { ToolsSection } from "../ToolsSection";

const REPORT_MIXED = {
  tools: [
    {
      id: "rumdl",
      label: "rumdl",
      description: "Linter y formateador de Markdown.",
      installed: true,
      version: "rumdl 0.2.75",
      version_error: "",
      install_hint: "uv tool install rumdl",
    },
    {
      id: "glow",
      label: "glow",
      description: "Renderiza Markdown con estilo en la terminal.",
      installed: false,
      version: "",
      version_error: "",
      install_hint: "winget install charmbracelet.glow",
    },
    {
      id: "mmdc",
      label: "mmdc (Mermaid CLI)",
      description: "Genera PNG/SVG a partir de diagramas Mermaid.",
      installed: true,
      version: "",
      version_error: "el binario no devolvio texto en --version",
      install_hint: "npm install -g @mermaid-js/mermaid-cli",
    },
  ],
};

describe("ToolsSection", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("muestra version de una instalada, comando de instalación de la que falta, y el aviso de version desconocida", async () => {
    vi.mocked(invoke).mockResolvedValue(REPORT_MIXED);
    render(<ToolsSection />);

    await waitFor(() => expect(screen.getByText("rumdl 0.2.75")).toBeTruthy());
    expect(screen.getByText("winget install charmbracelet.glow")).toBeTruthy();
    expect(screen.getByText(/no devolvio texto en --version/)).toBeTruthy();
    expect(screen.getAllByText("Instalada").length).toBe(2);
    expect(screen.getByText("No instalada")).toBeTruthy();
  });

  it("un fallo del comando se muestra como error, no como pantalla en blanco", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("boom"));
    render(<ToolsSection />);
    await waitFor(() => expect(screen.getByText(/boom/)).toBeTruthy());
  });

  it("«Volver a comprobar» vuelve a pedir el informe", async () => {
    vi.mocked(invoke).mockResolvedValue(REPORT_MIXED);
    render(<ToolsSection />);

    await waitFor(() => expect(screen.getByText("rumdl 0.2.75")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Volver a comprobar/ }));

    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(invoke).toHaveBeenCalledWith("tools_status");
  });
});
