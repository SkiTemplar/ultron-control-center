// ProjectQuickActions — unit tests (V1 redesign)
//
// Covers:
//   (1) Renders V1 base actions (Folder, IDE, AI provider label, Run batch).
//   (2) The removed actions (Terminal, Refactor IA, README IA) are gone in
//       both densities.
//   (3) Click IDE invokes `open_project_in_ide` with {path, preferredIde}.
//   (4) Click the AI button invokes `spawn_session` (external CLI) with the
//       project's provider + cwd — NOT pty_spawn.
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

function renderActions(
  overrides: Partial<ProjectInfo> = {},
  density: "compact" | "full" = "compact",
) {
  return render(
    <ProjectQuickActions
      project={{ ...BASE_PROJECT, ...overrides }}
      density={density}
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
  it("renders Folder, IDE, provider label and Run batch in compact mode", () => {
    renderActions();
    expect(screen.getByText("Folder")).toBeTruthy();
    expect(screen.getByText("IDE")).toBeTruthy();
    // default_provider = "claude" → badge label "Claude"
    expect(screen.getByText("Claude")).toBeTruthy();
    // BatchDropdown trigger
    expect(screen.getByText("Run batch")).toBeTruthy();
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

describe("ProjectQuickActions — AI (spawn_session) action", () => {
  it("invokes spawn_session with the project provider + cwd for claude", async () => {
    renderActions({ default_provider: "claude" });
    fireEvent.click(screen.getByText("Claude"));
    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("spawn_session", {
        provider: "claude",
        cwd: BASE_PROJECT.path,
        prompt: null,
        flags: { dangerouslySkipPermissions: false },
      });
    });
    // Must NOT use the embedded-terminal path.
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(
      "pty_spawn",
      expect.anything(),
    );
  });

  it("invokes spawn_session with provider=codex when project uses codex", async () => {
    renderActions({ default_provider: "codex" });
    fireEvent.click(screen.getByText("Codex"));
    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("spawn_session", {
        provider: "codex",
        cwd: BASE_PROJECT.path,
        prompt: null,
        flags: { dangerouslySkipPermissions: false },
      });
    });
  });
});
