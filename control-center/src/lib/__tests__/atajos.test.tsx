// Los atajos se vuelven a pedir cuando el editor los guarda.
//
// Es la mitad que no se ve del editor: sin esto, cambiar una combinación en
// Ajustes → Atajos no haría nada hasta reiniciar la app, porque App.tsx pedía
// `get_in_app_shortcuts` una sola vez al montar.
//
// Se prueba el hook (`lib/atajos.ts`), que es lo que App.tsx usa, y no
// montando App: ese módulo arrastra la app entera (terminales incluidas) y la
// suite pasaba de 7,5 s a unos 80 s por un solo fichero. Medido el 2026-09-22.

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

import { useAtajos } from "../atajos";

/** Sonda: pinta el combo de `chat.nueva` y cuántas veces ha renderizado. */
function Sonda() {
  const { bindings, ref } = useAtajos();
  return (
    <div>
      <span data-testid="combo">{bindings["chat.nueva"] ?? "—"}</span>
      <span data-testid="ref">{ref.current["chat.nueva"] ?? "—"}</span>
    </div>
  );
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("useAtajos", () => {
  it("pide el mapa al montar y lo vuelve a pedir al oír «maria:atajos»", async () => {
    let combo = "Alt+N";
    vi.mocked(invoke).mockImplementation(async (cmd) =>
      cmd === "get_in_app_shortcuts" ? { "chat.nueva": combo } : null,
    );

    render(<Sonda />);
    await waitFor(() => expect(screen.getByTestId("combo").textContent).toBe("Alt+N"));

    combo = "Ctrl+Alt+J";
    window.dispatchEvent(new CustomEvent("maria:atajos"));
    await waitFor(() => expect(screen.getByTestId("combo").textContent).toBe("Ctrl+Alt+J"));
    // La copia que lee el manejador de teclado también se entera: es la que
    // decide de verdad qué tecla dispara qué.
    expect(screen.getByTestId("ref").textContent).toBe("Ctrl+Alt+J");
  });

  it("también atiende el evento histórico del backend", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) =>
      cmd === "get_in_app_shortcuts" ? { "chat.nueva": "Alt+N" } : null,
    );
    render(<Sonda />);
    await waitFor(() => expect(screen.getByTestId("combo").textContent).toBe("Alt+N"));
    const antes = vi.mocked(invoke).mock.calls.length;
    window.dispatchEvent(new CustomEvent("in-app-shortcuts-updated"));
    await waitFor(() =>
      expect(vi.mocked(invoke).mock.calls.length).toBeGreaterThan(antes),
    );
  });

  it("un evento cualquiera no provoca una lectura", async () => {
    // Caso negativo: releer con cada evento de ventana sería una llamada al
    // backend por cada clic.
    vi.mocked(invoke).mockImplementation(async (cmd) =>
      cmd === "get_in_app_shortcuts" ? { "chat.nueva": "Alt+N" } : null,
    );
    render(<Sonda />);
    await waitFor(() => expect(screen.getByTestId("combo").textContent).toBe("Alt+N"));
    const antes = vi.mocked(invoke).mock.calls.length;
    window.dispatchEvent(new CustomEvent("maria:otra-cosa"));
    await new Promise((r) => setTimeout(r, 20));
    expect(vi.mocked(invoke).mock.calls.length).toBe(antes);
  });

  it("si la lectura falla, se queda con el mapa que ya tenía", async () => {
    // Quedarse sin teclado porque una lectura suelta falló sería peor que
    // seguir con lo anterior.
    // El aviso a consola es a propósito (queda rastro del fallo); se silencia
    // aquí para no ensuciar la salida de la suite.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let fallar = false;
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd !== "get_in_app_shortcuts") return null;
      if (fallar) throw new Error("no pude leer el fichero");
      return { "chat.nueva": "Alt+N" };
    });
    render(<Sonda />);
    await waitFor(() => expect(screen.getByTestId("combo").textContent).toBe("Alt+N"));

    fallar = true;
    window.dispatchEvent(new CustomEvent("maria:atajos"));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId("combo").textContent).toBe("Alt+N");
    // Y el fallo no se traga: queda dicho por consola.
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
