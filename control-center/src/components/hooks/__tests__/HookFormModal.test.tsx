// HookFormModal — el matcher no puede sobrevivir a un cambio de evento.
//
// El fallo (2026-09-22): el desplegable cambiaba de evento pero el estado
// `matcher` se quedaba con lo tecleado para el evento anterior. Con "Stop"
// elegido el modal pinta "no compara ningún campo: no admite matcher" y aun
// asi `add_hook` recibia matcher "Bash": settings.json acababa con un filtro
// que Claude Code ignora y que la lista de Hooks enseñaba como si acotara
// algo. Variante silenciosa: de PreToolUse (tool_name) a SessionStart
// (source) la caja sigue a la vista y arrastra un matcher que nunca casaria.
//
// Cubre:
//   (1) Cambiar a un evento sin campo esconde la caja y manda matcher null.
//   (2) Cambiar a un evento con OTRO campo vacia la caja y manda null.
//   (3) Cambiar entre dos eventos con EL MISMO campo NO borra lo tecleado.
//   (4) Sin tocar el evento, el matcher viaja tal cual (no sobra-limpieza).

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { HookFormModal } from "../HookFormModal";
import type { EventoHook } from "../constants";

// ---------------------------------------------------------------------------
// Catalogo de mentira, con los mismos campos que sirve `hooks_event_catalog`.
// ---------------------------------------------------------------------------

const CATALOGO: EventoHook[] = [
  { nombre: "PreToolUse", campo: "tool_name", valores: [], relajado: true },
  { nombre: "PostToolUse", campo: "tool_name", valores: [], relajado: true },
  { nombre: "SessionStart", campo: "source", valores: ["startup", "resume"], relajado: true },
  { nombre: "Stop", campo: null, valores: [], relajado: false },
];

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === "hooks_event_catalog") return CATALOGO;
    if (cmd === "add_hook") return { success: true, hook: null, backup_path: "settings.bak" };
    return null;
  });
});

// ---------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------

async function abrirAlta() {
  const utils = render(<HookFormModal mode="add" onClose={vi.fn()} onSaved={vi.fn()} />);
  // El desplegable se llena cuando responde el catalogo; hasta entonces no hay
  // ficha y la caja del matcher ni existe.
  await waitFor(() =>
    expect(utils.container.querySelectorAll("option")).toHaveLength(CATALOGO.length),
  );
  return utils;
}

const cajaMatcher = (c: HTMLElement) => c.querySelector<HTMLInputElement>('input[type="text"]');

function elegirEvento(c: HTMLElement, nombre: string) {
  fireEvent.change(c.querySelector("select")!, { target: { value: nombre } });
}

function escribirComando(c: HTMLElement, texto: string) {
  fireEvent.change(c.querySelector("textarea")!, { target: { value: texto } });
}

function guardar() {
  fireEvent.click(screen.getByRole("button", { name: "Add hook" }));
}

// ---------------------------------------------------------------------------
// (1) Evento sin campo: ni caja ni matcher guardado
// ---------------------------------------------------------------------------

describe("HookFormModal — cambiar de evento", () => {
  it("pasar a un evento que no compara nada tira el matcher tecleado", async () => {
    const { container } = await abrirAlta();

    fireEvent.change(cajaMatcher(container)!, { target: { value: "Bash" } });
    elegirEvento(container, "Stop");

    // La pantalla ya dice que ese evento no admite matcher...
    expect(cajaMatcher(container)).toBeNull();
    expect(screen.getByText(/no compara ningún campo/)).toBeInTheDocument();

    // ...y lo que se guarda tiene que decir lo mismo.
    escribirComando(container, "echo hola");
    guardar();

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("add_hook", {
        event: "Stop",
        matcher: null,
        command: "echo hola",
      }),
    );
  });

  // -------------------------------------------------------------------------
  // (2) Evento con otro campo: la caja sigue, pero vacia
  // -------------------------------------------------------------------------

  it("pasar a un evento que compara otro campo vacia la caja", async () => {
    const { container } = await abrirAlta();

    fireEvent.change(cajaMatcher(container)!, { target: { value: "Bash" } });
    elegirEvento(container, "SessionStart");

    // "Bash" nunca casaria contra `source`: no puede quedarse escrito.
    expect(cajaMatcher(container)!.value).toBe("");

    escribirComando(container, "echo hola");
    guardar();

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("add_hook", {
        event: "SessionStart",
        matcher: null,
        command: "echo hola",
      }),
    );
  });

  // -------------------------------------------------------------------------
  // (3) Mismo campo: no se borra nada (que la limpieza no se pase de lista)
  // -------------------------------------------------------------------------

  it("pasar a un evento que compara el mismo campo conserva el matcher", async () => {
    const { container } = await abrirAlta();

    fireEvent.change(cajaMatcher(container)!, { target: { value: "Bash" } });
    elegirEvento(container, "PostToolUse");

    expect(cajaMatcher(container)!.value).toBe("Bash");

    escribirComando(container, "echo hola");
    guardar();

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("add_hook", {
        event: "PostToolUse",
        matcher: "Bash",
        command: "echo hola",
      }),
    );
  });

  // -------------------------------------------------------------------------
  // (4) Sin tocar el evento, el matcher viaja tal cual
  // -------------------------------------------------------------------------

  it("sin cambiar de evento el matcher llega intacto", async () => {
    const { container } = await abrirAlta();

    fireEvent.change(cajaMatcher(container)!, { target: { value: "Bash|Write" } });
    escribirComando(container, "echo hola");
    guardar();

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("add_hook", {
        event: "PreToolUse",
        matcher: "Bash|Write",
        command: "echo hola",
      }),
    );
  });
});
