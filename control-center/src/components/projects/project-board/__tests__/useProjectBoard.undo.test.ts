// Borrar una tarjeta del kanban se puede deshacer durante unos segundos.

import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { CARD_DELETE_UNDO_MS, useProjectBoard } from "../useProjectBoard";

const BOARD = {
  columns: [{ id: "todo", name: "Backlog", role: "todo", order: 0 }],
  cards: [
    { id: "c1", title: "Primera", column_id: "todo", order: 0, tags: [], runs: [] },
    { id: "c2", title: "Segunda", column_id: "todo", order: 1, tags: [], runs: [] },
  ],
};

function deleteCalls() {
  return vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "kanban_delete_card");
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "kanban_load" ? BOARD : null));
});

afterEach(() => {
  vi.useRealTimers();
});

async function mountBoard() {
  const hook = renderHook(() => useProjectBoard("p1"));
  await waitFor(() => expect(hook.result.current.board).not.toBeNull());
  vi.useFakeTimers();
  return hook;
}

describe("useProjectBoard · borrar con deshacer", () => {
  it("oculta la tarjeta al momento y no la borra hasta que vence el plazo", async () => {
    const { result } = await mountBoard();
    await act(async () => {
      await result.current.deleteCard("c1");
    });
    expect(result.current.board?.cards.map((c) => c.id)).toEqual(["c2"]);
    expect(result.current.pendingDelete).toEqual({ cardId: "c1", title: "Primera" });
    expect(deleteCalls()).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CARD_DELETE_UNDO_MS + 10);
    });
    expect(deleteCalls()).toHaveLength(1);
    expect(deleteCalls()[0][1]).toEqual({ projectId: "p1", cardId: "c1" });
  });

  it("Deshacer la devuelve y no llama al backend (caso negativo)", async () => {
    const { result } = await mountBoard();
    await act(async () => {
      await result.current.deleteCard("c1");
    });
    act(() => result.current.undoDeleteCard());
    expect(result.current.board?.cards.map((c) => c.id)).toEqual(["c1", "c2"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CARD_DELETE_UNDO_MS * 2);
    });
    expect(deleteCalls()).toHaveLength(0);
  });

  it("desmontar el tablero confirma el borrado pendiente", async () => {
    const { result, unmount } = await mountBoard();
    await act(async () => {
      await result.current.deleteCard("c2");
    });
    unmount();
    expect(deleteCalls()).toHaveLength(1);
  });
});
