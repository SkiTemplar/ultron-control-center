// Escape dentro del chat: cierra el menú de comandos SIN borrar lo escrito.
//
// La precedencia vive en `chatAcciones.ts::decidirEscape` y se prueba allí.
// Aquí se comprueba la parte que no es pura y que la propuesta daba por
// supuesta: que «conservando lo escrito» es verdad. Antes, Escape con el menú
// abierto hacía `setPrompt("")` y se llevaba el mensaje entero.
//
// Se monta en modo `compacto` a propósito: es el único en el que MariaChat
// atiende Escape por su cuenta. En la pestaña Chat lo ejecuta App a través de
// la lista de acciones publicada (lib/accionesChat.ts), que es la misma
// función.

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

// jsdom no implementa scrollIntoView y el chat baja al último turno al montar.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

// El setup global solo simula `open` de plugin-dialog y `openPath` de
// plugin-opener; MariaChat importa además `save` y `revealItemInDir`.
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
  save: vi.fn().mockResolvedValue(null),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn().mockResolvedValue(undefined),
  openUrl: vi.fn().mockResolvedValue(undefined),
  revealItemInDir: vi.fn().mockResolvedValue(undefined),
}));

import { MariaChat } from "../MariaChat";

describe("Escape en la caja de escribir", () => {
  it("cierra el menú de comandos y deja el texto donde estaba", () => {
    render(<MariaChat compacto hiloInicial="hilo-1" />);
    const caja = screen.getByLabelText("mensaje") as HTMLInputElement;

    fireEvent.change(caja, { target: { value: "/pro" } });
    expect(screen.getByRole("listbox", { name: /comandos disponibles/i })).toBeTruthy();

    fireEvent.keyDown(caja, { key: "Escape" });

    expect(screen.queryByRole("listbox", { name: /comandos disponibles/i })).toBeNull();
    expect(caja.value).toBe("/pro");
  });

  it("volver a escribir reabre el menú", () => {
    // Caso negativo del cierre: si `menuCerrado` no se soltara al tocar la
    // caja, el autocompletado quedaría muerto hasta cambiar de conversación.
    render(<MariaChat compacto hiloInicial="hilo-1" />);
    const caja = screen.getByLabelText("mensaje") as HTMLInputElement;
    fireEvent.change(caja, { target: { value: "/pro" } });
    fireEvent.keyDown(caja, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: /comandos disponibles/i })).toBeNull();

    fireEvent.change(caja, { target: { value: "/prov" } });
    expect(screen.getByRole("listbox", { name: /comandos disponibles/i })).toBeTruthy();
  });
});
