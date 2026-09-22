// Un modelo que la suscripción NO permite: se ve, se lee por qué, y no se
// puede elegir.
//
// El 2026-09-22 el usuario pidió poder elegir entre los modelos que su
// suscripción alcanza («podría querer un opus 5, o un 4.6»). La tentación es
// esconder los que no alcanza, y es el peor de los dos errores: un modelo que
// desaparece parece una avería del programa, mientras que uno en gris que
// dice «rechazado por la cuenta el 22/09» explica la factura.
//
// Lo que se fija aquí es el contrato del desplegable: visible + aria-disabled
// + motivo a la vista, y `onChange` intacto tanto con ratón como con teclado.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HudSelect, opcionDeModelo } from "../HudSelect";
import type { ModeloInfo } from "../terminalCore";

const MODELOS: ModeloInfo[] = [
  { id: "claude-sonnet-5", label: "Sonnet 5", para: "el del día a día", permitido: "si" },
  {
    id: "claude-opus-5",
    label: "Opus 5",
    para: "lo más capaz",
    permitido: "no",
    motivo: "rechazado por la cuenta el 22/09: no existe o no tienes acceso",
    visto: "2026-09-22T11:00:00Z",
  },
  { id: "claude-haiku-4-5", label: "Haiku 4.5", para: "rápido y barato" },
];

function pintar(onChange = vi.fn()) {
  render(
    <HudSelect
      etiqueta="modelo"
      valor=""
      vacio="auto"
      opciones={MODELOS.map(opcionDeModelo)}
      onChange={onChange}
    />,
  );
  const boton = screen.getByRole("combobox", { name: "modelo" });
  fireEvent.click(boton);
  return { boton, onChange };
}

describe("opción de modelo que la cuenta no permite", () => {
  it("se sigue viendo, con su motivo y marcada como no elegible", () => {
    pintar();
    const opus = screen.getByRole("option", { name: /Opus 5/ });
    expect(opus.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText(/rechazado por la cuenta el 22\/09/)).toBeTruthy();
    // El resto de la lista no se toca.
    expect(screen.getByRole("option", { name: /Sonnet 5/ }).getAttribute("aria-disabled")).toBe(
      null,
    );
  });

  it("pulsarla no la elige", () => {
    const { onChange } = pintar();
    fireEvent.mouseDown(screen.getByRole("option", { name: /Opus 5/ }));
    expect(onChange).not.toHaveBeenCalled();
    // …y el desplegable se queda abierto para que se lea el motivo.
    expect(screen.getByRole("listbox", { name: "modelo" })).toBeTruthy();
  });

  it("el teclado la salta en vez de pararse encima", () => {
    const { boton, onChange } = pintar();
    // Lista real: "auto", Sonnet, Opus (vetado), Haiku. Desde "auto" bajar
    // dos veces tiene que llevar a Haiku, no a Opus.
    fireEvent.keyDown(boton, { key: "ArrowDown" });
    fireEvent.keyDown(boton, { key: "ArrowDown" });
    fireEvent.keyDown(boton, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("claude-haiku-4-5");
  });

  it("las flechas mueven el cursor de verdad, sin volver al principio", () => {
    // Regresión encontrada el 2026-09-22 al escribir la prueba de arriba: el
    // efecto que coloca el cursor al abrir se ejecutaba tras CADA render (su
    // lista de dependencias se reconstruye siempre), así que cada flecha
    // movía el resaltado y el render siguiente lo devolvía a la opción ya
    // elegida. Enter acababa eligiendo siempre lo mismo.
    const { boton, onChange } = pintar();
    fireEvent.keyDown(boton, { key: "ArrowDown" });
    fireEvent.keyDown(boton, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("claude-sonnet-5");
  });

  it("un modelo sin veredicto se ofrece igual", () => {
    // Caso negativo: "desconocido" NO es "no". Tratarlo como prohibido
    // escondería modelos que la suscripción sí permite, que es justo lo
    // contrario de lo que se pedía.
    const { onChange } = pintar();
    fireEvent.mouseDown(screen.getByRole("option", { name: /Haiku 4\.5/ }));
    expect(onChange).toHaveBeenCalledWith("claude-haiku-4-5");
  });
});

describe("opcionDeModelo", () => {
  it("traduce el veredicto del catálogo a la opción del desplegable", () => {
    expect(opcionDeModelo(MODELOS[0])).toEqual({
      id: "claude-sonnet-5",
      label: "Sonnet 5",
      hint: "el del día a día",
      deshabilitada: false,
      motivo: undefined,
    });
    expect(opcionDeModelo(MODELOS[1]).deshabilitada).toBe(true);
  });

  it("un vetado sin motivo dice algo igualmente", () => {
    // Sin esto la opción saldría en gris y muda, que es peor que no marcarla.
    const o = opcionDeModelo({ id: "x", label: "X", para: "", permitido: "no" });
    expect(o.motivo).toBe("tu suscripción no lo permite");
    expect(o.hint).toBe("x");
  });
});
