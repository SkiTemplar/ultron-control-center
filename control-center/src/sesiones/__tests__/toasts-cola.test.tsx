// Avisos de error en cola: varios errores seguidos no se pisan, el mismo error se
// agrupa con contador y se cierran solos. Caso negativo: la cola no pasa del tope.

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_TOASTS, TOAST_MS, Toasts, pushToast } from "../components/Toasts";
import { store } from "../store";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("cola de avisos", () => {
  it("dos errores distintos se ven a la vez y el repetido suma ×2", () => {
    render(<Toasts />);
    act(() => store.dispatch({ type: "error", message: "uno" }));
    act(() => store.dispatch({ type: "error", message: "dos" }));
    act(() => store.dispatch({ type: "error", message: "dos" }));
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(2);
    expect(alerts[1].textContent).toContain("×2");
    expect(store.getState().error).toBeNull();
  });

  it("se cierran solos pasado el plazo", () => {
    vi.useFakeTimers();
    render(<Toasts />);
    act(() => store.dispatch({ type: "error", message: "efímero" }));
    expect(screen.getByRole("alert")).toBeTruthy();
    act(() => vi.advanceTimersByTime(TOAST_MS + 10));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("caso negativo: la cola guarda solo los últimos", () => {
    let list = pushToast([], "a");
    for (const t of ["b", "c", "d", "e"]) list = pushToast(list, t);
    expect(list).toHaveLength(MAX_TOASTS);
    expect(list.map((t) => t.text)).toEqual(["c", "d", "e"]);
  });
});
