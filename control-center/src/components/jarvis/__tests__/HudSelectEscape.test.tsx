// Escape sobre un desplegable de la cabecera: cierra el desplegable y NADA MÁS.
//
// `chat.parar` está atado a Escape en un listener de `window` (App.tsx), así
// que un Escape que llegue hasta arriba cancela el turno en curso. HudSelect
// hacía `preventDefault()` pero no `stopPropagation()`: cerrar el selector de
// proveedor mientras se escribía la respuesta la mataba (2026-09-22).
//
// El segundo caso es el que impide pasarse de frenada: con el desplegable
// CERRADO, Escape tiene que seguir llegando a `window`, o el atajo de parar
// dejaría de funcionar cada vez que el foco estuviese en uno de los cuatro
// selectores de la cabecera.

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HudSelect } from "../HudSelect";

const OPCIONES = [
  { id: "claude", label: "claude" },
  { id: "codex", label: "codex" },
];

let quitar: (() => void) | null = null;

/** Espía en `window`, igual que el que instala App.tsx para los atajos. */
function atajoGlobal() {
  const espia = vi.fn();
  window.addEventListener("keydown", espia);
  quitar = () => window.removeEventListener("keydown", espia);
  return espia;
}

afterEach(() => {
  quitar?.();
  quitar = null;
});

describe("Escape en un desplegable del HUD", () => {
  it("cierra el desplegable sin que el atajo de window lo vea", () => {
    const espia = atajoGlobal();
    render(
      <HudSelect etiqueta="proveedor" valor="claude" opciones={OPCIONES} onChange={vi.fn()} />,
    );
    const boton = screen.getByRole("combobox", { name: "proveedor" });

    fireEvent.click(boton);
    expect(screen.getByRole("listbox", { name: "proveedor" })).toBeTruthy();

    fireEvent.keyDown(boton, { key: "Escape" });

    expect(screen.queryByRole("listbox", { name: "proveedor" })).toBeNull();
    expect(espia).not.toHaveBeenCalled();
  });

  it("con el desplegable cerrado, Escape sigue siendo del chat", () => {
    // Caso negativo del arreglo: tragarse Escape siempre dejaría el atajo de
    // «parar» muerto mientras el foco estuviera en la cabecera.
    const espia = atajoGlobal();
    render(
      <HudSelect etiqueta="proveedor" valor="claude" opciones={OPCIONES} onChange={vi.fn()} />,
    );

    fireEvent.keyDown(screen.getByRole("combobox", { name: "proveedor" }), { key: "Escape" });

    expect(espia).toHaveBeenCalledTimes(1);
  });
});
