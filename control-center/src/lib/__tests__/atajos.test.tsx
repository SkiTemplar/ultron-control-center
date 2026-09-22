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

import { decidirAtajo, useAtajos, type Pulsacion } from "../atajos";

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

describe("decidirAtajo", () => {
  /** Una pulsación, con los modificadores que se le pasen. */
  const pulsar = (key: string, mods: Partial<Pulsacion> = {}): Pulsacion => ({
    key,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
  });

  /** El resto del estado, con lo habitual: chat montado y paleta cerrada. */
  const decidir = (
    bindings: Record<string, string>,
    tecla: Pulsacion,
    extra: { escribiendo?: boolean; paletaAbierta?: boolean } = {},
  ) =>
    decidirAtajo({
      bindings,
      tecla,
      escribiendo: false,
      paletaAbierta: false,
      chat: ["chat.nueva", "chat.parar"],
      tabs: ["tab.usage", "tab.settings"],
      ...extra,
    });

  it("una tecla suelta en la paleta NO se come la letra mientras escribes", () => {
    // El defecto: las tres globales se miraban antes del corte por «estoy
    // escribiendo» y hacían `preventDefault()` igual, así que con la Q sola
    // guardada en «Abrir la paleta de comandos» esa letra no se podía teclear
    // en ningún sitio de la app y la paleta parpadeaba en cada intento.
    const b = { "command.palette": "Q", "open.settings": "S", "refresh.all": "R" };
    expect(decidir(b, pulsar("q"), { escribiendo: true })).toBeNull();
    expect(decidir(b, pulsar("s"), { escribiendo: true })).toBeNull();
    expect(decidir(b, pulsar("r"), { escribiendo: true })).toBeNull();
    // Y fuera de una caja de texto sigue funcionando: la combinación está
    // guardada y el usuario la eligió.
    expect(decidir(b, pulsar("q"))).toEqual({ tipo: "global", id: "command.palette" });
    expect(decidir(b, pulsar("s"))).toEqual({ tipo: "global", id: "open.settings" });
    expect(decidir(b, pulsar("r"))).toEqual({ tipo: "global", id: "refresh.all" });
  });

  it("con modificador las globales sí se disparan escribiendo", () => {
    // Que es el caso normal (Ctrl+K) y lo que no se puede romper al arreglar
    // lo de arriba: Ctrl+K no escribe ninguna letra en la caja.
    const b = { "command.palette": "Ctrl+K", "open.settings": "Ctrl+," };
    expect(decidir(b, pulsar("k", { ctrlKey: true }), { escribiendo: true })).toEqual({
      tipo: "global",
      id: "command.palette",
    });
    expect(decidir(b, pulsar(",", { ctrlKey: true }), { escribiendo: true })).toEqual({
      tipo: "global",
      id: "open.settings",
    });
  });

  it("las acciones del chat se disparan escribiendo solo con modificador", () => {
    const b = { "chat.nueva": "Alt+N", "chat.parar": "P" };
    expect(decidir(b, pulsar("n", { altKey: true }), { escribiendo: true })).toEqual({
      tipo: "chat",
      id: "chat.nueva",
    });
    expect(decidir(b, pulsar("p"), { escribiendo: true })).toBeNull();
    // Fuera de la caja, la tecla suelta sí vale.
    expect(decidir(b, pulsar("p"))).toEqual({ tipo: "chat", id: "chat.parar" });
  });

  it("con la paleta abierta el chat no toca nada", () => {
    // Ahí Escape es de la paleta: robárselo dejaría la paleta sin poder
    // cerrarse con teclado.
    const b = { "chat.parar": "Escape" };
    expect(decidir(b, pulsar("Escape"), { paletaAbierta: true })).toBeNull();
    expect(decidir(b, pulsar("Escape"))).toEqual({ tipo: "chat", id: "chat.parar" });
  });

  it("los saltos de pestaña no se disparan mientras se escribe", () => {
    const b = { "tab.usage": "Alt+1" };
    expect(decidir(b, pulsar("1", { altKey: true }))).toEqual({
      tipo: "tab",
      id: "tab.usage",
    });
    expect(decidir(b, pulsar("1", { altKey: true }), { escribiendo: true })).toBeNull();
  });

  it("lo que no está en el mapa no dispara nada", () => {
    // Caso negativo: un mapa vacío (la lectura todavía no ha vuelto) o una
    // tecla sin dueño no pueden acabar en `preventDefault`.
    expect(decidir({}, pulsar("k", { ctrlKey: true }))).toBeNull();
    expect(decidir({ "command.palette": "Ctrl+K" }, pulsar("j", { ctrlKey: true }))).toBeNull();
    // Y los modificadores tienen que casar EXACTAMENTE: si no, «Alt+N»
    // saltaría también con Ctrl+Alt+N, que puede ser otra acción.
    expect(
      decidir({ "chat.nueva": "Alt+N" }, pulsar("n", { altKey: true, ctrlKey: true })),
    ).toBeNull();
  });

  it("una acción del chat que no está publicada no se ejecuta", () => {
    // Fuera de la pestaña Chat la lista llega vacía: el atajo no puede actuar
    // y no debe fingir que sí (mandamiento 11).
    expect(
      decidirAtajo({
        bindings: { "chat.nueva": "Alt+N" },
        tecla: pulsar("n", { altKey: true }),
        escribiendo: false,
        paletaAbierta: false,
        chat: [],
        tabs: [],
      }),
    ).toBeNull();
  });
});
