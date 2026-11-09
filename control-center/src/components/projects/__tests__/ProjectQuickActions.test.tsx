// ProjectQuickActions — unit tests (masterplan 3.6: Batch fuera de la barra)
//
// Covers:
//   (1) Renders V1 base actions (Folder, IDE, AI provider label). Run batch
//       is OFF by default (masterplan 3.6 — Batch salió de la barra de
//       acciones de proyecto para ganar espacio para el kanban); solo
//       aparece con el opt-in showBatch.
//   (2) The removed actions (Terminal, Refactor IA, README IA) are gone in
//       both densities.
//   (3) Click IDE invokes `open_project_in_ide` with {path, preferredIde}.
//   (4) Claude abre ULTRON Sessions (`sesiones_launch`), sin opción de
//       terminal clásica. Codex va
//       siempre por `spawn_session`. Nunca pty_spawn.
//   (5) Folder + IDE buttons are disabled when path is null.

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { ProjectQuickActions } from "../ProjectQuickActions";
import type { ProjectInfo } from "../../../types";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const BASE_PROJECT: ProjectInfo = {
  id: "proj-001",
  name: "Alpha",
  path: "C:\\Users\\dev\\projects\\alpha",
  ide: "cursor",
  language: "TypeScript",
  type_: null,
  status: "active",
  last_active: "2026-05-30",
  tags: [],
  items: [],
  default_provider: "claude",
  default_shell: null,
  parent_folder_override: null,
  notes: null,
  executables: [],
};

function renderActions(
  overrides: Partial<ProjectInfo> = {},
  density: "compact" | "full" = "compact",
  showBatch?: boolean,
) {
  return render(
    <ProjectQuickActions
      project={{ ...BASE_PROJECT, ...overrides }}
      density={density}
      showBatch={showBatch}
    />,
  );
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(openPath).mockReset();
  vi.mocked(invoke).mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// (1) Rendering — V1 base actions
// ---------------------------------------------------------------------------

describe("ProjectQuickActions — rendering (V1)", () => {
  it("renders Folder, IDE and provider label in compact mode", () => {
    renderActions();
    expect(screen.getByText("Carpeta")).toBeTruthy();
    expect(screen.getByText("IDE")).toBeTruthy();
    // default_provider = "claude" → badge label "Claude"
    expect(screen.getByText("Claude")).toBeTruthy();
  });

  it("does NOT render Run batch by default (masterplan 3.6 — Batch fuera de la barra)", () => {
    renderActions();
    expect(screen.queryByText("Ejecutar .bat")).toBeNull();
  });

  it("renders Run batch only when showBatch=true (opt-in escape hatch)", () => {
    renderActions({}, "compact", true);
    expect(screen.getByText("Ejecutar .bat")).toBeTruthy();
  });

  it("does NOT render the removed Terminal button", () => {
    renderActions();
    expect(screen.queryByText("Terminal")).toBeNull();
  });

  it("does NOT render Refactor IA / README IA in any density", () => {
    renderActions({}, "full");
    expect(screen.queryByText("Refactor IA")).toBeNull();
    expect(screen.queryByText("README IA")).toBeNull();
  });

  it("renders Codex label when default_provider is codex", () => {
    renderActions({ default_provider: "codex" });
    expect(screen.getByText("Codex")).toBeTruthy();
  });

  it("renders Launch all button when items has two or more non-folder items", () => {
    renderActions({
      items: [
        { kind: "claude", cwd: "C:\\projects\\alpha" },
        { kind: "exe", path: "C:\\tools\\app.exe" },
      ],
    });
    expect(screen.getByText("Lanzar todo (2)")).toBeTruthy();
  });

  it("does NOT render Launch all with a single launchable item (it would repeat the provider button)", () => {
    renderActions({
      items: [
        { kind: "claude", cwd: "C:\\projects\\alpha" },
        { kind: "folder", path: "C:\\projects\\alpha" },
      ],
    });
    expect(screen.queryByText(/Lanzar todo/)).toBeNull();
  });

  it("does NOT render Launch all when showLaunchAll is false (ProjectRow has its own)", () => {
    render(
      <ProjectQuickActions
        project={{
          ...BASE_PROJECT,
          items: [
            { kind: "claude", cwd: "C:\\projects\\alpha" },
            { kind: "exe", path: "C:\\tools\\app.exe" },
          ],
        }}
        showLaunchAll={false}
      />,
    );
    expect(screen.queryByText(/Lanzar todo/)).toBeNull();
  });

  it("does NOT render Launch all when items is empty", () => {
    renderActions({ items: [] });
    expect(screen.queryByText(/Lanzar todo/)).toBeNull();
  });

  it("renders individual item buttons in full density", () => {
    renderActions(
      {
        items: [{ kind: "exe", path: "C:\\tools\\app.exe", label: "MyApp" }],
      },
      "full",
    );
    expect(screen.getByText("MyApp")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// (2) Disabled states
// ---------------------------------------------------------------------------

describe("ProjectQuickActions — disabled states", () => {
  it("Folder and IDE buttons are both disabled when project has no path", () => {
    renderActions({ path: null });
    const buttons = screen.getAllByTitle("Sin ruta configurada");
    expect(buttons.length).toBe(2);
    buttons.forEach((b) => {
      expect(b.closest("button")).toHaveProperty("disabled", true);
    });
  });
});

// ---------------------------------------------------------------------------
// (3) IDE action
// ---------------------------------------------------------------------------

describe("ProjectQuickActions — IDE action", () => {
  it("invokes open_project_in_ide with {path, preferredIde} on click", async () => {
    renderActions();
    fireEvent.click(screen.getByText("IDE"));
    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("open_project_in_ide", {
        path: BASE_PROJECT.path,
        preferredIde: BASE_PROJECT.ide,
      });
    });
  });

  it("shows the backend error when the preferred IDE is not installed", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(
      "Rider is not installed (no 'rider' on PATH, in the JetBrains Toolbox scripts directory, or in a standard install directory)",
    );
    renderActions({ ide: "rider" });
    fireEvent.click(screen.getByText("IDE"));
    await waitFor(() => {
      expect(screen.getByText(/Rider is not installed/)).toBeTruthy();
    });
  });

  it("shows no error message when the IDE opens fine", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("opened in Rider");
    renderActions({ ide: "rider" });
    fireEvent.click(screen.getByText("IDE"));
    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalled();
    });
    expect(screen.queryByText(/not installed/)).toBeNull();
  });

  it("uses null for preferredIde when project.ide is null", async () => {
    renderActions({ ide: null });
    fireEvent.click(screen.getByText("IDE"));
    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("open_project_in_ide", {
        path: BASE_PROJECT.path,
        preferredIde: null,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// (4) AI button → spawn_session (external CLI), NOT pty_spawn
// ---------------------------------------------------------------------------

describe("ProjectQuickActions — AI action (E11)", () => {
  it("Claude abre la sesión en ULTRON Sessions con sesiones_launch(projectId)", async () => {
    renderActions({ default_provider: "claude" });
    fireEvent.click(screen.getByText("Claude"));
    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("sesiones_launch", { projectId: BASE_PROJECT.id });
    });
    // Caso negativo: un clic normal ya no abre la terminal clásica.
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("spawn_session", expect.anything());
  });

  it("enseña el error de sesiones_launch en la tarjeta", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("ULTRON Sessions no pudo crear la sesión");
    renderActions({ default_provider: "claude" });
    fireEvent.click(screen.getByText("Claude"));
    expect(await screen.findByText("ULTRON Sessions no pudo crear la sesión")).toBeInTheDocument();
  });

  it("Claude ya no ofrece la terminal clásica (ni menú ni Mayús+clic)", async () => {
    renderActions({ default_provider: "claude" });
    expect(screen.queryByRole("button", { name: "Cómo abrir Claude" })).toBeNull();
    fireEvent.click(screen.getByText("Claude"), { shiftKey: true });
    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("sesiones_launch", { projectId: BASE_PROJECT.id });
    });
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("spawn_session", expect.anything());
  });

  it("invokes spawn_session with provider=codex when project uses codex", async () => {
    renderActions({ default_provider: "codex" });
    fireEvent.click(screen.getByText("Codex"));
    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("spawn_session", {
        provider: "codex",
        cwd: BASE_PROJECT.path,
        prompt: null,
        // Proyecto propio: sin decisión explícita, manda el defecto de
        // sessions.rs. Un false aquí sí se respetaría (C1).
        flags: {},
      });
    });
  });
});

// ---------------------------------------------------------------------------
// (5) "Abrir app" button — FRENTE D (project_open_app)
// ---------------------------------------------------------------------------

describe("ProjectQuickActions — Abrir app action", () => {
  it("is not rendered when app_command is unset", () => {
    renderActions({ app_command: null });
    expect(screen.queryByText("Abrir app")).toBeNull();
  });

  it("is not rendered when app_command is only whitespace", () => {
    renderActions({ app_command: "   " });
    expect(screen.queryByText("Abrir app")).toBeNull();
  });

  it("invokes project_open_app with {id} when app_command is set", async () => {
    renderActions({ app_command: "npm run tauri dev" });
    const btn = screen.getByText("Abrir app").closest("button");
    expect(btn).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByText("Abrir app"));
    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("project_open_app", {
        id: BASE_PROJECT.id,
      });
    });
  });

  it("shows the backend error inline (not alert()) when the launch fails", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "project_open_app") return Promise.reject("project path does not exist: X");
      return Promise.resolve(null);
    });
    renderActions({ app_command: "npm run tauri dev" });
    fireEvent.click(screen.getByText("Abrir app"));
    await waitFor(() => {
      expect(screen.getByText(/project path does not exist/)).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// (6) «Jugar» — project_play_game (Unreal / Unity)
// ---------------------------------------------------------------------------

describe("ProjectQuickActions — Jugar action", () => {
  it("no se pinta en proyectos sin motor de juego", () => {
    renderActions({ game_engine: null });
    expect(screen.queryByText("Jugar")).toBeNull();
  });

  it("invoca project_play_game con {id} y enseña el modo usado", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "project_play_game") {
        return Promise.resolve({
          engine: "unreal",
          mode: "editor_game",
          executable: "C:\UE\UnrealEditor.exe",
          message: "Sin build empaquetado: juego sin editor (UnrealEditor -game -windowed) con X.uproject",
        });
      }
      return Promise.resolve(null);
    });
    renderActions({ game_engine: "unreal" });
    fireEvent.click(screen.getByText("Jugar"));
    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("project_play_game", { id: BASE_PROJECT.id });
    });
    expect(await screen.findByRole("status")).toHaveTextContent(/UnrealEditor -game -windowed/);
  });

  it("enseña el error del backend cuando Unity no tiene build", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "project_play_game") {
        return Promise.reject("No hay build de Unity: compila primero (se buscó ...)");
      }
      return Promise.resolve(null);
    });
    renderActions({ game_engine: "unity" });
    fireEvent.click(screen.getByText("Jugar"));
    expect(await screen.findByText(/No hay build de Unity: compila primero/)).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
