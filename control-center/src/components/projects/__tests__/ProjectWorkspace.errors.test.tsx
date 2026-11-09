// ProjectWorkspace — H21 (auditoría 2026-10-17).
//
// IA, IDE, carpeta, ejecutables y la sesión CodeGraph tragaban el error con
// `catch { /* silencioso */ }`: el botón no hacía nada y no decía por qué.
// Cada caso rechaza la llamada y exige que el motivo aparezca en pantalla.

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import ProjectWorkspace from "../ProjectWorkspace";
import { ProjectsTabsProvider } from "../../../state/ProjectsTabsContext";

vi.mock("../../../lib/button-prompts", () => ({
  getPrompt: vi.fn().mockResolvedValue("prompt de prueba"),
}));

const PROJECT = {
  id: "proj-1",
  name: "Alpha",
  path: "C:\\Program Files\\Alpha",
  ide: "cursor",
  default_provider: "claude",
  default_shell: null,
  executables: [{ name: "Juego", path: "C:\\Program Files\\Alpha\\juego.exe" }],
  items: [],
  tags: [],
};

/** Respuestas por comando; `failing` rechaza con su mensaje. */
function mockInvoke(failing: Record<string, string> = {}, indexed = false) {
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd in failing) throw failing[cmd];
    switch (cmd) {
      case "list_projects":
        return [PROJECT];
      case "git_repo_state":
        return { is_repo: false, branch: null, remote: null, ahead: 0, behind: 0, dirty: false, dirty_count: 0, path: PROJECT.path };
      case "codegraph_is_indexed":
        return indexed;
      case "codegraph_summary":
        return null;
      case "project_session_log":
        return [];
      case "tabs_load":
        return [];
      default:
        return null;
    }
  });
}

function renderWorkspace() {
  return render(
    <ProjectsTabsProvider>
      <ProjectWorkspace projectId="proj-1" />
    </ProjectsTabsProvider>,
  );
}

async function clickCard(label: string) {
  const card = (await screen.findByText(label)).closest("button");
  if (!card) throw new Error(`sin botón para ${label}`);
  await vi.waitFor(() => expect(card).not.toBeDisabled());
  fireEvent.click(card);
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(openPath).mockReset();
  vi.mocked(openPath).mockResolvedValue(undefined);
});

describe("ProjectWorkspace — los botones explican su fallo", () => {
  it("IA: enseña el error de spawn_session", async () => {
    mockInvoke({ spawn_session: "wt.exe no encontrado" });
    renderWorkspace();
    await clickCard("Claude");
    expect(await screen.findByText(/No se pudo lanzar la sesión de Claude: wt.exe no encontrado/)).toBeInTheDocument();
  });

  it("IDE: enseña el error de open_project_in_ide", async () => {
    mockInvoke({ open_project_in_ide: "cursor no instalado" });
    renderWorkspace();
    await clickCard("IDE");
    expect(await screen.findByText(/No se pudo abrir el IDE: cursor no instalado/)).toBeInTheDocument();
  });

  it("Folder: enseña el error del opener (ruta fuera de su scope)", async () => {
    mockInvoke();
    vi.mocked(openPath).mockRejectedValueOnce("path not allowed on the configured scope");
    renderWorkspace();
    await clickCard("Carpeta");
    expect(await screen.findByText(/No se pudo abrir la carpeta .*path not allowed/)).toBeInTheDocument();
  });

  it("ejecutable: enseña el error del opener", async () => {
    mockInvoke();
    vi.mocked(openPath).mockRejectedValueOnce("acceso denegado");
    renderWorkspace();
    await clickCard("Juego");
    expect(await screen.findByText(/No se pudo abrir .*juego\.exe: acceso denegado/)).toBeInTheDocument();
  });

  it("CodeGraph indexado: enseña el error si el visor no puede leer el índice", async () => {
    mockInvoke({ codegraph_files: "codegraph.db ilegible" }, true);
    renderWorkspace();
    await clickCard("CodeGraph");
    expect(await screen.findByText(/No se pudo leer la lista de ficheros del índice: codegraph.db ilegible/)).toBeInTheDocument();
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("spawn_session", expect.anything());
  });

  it("caso negativo: si la acción funciona no aparece ningún error", async () => {
    mockInvoke();
    renderWorkspace();
    await clickCard("IDE");
    await vi.waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("open_project_in_ide", expect.anything()),
    );
    expect(screen.queryByText(/No se pudo/)).toBeNull();
  });
});
