// Saltar al turno de un acierto de la búsqueda, viniendo de OTRA conversación.
//
// `onAbrirTurno` cambia de hilo y apunta el turno en el mismo lote. La carga de
// turnos es asíncrona, así que en el render intermedio `turns` y `turnoRefs`
// seguían siendo los de la conversación anterior: el efecto del salto
// encontraba un <article> viejo, centraba el turno equivocado y daba el salto
// por hecho, de modo que al llegar el hilo de destino ya no quedaba nada
// pendiente y la vista se iba al final (2026-09-22).
//
// Caso negativo real: la conversación A tiene MÁS turnos que el índice buscado,
// que es justo cuando el nodo viejo existe y el salto se pierde sin ruido.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

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

/** Dónde ha ido cada `scrollIntoView`. El del final del hilo usa `end`; el del
 *  salto a un turno, `center`: por eso se distinguen. */
const saltos: Array<{ texto: string; bloque: unknown }> = [];

beforeAll(() => {
  // jsdom no implementa scrollIntoView.
  Element.prototype.scrollIntoView = function (this: Element, opciones?: unknown) {
    const bloque =
      opciones && typeof opciones === "object"
        ? (opciones as { block?: unknown }).block
        : undefined;
    saltos.push({ texto: this.textContent ?? "", bloque });
  } as never;
});

const ficha = (id: string, title: string) => ({
  id,
  title,
  folder: "",
  created: "2026-09-01T10:00:00Z",
  updated: "2026-09-01T10:00:00Z",
  pinned: false,
  closed: false,
  turns: 3,
});

const turno = (ts: string, role: string, text: string) => ({ ts, role, provider: "", text });

const HILOS = [ficha("hilo-a", "conversacion primera"), ficha("hilo-b", "conversacion segunda")];

const TURNOS: Record<string, ReturnType<typeof turno>[]> = {
  // A tiene MÁS turnos que el índice buscado: el nodo viejo existe.
  "hilo-a": [
    turno("2026-09-01T10:00:00Z", "user", "uno de la primera"),
    turno("2026-09-01T10:00:01Z", "assistant", "dos de la primera"),
    turno("2026-09-01T10:00:02Z", "assistant", "tres de la primera"),
    turno("2026-09-01T10:00:03Z", "assistant", "cuatro de la primera"),
  ],
  "hilo-b": [
    turno("2026-09-02T10:00:00Z", "user", "uno de la segunda"),
    turno("2026-09-02T10:00:01Z", "assistant", "dos de la segunda"),
    turno("2026-09-02T10:00:02Z", "assistant", "tres de la segunda con el acierto"),
  ],
};

const ACIERTO = {
  thread_id: "hilo-b",
  titulo: "conversacion segunda",
  indice_turno: 2,
  rol: "assistant",
  fragmento: "tres de la segunda con el acierto",
  fecha: "2026-09-02T10:00:02Z",
};

beforeEach(() => {
  saltos.length = 0;
  vi.mocked(invoke).mockImplementation(async (cmd, args) => {
    const a = args as Record<string, unknown> | undefined;
    if (cmd === "maria_threads_list") return HILOS;
    if (cmd === "maria_relay_thread") return TURNOS[String(a?.threadId)] ?? [];
    if (cmd === "maria_threads_buscar") {
      return { resultados: [ACIERTO], hay_mas: false, recortados: [] };
    }
    return null;
  });
});

describe("saltar al turno de un acierto de otra conversación", () => {
  it("centra el turno del hilo de destino, no uno del hilo que estaba abierto", async () => {
    render(<MariaChat hiloInicial="hilo-a" />);
    await screen.findByText("cuatro de la primera");

    fireEvent.change(screen.getByLabelText("buscar conversación"), {
      target: { value: "acierto" },
    });
    const fila = await screen.findByTitle("conversacion segunda · turno 3", undefined, {
      timeout: 3000,
    });

    fireEvent.click(fila);
    await screen.findByText("tres de la segunda con el acierto");

    await waitFor(() => {
      expect(saltos.some((s) => s.bloque === "center")).toBe(true);
    });
    const centrados = saltos.filter((s) => s.bloque === "center");
    expect(centrados).toHaveLength(1);
    expect(centrados[0].texto).toContain("tres de la segunda con el acierto");
    expect(centrados[0].texto).not.toContain("de la primera");
  });
});
