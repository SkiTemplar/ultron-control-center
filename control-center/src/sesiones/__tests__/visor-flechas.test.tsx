// Visor de imágenes: las flechas cambian de imagen aunque la superficie de
// arrastre capture el puntero, dos clics en una flecha no amplían, y al
// alejar el zoom la imagen vuelve al centro en vez de quedarse desplazada.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageViewer, zoomTo } from "../components/ImageViewer";
import { ApiContext } from "../context";
import type { SesionesApi } from "../api";
import { setUi } from "../ui";

function abrir(): void {
  const items = [
    { src: "data:image/png;base64,AAAA", caption: "uno.png" },
    { src: "data:image/png;base64,BBBB", caption: "dos.png" },
  ];
  act(() => setUi((s) => ({ ...s, viewer: { items, index: 0 } })));
  render(
    <ApiContext.Provider value={{} as SesionesApi}>
      <ImageViewer />
    </ApiContext.Provider>,
  );
}

afterEach(() => {
  act(() => setUi((s) => ({ ...s, viewer: null })));
  vi.restoreAllMocks();
});

describe("visor de imágenes", () => {
  it("pulsar una flecha no captura el puntero y avanza", () => {
    const capture = vi.fn();
    HTMLElement.prototype.setPointerCapture = capture;
    abrir();
    const next = screen.getByRole("button", { name: "Siguiente" });
    fireEvent.pointerDown(next, { pointerId: 1 });
    fireEvent.click(next);
    expect(capture).not.toHaveBeenCalled();
    expect(screen.getByText(/dos\.png · 2\/2/)).toBeTruthy();
  });

  it("doble clic en una flecha no cambia el zoom", () => {
    abrir();
    const next = screen.getByRole("button", { name: "Siguiente" });
    fireEvent.doubleClick(next);
    expect(screen.getByText(/· 100 %/)).toBeTruthy();
  });

  it("alejar hasta 1× o menos recentra la imagen", () => {
    expect(zoomTo({ scale: 2, x: 140, y: 300 }, 1)).toEqual({ scale: 1, x: 0, y: 0 });
    expect(zoomTo({ scale: 2, x: 140, y: 300 }, 1.5)).toEqual({ scale: 1.5, x: 140, y: 300 });
  });
});
