// El editor de atajos: capturar, guardar, y qué pasa cuando Rust dice que no.
//
// Se prueba contra el contrato de `get_in_app_shortcuts` /
// `set_in_app_shortcuts` con `invoke` simulado: lo que importa aquí es que la
// combinación capturada salga en el formato EXACTO que App.tsx compara, que el
// rechazo se vea en la fila culpable y que al guardar se avise a la ventana —
// sin eso, un atajo nuevo no valdría hasta reiniciar la app.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

import { AtajosSection, comboDeTecla, filasDelError } from "../AtajosSection";

/**
 * Las acciones que el backend conoce: `in_app_shortcuts::default_bindings`.
 *
 * Hace falta aquí porque el doble de `set_in_app_shortcuts` tiene que
 * RECHAZAR lo mismo que rechaza Rust (`validar`, in_app_shortcuts.rs:233: «no
 * conozco la accion …»). El doble anterior devolvía `{ ...ATAJOS, ...bindings }`
 * sin mirar las claves, así que certificaba en verde un guardado que en
 * producción siempre daba error (2026-09-22).
 *
 * `tab.futura` está a propósito: una acción que Rust ya tiene y esta pantalla
 * todavía no sabe nombrar. Es el caso que justifica enseñar el id crudo, y NO
 * es lo mismo que un id que el backend no conoce.
 */
const CATALOGO = ["command.palette", "chat.nueva", "chat.parar", "tab.futura"];

/** Lo que sirve Rust: por defecto + fichero, ya fundidos. */
const ATAJOS: Record<string, string> = {
  "command.palette": "Ctrl+K",
  "chat.nueva": "Alt+N",
  "chat.parar": "Escape",
  "tab.futura": "Alt+Q",
};

/** `set_in_app_shortcuts` con el contrato del de verdad. */
function guardarComoRust(bindings: Record<string, string>): Record<string, string> {
  for (const id of Object.keys(bindings)) {
    if (!CATALOGO.includes(id)) {
      throw new Error(`no conozco la accion «${id}»: quitala del fichero`);
    }
  }
  return { ...ATAJOS, ...bindings };
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    if (cmd === "get_in_app_shortcuts") return ATAJOS;
    return null;
  });
});

/** La fila (elemento `<tr>`) de una acción, por su id. */
function fila(id: string): HTMLElement {
  const celda = screen.getByText(id);
  const tr = celda.closest("tr");
  if (!tr) throw new Error(`sin fila para ${id}`);
  return tr;
}

describe("comboDeTecla", () => {
  it("escribe el combo como los valores por defecto de Rust", () => {
    expect(
      comboDeTecla({ key: "n", ctrlKey: false, altKey: true, shiftKey: false, metaKey: false }),
    ).toBe("Alt+N");
    expect(
      comboDeTecla({ key: "k", ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }),
    ).toBe("Ctrl+K");
    expect(
      comboDeTecla({ key: ",", ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }),
    ).toBe("Ctrl+,");
    expect(
      comboDeTecla({ key: "Escape", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }),
    ).toBe("Escape");
    // Orden fijo Ctrl, Alt, Shift, Meta: el mismo del fichero.
    expect(
      comboDeTecla({ key: "p", ctrlKey: true, altKey: false, shiftKey: true, metaKey: false }),
    ).toBe("Ctrl+Shift+P");
  });

  it("un modificador suelto todavía no es un atajo", () => {
    // Caso negativo: al pulsar Alt+N llega primero un keydown de "Alt". Si se
    // aceptara, el atajo capturado sería «Alt» y no casaría con nada.
    for (const key of ["Alt", "Control", "Shift", "Meta"]) {
      expect(
        comboDeTecla({ key, ctrlKey: false, altKey: true, shiftKey: false, metaKey: false }),
      ).toBeNull();
    }
  });
});

describe("filasDelError", () => {
  it("reparte el rechazo entre las acciones que nombra", () => {
    const ids = ["chat.nueva", "chat.parar", "command.palette"];
    expect(filasDelError("«Alt+N» esta en chat.nueva y en chat.parar", ids)).toEqual([
      "chat.nueva",
      "chat.parar",
    ]);
  });

  it("un mensaje que no nombra a nadie no se cuelga de una fila al azar", () => {
    // Caso negativo: colgarlo de la primera fila acusaría a una acción que no
    // tiene nada que ver. Sin culpables, el aviso va arriba.
    expect(filasDelError("no pude escribir el fichero", ["chat.nueva"])).toEqual([]);
  });
});

describe("la pestaña Atajos", () => {
  it("pone nombre en castellano a cada acción y enseña tal cual las que no conoce", async () => {
    render(<AtajosSection />);
    expect(await screen.findByText("Abrir la paleta de comandos")).toBeTruthy();
    // La etiqueta de las chat.* sale de la lista única de acciones del chat.
    expect(screen.getByText("Chat · conversación nueva")).toBeTruthy();
    // Un id que Rust tenga y React no: se enseña, no se esconde.
    expect(fila("tab.futura").textContent).toContain("Alt+Q");
  });

  it("captura una combinación, la guarda y avisa a la ventana", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      if (cmd === "get_in_app_shortcuts") return ATAJOS;
      if (cmd === "set_in_app_shortcuts") {
        return guardarComoRust((args as { bindings: Record<string, string> }).bindings);
      }
      return null;
    });
    const oido = vi.fn();
    window.addEventListener("maria:atajos", oido);

    render(<AtajosSection />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: /capturar la combinación de Chat · conversación nueva/i,
      }),
    );
    // La captura escucha en `document`, en fase de captura.
    fireEvent.keyDown(document, { key: "j", altKey: true, ctrlKey: true });
    await waitFor(() => expect(fila("chat.nueva").textContent).toContain("Ctrl+Alt+J"));

    fireEvent.click(screen.getByRole("button", { name: "guardar" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("guardado"));

    const enviado = vi
      .mocked(invoke)
      .mock.calls.filter((c) => c[0] === "set_in_app_shortcuts")
      .pop();
    expect((enviado?.[1] as { bindings: Record<string, string> }).bindings["chat.nueva"]).toBe(
      "Ctrl+Alt+J",
    );
    // Sin este evento, App.tsx seguiría con el mapa de cuando se montó.
    expect(oido).toHaveBeenCalled();
    window.removeEventListener("maria:atajos", oido);
  });

  it("«por defecto» manda la cadena vacía", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      if (cmd === "get_in_app_shortcuts") return ATAJOS;
      if (cmd === "set_in_app_shortcuts") {
        // La cadena vacía es un valor válido para una acción conocida: es
        // «devuélvela a la de fábrica», no un id inventado.
        return guardarComoRust((args as { bindings: Record<string, string> }).bindings);
      }
      return null;
    });
    render(<AtajosSection />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: /devolver Chat · conversación nueva a su combinación de fábrica/i,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "guardar" }));
    await waitFor(() => {
      const enviado = vi
        .mocked(invoke)
        .mock.calls.filter((c) => c[0] === "set_in_app_shortcuts")
        .pop();
      expect((enviado?.[1] as { bindings: Record<string, string> }).bindings["chat.nueva"]).toBe(
        "",
      );
    });
  });

  it("el rechazo del backend se pinta junto a la fila que lo provoca", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "get_in_app_shortcuts") return ATAJOS;
      if (cmd === "set_in_app_shortcuts") {
        throw new Error("«Ctrl+K» esta en chat.nueva y en command.palette");
      }
      return null;
    });
    render(<AtajosSection />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: /capturar la combinación de Chat · conversación nueva/i,
      }),
    );
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    await waitFor(() => expect(fila("chat.nueva").textContent).toContain("Ctrl+K"));

    fireEvent.click(screen.getByRole("button", { name: "guardar" }));
    await waitFor(() =>
      expect(fila("chat.nueva").textContent).toContain("esta en chat.nueva y en command.palette"),
    );
    // Y en la otra acción del choque, que es la mitad de la información.
    expect(fila("command.palette").textContent).toContain("command.palette");
    // Lo tocado NO se pierde al fallar: el usuario puede corregirlo sin
    // volver a capturarlo.
    expect(fila("chat.nueva").textContent).toContain("Ctrl+K");
  });

  it("un id que el backend no conoce deja el guardado bloqueado, y se ve dónde", async () => {
    // Caso negativo y el que el doble tapaba: `guardar()` manda el mapa ENTERO
    // (lo efectivo + lo tocado), así que basta UNA clave retirada en el fichero
    // —`tab.logs` salió de `default_bindings` en 5279b94— para que `validar`
    // corte en ella y NINGÚN cambio se pueda guardar. Hasta que el backend deje
    // de servir esas claves, esta pantalla al menos tiene que decir cuál es y
    // en qué fila, no fallar con un error genérico.
    const conRetirada = { ...ATAJOS, "tab.logs": "Alt+9" };
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      if (cmd === "get_in_app_shortcuts") return conRetirada;
      if (cmd === "set_in_app_shortcuts") {
        return guardarComoRust((args as { bindings: Record<string, string> }).bindings);
      }
      return null;
    });
    render(<AtajosSection />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: /capturar la combinación de Chat · conversación nueva/i,
      }),
    );
    fireEvent.keyDown(document, { key: "j", altKey: true, ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: "guardar" }));

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toContain("no conozco la accion «tab.logs»");
    // Y colgado de la fila que lo provoca, no de la que el usuario tocó.
    expect(alerta.closest("tr")?.textContent).toContain("tab.logs");
    // Nada de «guardado» cuando el backend ha dicho que no.
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("sin cambios el botón de guardar no puede actuar, y lo dice", async () => {
    // Caso negativo del mandamiento 11: nada de mandar un mapa idéntico al que
    // ya hay para fingir que ha pasado algo.
    render(<AtajosSection />);
    const guardar = (await screen.findByRole("button", { name: "guardar" })) as HTMLButtonElement;
    expect(guardar.disabled).toBe(true);
    expect(guardar.title).toContain("no has cambiado");
    fireEvent.click(guardar);
    expect(
      vi.mocked(invoke).mock.calls.filter((c) => c[0] === "set_in_app_shortcuts"),
    ).toHaveLength(0);
  });
});
