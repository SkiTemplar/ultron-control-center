// ProjectWorkspace — ventana separada y proyecto sin carpeta (auditoría UX
// 2026-10-17).
//
// - En la ventana separada «‹ Projects» cerraba una pestaña que nadie pinta y
//   «Separar» separaba una ventana ya separada: no-op silencioso.
// - Un proyecto registrado sin ruta dejaba los tiles en «Cargando…» para
//   siempre y el título en el id.

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import ProjectWorkspace from "../ProjectWorkspace";
import { ProjectsTabsProvider } from "../../../state/ProjectsTabsContext";

const win = vi.hoisted(() => ({
  main: { show: vi.fn(), setFocus: vi.fn() },
  current: { close: vi.fn() },
}));

vi.mock("@tauri-apps/api/window", () => ({
  Window: { getByLabel: vi.fn(async (label: string) => (label === "main" ? win.main : null)) },
  getCurrentWindow: () => win.current,
}));

vi.mock("../../../lib/button-prompts", () => ({
  getPrompt: vi.fn().mockResolvedValue("prompt de prueba"),
}));

const WITH_PATH = { id: "proj-1", name: "Alpha", path: "C:\\Alpha", items: [], tags: [] };
const NO_PATH = { id: "sin-ruta", name: "Proyecto sin carpeta", path: null, items: [], tags: [] };

function mockInvoke(projects: unknown[]) {
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "list_projects":
        return projects;
      case "git_repo_state":
        return { is_repo: false, branch: null, remote: null, ahead: 0, behind: 0, dirty: false, dirty_count: 0, path: "C:\\Alpha" };
      case "codegraph_is_indexed":
        return false;
      case "project_session_log":
      case "tabs_load":
        return [];
      default:
        return null;
    }
  });
}

function renderWorkspace(projectId: string, detached = false) {
  return render(
    <ProjectsTabsProvider>
      <ProjectWorkspace projectId={projectId} detached={detached} />
    </ProjectsTabsProvider>,
  );
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(openDialog).mockReset();
  win.main.show.mockReset();
  win.main.setFocus.mockReset();
  win.current.close.mockReset();
});

describe("ProjectWorkspace — ventana separada", () => {
  it("en la ventana principal ofrece «Proyectos» y «Separar»", async () => {
    mockInvoke([WITH_PATH]);
    renderWorkspace("proj-1");
    expect(await screen.findByText("Separar")).toBeInTheDocument();
    expect(screen.getByText("Proyectos")).toBeInTheDocument();
    expect(screen.queryByText("Ventana principal")).toBeNull();
  });

  it("separada: sin «Separar», y el botón de volver enfoca la principal y cierra esta", async () => {
    mockInvoke([WITH_PATH]);
    renderWorkspace("proj-1", true);
    const back = await screen.findByText("Ventana principal");
    expect(screen.queryByText("Separar")).toBeNull();
    expect(screen.queryByText("Proyectos")).toBeNull();
    fireEvent.click(back);
    await waitFor(() => expect(win.current.close).toHaveBeenCalled());
    expect(win.main.setFocus).toHaveBeenCalled();
  });

  it("separada: si no puede volver, lo dice", async () => {
    mockInvoke([WITH_PATH]);
    win.current.close.mockRejectedValueOnce("permiso denegado");
    renderWorkspace("proj-1", true);
    fireEvent.click(await screen.findByText("Ventana principal"));
    expect(await screen.findByText(/No se pudo volver a la ventana principal: permiso denegado/)).toBeInTheDocument();
  });
});

describe("ProjectWorkspace — proyecto sin carpeta", () => {
  it("enseña el nombre real, «Sin carpeta asignada» y el aviso con «Asignar carpeta…»", async () => {
    mockInvoke([NO_PATH]);
    renderWorkspace("sin-ruta");
    expect(await screen.findByText(/no tiene carpeta asignada/)).toBeInTheDocument();
    expect(screen.getByText("Proyecto sin carpeta")).toBeInTheDocument();
    expect(screen.getAllByText("Sin carpeta asignada")).toHaveLength(2);
    expect(screen.queryByText("Cargando…")).toBeNull();
    expect(screen.queryByText("Verificando índice…")).toBeNull();
  });

  it("«Asignar carpeta…» guarda la ruta elegida con update_project y recarga", async () => {
    mockInvoke([NO_PATH]);
    vi.mocked(openDialog).mockResolvedValueOnce("D:\\Proyectos\\nuevo");
    renderWorkspace("sin-ruta");
    fireEvent.click(await screen.findByText("Asignar carpeta…"));
    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("update_project", {
        id: "sin-ruta",
        path: "D:\\Proyectos\\nuevo",
      }),
    );
    await waitFor(() =>
      expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === "list_projects")).toHaveLength(2),
    );
  });

  it("un proyecto con ruta no enseña el aviso", async () => {
    mockInvoke([WITH_PATH]);
    renderWorkspace("proj-1");
    await screen.findByText("Separar");
    expect(screen.queryByText(/no tiene carpeta asignada/)).toBeNull();
  });
});
