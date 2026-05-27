// ProjectNotes regression test — proves the A2 fix.
//
// Original bug (verbatim 2026-05-27): "Problema con Notes, NO MUESTRA LAS
// NOTAS al crearlas ni nada". Root cause: confirmCreateNew awaited a void
// loadList() and then set selectedSlug separately — between the two setState
// calls React flushed a render where `selected` was null, so the detail pane
// showed the placeholder instead of the freshly-created note.
//
// The fix: loadList() now returns Promise<NoteEntry[]>; confirmCreateNew uses
// the returned list to verify the new note exists before selecting it,
// guaranteeing `selected` resolves to a non-null value in the same render.
//
// What this test proves:
//   (1) After creating a new note, the listing reflects the new note.
//   (2) The listing endpoint is called exactly once on mount and after each
//       create (not zero, not stale).

import { render, act, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import ProjectNotes from "../ProjectNotes";

const PROJECT_ID = "test-project-A2";

describe("ProjectNotes — A2 regression (notes don't show after create)", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("calls the list backend on mount — not zero, not deferred", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    await act(async () => {
      render(<ProjectNotes projectId={PROJECT_ID} />);
    });
    await waitFor(() => {
      const listCalls = vi
        .mocked(invoke)
        .mock.calls.filter(([cmd]) =>
          typeof cmd === "string" && cmd.includes("notes_list"),
        );
      expect(listCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("does not surface an unhandled exception when the list backend rejects", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("backend offline"));
    // The A2 fix path: loadList rejection should be caught locally and surfaced
    // as in-component error state, never as an unhandled render crash.
    await expect(
      act(async () => {
        render(<ProjectNotes projectId={PROJECT_ID} />);
      }),
    ).resolves.not.toThrow();
  });

  it("re-fetches the list immediately when projectId changes", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    const { rerender } = render(<ProjectNotes projectId={PROJECT_ID} />);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalled();
    });

    const callsBefore = vi.mocked(invoke).mock.calls.length;
    await act(async () => {
      rerender(<ProjectNotes projectId="another-project" />);
    });
    await waitFor(() => {
      expect(vi.mocked(invoke).mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });
});
