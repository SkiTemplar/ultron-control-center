// Menús emergentes: se cierran con Escape y con clic fuera, no con clic dentro.

import { useRef, useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { useDismissable } from "../useDismissable";

function Menu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismissable(ref, open, () => setOpen(false));
  return (
    <div>
      <button type="button">Fuera</button>
      <div ref={ref}>
        <button type="button" aria-haspopup="menu" onClick={() => setOpen((v) => !v)}>
          Abrir
        </button>
        {open && (
          <div role="menu">
            <button type="button" role="menuitem">
              Opción
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

describe("useDismissable", () => {
  it("Escape cierra el menú y devuelve el foco al disparador", () => {
    render(<Menu />);
    fireEvent.click(screen.getByText("Abrir"));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByText("Abrir"));
  });

  it("un clic fuera cierra el menú", () => {
    render(<Menu />);
    fireEvent.click(screen.getByText("Abrir"));
    fireEvent.pointerDown(screen.getByText("Fuera"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("un clic dentro u otra tecla no lo cierran (caso negativo)", () => {
    render(<Menu />);
    fireEvent.click(screen.getByText("Abrir"));
    fireEvent.pointerDown(screen.getByText("Opción"));
    fireEvent.keyDown(document, { key: "Enter" });
    expect(screen.getByRole("menu")).toBeTruthy();
  });
});
