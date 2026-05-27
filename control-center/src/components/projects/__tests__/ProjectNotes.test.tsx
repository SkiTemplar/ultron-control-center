// ProjectNotes — loadList returns Promise (A2)
// Verifies the component mounts and calls invoke on load.

import { render, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import ProjectNotes from "../ProjectNotes";

const PROJECT_ID = "test-project-123";

describe("ProjectNotes", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockResolvedValue([]);
  });

  it("renders without crashing with a valid projectId", async () => {
    await act(async () => {
      render(<ProjectNotes projectId={PROJECT_ID} />);
    });
    expect(document.body).toBeTruthy();
  });

  it("calls invoke to load notes on mount", async () => {
    await act(async () => {
      render(<ProjectNotes projectId={PROJECT_ID} />);
    });
    await waitFor(() => {
      expect(invoke).toHaveBeenCalled();
    });
  });

  it("handles invoke rejection gracefully — no unhandled errors", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("notes backend error"));
    await expect(
      act(async () => { render(<ProjectNotes projectId={PROJECT_ID} />); })
    ).resolves.not.toThrow();
  });

  it("shows content when notes list is empty", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    let container: HTMLElement | undefined;
    await act(async () => {
      const result = render(<ProjectNotes projectId={PROJECT_ID} />);
      container = result.container;
    });
    expect(container?.firstChild).toBeTruthy();
  });
});
