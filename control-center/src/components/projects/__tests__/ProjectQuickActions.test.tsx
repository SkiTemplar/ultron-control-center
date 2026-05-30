// ProjectQuickActions — unit tests
//
// Covers:
//   (1) Renders base actions (Folder, IDE, AI provider, Terminal) in both densities.
//   (2) In compact density the IA buttons (Refactor IA / README IA) are hidden;
//       in full density they appear when `path` is set.
//   (3) Click IDE invokes `open_project_in_ide` with {path, preferredIde}.
//   (4) Click Terminal (no onOpenTerminal) invokes `spawn_session` with correct cwd.
//   (5) Click AI button invokes `pty_spawn` with the project's provider.
//   (6) Click "Refactor IA" resolves the prompt via `list_button_prompts` catalog
//       then invokes `spawn_session` with that prompt.
//   (7) Click "README IA" does the same with the generate_readme key.
//   (8) onOpenTerminal callback is used instead of invoke when provided.
//   (9) Folder button is disabled and IDE button is disabled when path is null.

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
  path: "C:\\Users\\USER\\projects\\alpha",
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

/** Minimal button-prompts catalog returned by `list_button_prompts`. */
const MOCK_CATALOG = {
  schema_version: 1,
  buttons: [
    {
      key: "projects.suggest_refactor",
      label: "Suggest refactor",
      location: "project",
      description: "Refactor suggestions",
      prompt: "Refactoriza el código en {project_path} para el proyecto {project_name}.",
      default_prompt: "Refactoriza el código en {project_path} para el proyecto {project_name}.",
      overridden: false,
      vars: ["project_path", "project_name"],
    },
    {
      key: "projects.generate_readme",
      label: "Generate README",
      location: "project",
      description: "README generation",
      prompt: "Genera un README para {project_name} en {project_path}.",
      default_prompt: "Genera un README para {project_name} en {project_path}.",
      overridden: false,
      vars: ["project_path", "project_name"],
    },
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderActions(
  overrides: Partial<ProjectInfo> = {},
  density: "compact" | "full" = "compact",
  onOpenTerminal?: () => void,
) {
  return render(
    <ProjectQuickActions
      project={{ ...BASE_PROJECT, ...overrides }}
      density={density}
      onOpenTerminal={onOpenTerminal}
    />,
  );
}

// ---------------------------------------------------------------------------
// Mock button-prompts module to control getPrompt without cache leaks
// ---------------------------------------------------------------------------

vi.mock("../../../lib/button-prompts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../lib/button-prompts")>();
  return {
    ...original,
    getPrompt: vi.fn(),
  };
});

import { getPrompt } from "../../../lib/button-prompts";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(openPath).mockReset();

  // Default: invoke resolves null for everything.
  vi.mocked(invoke).mockResolvedValue(null);

  // Default: getPrompt renders the template from MOCK_CATALOG as the real impl would.
  vi.mocked(getPrompt).mockImplementation((key, vars = {}) => {
    const entry = MOCK_CATALOG.buttons.find((b) => b.key === key);
    if (!entry) return Promise.reject(new Error(`unknown button prompt key: ${key}`));
    let rendered = entry.prompt;
    for (const [k, v] of Object.entries(vars)) {
      rendered = rendered.split(`{${k}}`).join(v);
    }
    return Promise.resolve(rendered);
  });
});

// ---------------------------------------------------------------------------
// (1) Rendering — compact density
// ---------------------------------------------------------------------------

describe("ProjectQuickActions — rendering", () => {
  it("renders Folder, IDE, Terminal and provider label in compact mode", () => {
    renderActions();
    expect(screen.getByText("Folder")).toBeTruthy();
    expect(screen.getByText("IDE")).toBeTruthy();
    expect(screen.getByText("Terminal")).toBeTruthy();
    // default_provider = "claude" → badge label "Claude"
    expect(screen.getByText("Claude")).toBeTruthy();
  });

  it("does NOT render Refactor IA / README IA in compact density", () => {
    renderActions({}, "compact");
    expect(screen.queryByText("Refactor IA")).toBeNull();
    expect(screen.queryByText("README IA")).toBeNull();
  });

  it("renders Refactor IA and README IA in full density when path is set", () => {
    renderActions({}, "full");
    expect(screen.getByText("Refactor IA")).toBeTruthy();
    expect(screen.getByText("README IA")).toBeTruthy();
  });

  it("does NOT render Refactor IA / README IA in full density when path is null", () => {
    renderActions({ path: null }, "full");
    expect(screen.queryByText("Refactor IA")).toBeNull();
    expect(screen.queryByText("README IA")).toBeNull();
  });

  it("renders Codex label when default_provider is codex", () => {
    renderActions({ default_provider: "codex" });
    expect(screen.getByText("Codex")).toBeTruthy();
  });

  it("renders Gemini label when default_provider is gemini", () => {
    renderActions({ default_provider: "gemini" });
    expect(screen.getByText("Gemini")).toBeTruthy();
  });

  it("renders Launch all button when items has at least one non-folder item", () => {
    renderActions({
      items: [{ kind: "claude", cwd: "C:\\projects\\alpha" }],
    });
    expect(screen.getByText(/Launch all/)).toBeTruthy();
  });

  it("does NOT render Launch all when items is empty", () => {
    renderActions({ items: [] });
    expect(screen.queryByText(/Launch all/)).toBeNull();
  });

  it("renders individual item buttons in full density", () => {
    renderActions(
      {
        items: [
          { kind: "exe", path: "C:\\tools\\app.exe", label: "MyApp" },
        ],
      },
      "full",
    );
    expect(screen.getByText("MyApp")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// (2) Folder button is disabled when path is null
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
// (3) IDE button invokes open_project_in_ide with correct args
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
// (4) Terminal button: spawn_session when no onOpenTerminal callback
// ---------------------------------------------------------------------------

describe("ProjectQuickActions — Terminal action", () => {
  it("invokes spawn_session with correct cwd when no onOpenTerminal prop", async () => {
    renderActions();
    fireEvent.click(screen.getByText("Terminal"));
    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("spawn_session", {
        provider: "claude",
        cwd: BASE_PROJECT.path,
        prompt: null,
        flags: { dangerouslySkipPermissions: false },
      });
    });
  });

  it("calls onOpenTerminal callback instead of invoke when prop is provided", async () => {
    const cb = vi.fn();
    renderActions({}, "compact", cb);
    fireEvent.click(screen.getByText("Terminal"));
    expect(cb).toHaveBeenCalledOnce();
    // invoke must NOT have been called for spawn_session
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(
      "spawn_session",
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// (5) AI button invokes pty_spawn with the project's provider and cwd
// ---------------------------------------------------------------------------

describe("ProjectQuickActions — AI (pty_spawn) action", () => {
  it("invokes pty_spawn with correct projectId, provider and cwd for claude", async () => {
    renderActions({ default_provider: "claude" });
    fireEvent.click(screen.getByText("Claude"));
    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("pty_spawn", {
        projectId: BASE_PROJECT.id,
        cardId: null,
        provider: "claude",
        agent: null,
        cwd: BASE_PROJECT.path,
        prompt: null,
      });
    });
  });

  it("invokes pty_spawn with provider=codex when project uses codex", async () => {
    renderActions({ default_provider: "codex" });
    fireEvent.click(screen.getByText("Codex"));
    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("pty_spawn", {
        projectId: BASE_PROJECT.id,
        cardId: null,
        provider: "codex",
        agent: null,
        cwd: BASE_PROJECT.path,
        prompt: null,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// (6) Refactor IA uses button_prompts catalog prompt
// ---------------------------------------------------------------------------

describe("ProjectQuickActions — Refactor IA action", () => {
  it("resolves prompt from catalog then invokes spawn_session with rendered prompt", async () => {
    renderActions({}, "full");
    fireEvent.click(screen.getByText("Refactor IA"));

    const expectedPrompt =
      "Refactoriza el código en C:\\Users\\USER\\projects\\alpha para el proyecto Alpha.";

    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("spawn_session", {
        provider: "claude",
        cwd: BASE_PROJECT.path,
        prompt: expectedPrompt,
        flags: { dangerouslySkipPermissions: false },
      });
    });
  });

  it("falls back to hardcoded refactor prompt when getPrompt rejects", async () => {
    vi.mocked(getPrompt).mockRejectedValue(new Error("unknown button prompt key: projects.suggest_refactor"));

    renderActions({}, "full");
    fireEvent.click(screen.getByText("Refactor IA"));

    await waitFor(() => {
      const calls = vi.mocked(invoke).mock.calls;
      const spawnCall = calls.find(
        ([cmd, args]) =>
          cmd === "spawn_session" &&
          typeof (args as Record<string, unknown>).prompt === "string" &&
          ((args as Record<string, unknown>).prompt as string).toLowerCase().includes("refactor"),
      );
      expect(spawnCall).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// (7) README IA uses button_prompts catalog prompt
// ---------------------------------------------------------------------------

describe("ProjectQuickActions — README IA action", () => {
  it("resolves prompt from catalog then invokes spawn_session with rendered prompt", async () => {
    renderActions({}, "full");
    fireEvent.click(screen.getByText("README IA"));

    const expectedPrompt =
      "Genera un README para Alpha en C:\\Users\\USER\\projects\\alpha.";

    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("spawn_session", {
        provider: "claude",
        cwd: BASE_PROJECT.path,
        prompt: expectedPrompt,
        flags: { dangerouslySkipPermissions: false },
      });
    });
  });

  it("falls back to hardcoded README prompt when getPrompt rejects", async () => {
    vi.mocked(getPrompt).mockRejectedValue(new Error("unknown button prompt key: projects.generate_readme"));

    renderActions({}, "full");
    fireEvent.click(screen.getByText("README IA"));

    await waitFor(() => {
      const calls = vi.mocked(invoke).mock.calls;
      const spawnCall = calls.find(
        ([cmd, args]) =>
          cmd === "spawn_session" &&
          typeof (args as Record<string, unknown>).prompt === "string" &&
          ((args as Record<string, unknown>).prompt as string).toLowerCase().includes("readme"),
      );
      expect(spawnCall).toBeTruthy();
    });
  });
});
