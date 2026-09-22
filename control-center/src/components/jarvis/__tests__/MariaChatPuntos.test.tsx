// Puntos de control en el chat: deshacer lo que escribió un agente.
//
// Con «Acceso total» las CLI escriben en la carpeta del proyecto sin
// preguntar, así que mar.ia fotografía el árbol ANTES de cada respuesta
// (`maria/puntos.rs`) y el turno del asistente se guarda con el sha en
// `punto`. Aquí se prueba la parte de interfaz contra ese contrato, con
// `invoke` simulado: lo que importa es que el enlace aparezca solo cuando hay
// foto y que llame al comando con el modo y el corte correctos.
//
// Las rutas y los sha son inventados: el repositorio es público.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

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

const HILO = {
  id: "hilo-1",
  title: "conversacion de prueba",
  folder: "",
  created: "2026-09-22T10:00:00Z",
  updated: "2026-09-22T10:00:00Z",
  pinned: false,
  closed: false,
  turns: 4,
};

/** Hilo de cuatro turnos: solo la SEGUNDA respuesta trae punto de control.
 *  El turno 1 es la primera respuesta y no lo tiene (la conversación aún no
 *  tenía proyecto): es el caso negativo del enlace. */
const TURNOS = [
  { ts: "2026-09-22T10:00:00Z", role: "user", provider: "", text: "cambia el color" },
  {
    ts: "2026-09-22T10:00:10Z",
    role: "assistant",
    provider: "claude",
    text: "hecho",
    punto: null,
  },
  { ts: "2026-09-22T10:01:00Z", role: "user", provider: "", text: "ahora borra el fichero" },
  {
    ts: "2026-09-22T10:01:20Z",
    role: "assistant",
    provider: "claude",
    text: "borrado",
    punto: "aaaaaaaabbbbbbbbccccccccdddddddd11111111",
  },
];

const ENCARGO_CON_PUNTO = {
  id: "enc-1",
  thread_id: "hilo-1",
  provider: "codex",
  texto: "pasa los tests",
  estado: "hecho",
  creado: "2026-09-22T10:02:00Z",
  fin: "2026-09-22T10:03:00Z",
  resumen: "",
  punto: "eeeeeeeeffffffff0000000011111111ffffffff",
};

/** Lo que devuelve `maria_punto_volver`, con el contrato del comando. */
const RESTAURADO = { ficheros: 3, antes: "99999999aaaaaaaabbbbbbbbcccccccc", turnos: 2 };

type Opciones = { turnos?: unknown[]; encargos?: unknown[]; puntos?: unknown[] };

function montar({ turnos = TURNOS, encargos = [], puntos = [] }: Opciones = {}) {
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    if (cmd === "maria_threads_list") return [HILO];
    if (cmd === "maria_relay_thread") return turnos;
    if (cmd === "maria_encargos") return encargos;
    if (cmd === "maria_puntos_listar") return puntos;
    if (cmd === "maria_punto_volver") return RESTAURADO;
    if (cmd === "maria_relay_config") return { order: ["claude"], disabled: [] };
    return null;
  });
  return render(<MariaChat compacto hiloInicial="hilo-1" />);
}

/** La última llamada a `invoke` con ese comando. */
function llamada(cmd: string) {
  const c = vi.mocked(invoke).mock.calls.filter((x) => x[0] === cmd).pop();
  return c?.[1] as Record<string, unknown> | undefined;
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("volver a antes de una respuesta", () => {
  it("el enlace sale solo en el turno que tiene punto", async () => {
    montar();
    const enlaces = await screen.findAllByRole("button", {
      name: /volver a antes de esta respuesta/i,
    });
    // Caso negativo: hay DOS respuestas y solo una trae foto. Ofrecerlo en la
    // otra sería un botón que solo puede dar error (mandamiento 11).
    expect(enlaces).toHaveLength(1);
  });

  it("«solo el código» manda modo codigo y no toca la conversación", async () => {
    montar();
    fireEvent.click(
      await screen.findByRole("button", { name: /volver a antes de esta respuesta/i }),
    );
    const dialogo = await screen.findByRole("dialog", { name: /punto de control/i });
    fireEvent.click(
      screen.getByRole("button", { name: /solo el código del proyecto/i }),
    );

    await waitFor(() => expect(llamada("maria_punto_volver")).toBeTruthy());
    expect(llamada("maria_punto_volver")).toEqual({
      threadId: "hilo-1",
      sha: TURNOS[3].punto,
      modo: "codigo",
      // Sin truncar no viaja el corte: un número suelto borraría turnos.
      conservar: null,
    });
    expect(await screen.findByText(/3 ficheros restaurados/)).toBeTruthy();
    expect(dialogo).not.toBeInTheDocument();
  });

  it("«las dos» corta la conversación donde lo haría «editar»", async () => {
    montar();
    fireEvent.click(
      await screen.findByRole("button", { name: /volver a antes de esta respuesta/i }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /^las dos/i }));

    await waitFor(() => expect(llamada("maria_punto_volver")).toBeTruthy());
    // El turno 3 es la respuesta; el mensaje que la provocó es el 2, así que
    // se conservan 2 turnos (índices 0 y 1) — igual que `editar` sobre él.
    expect(llamada("maria_punto_volver")).toEqual({
      threadId: "hilo-1",
      sha: TURNOS[3].punto,
      modo: "todo",
      conservar: 2,
    });
    expect(await screen.findByText(/2 turnos quitados/)).toBeTruthy();
  });

  it("el encargo con punto se deshace, y solo el código", async () => {
    montar({ encargos: [ENCARGO_CON_PUNTO] });
    fireEvent.click(await screen.findByRole("button", { name: /deshacer/i }));
    const dialogo = await screen.findByRole("dialog", { name: /punto de control/i });
    // Un encargo no ocupa turnos tuyos: ofrecer «solo la conversación» sería
    // ofrecer algo que no se puede hacer.
    expect(
      screen.queryByRole("button", { name: /solo la conversación/i }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: /solo el código del proyecto/i }),
    );

    await waitFor(() => expect(llamada("maria_punto_volver")).toBeTruthy());
    expect(llamada("maria_punto_volver")).toEqual({
      threadId: "hilo-1",
      sha: ENCARGO_CON_PUNTO.punto,
      modo: "codigo",
      conservar: null,
    });
    expect(dialogo).not.toBeInTheDocument();
  });

  it("cancelar no llama a nadie", async () => {
    montar();
    fireEvent.click(
      await screen.findByRole("button", { name: /volver a antes de esta respuesta/i }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /^cancelar$/i }));
    expect(llamada("maria_punto_volver")).toBeUndefined();
  });
});

describe("/deshacer y /puntos", () => {
  /** Escribe una línea en la caja y la envía. */
  function escribir(texto: string) {
    const caja = screen.getByLabelText("mensaje") as HTMLInputElement;
    fireEvent.change(caja, { target: { value: texto } });
    fireEvent.submit(caja.closest("form") as HTMLFormElement);
  }

  it("/deshacer abre la confirmación del último punto", async () => {
    montar();
    await screen.findAllByText("borrado");
    escribir("/deshacer");
    await screen.findByRole("dialog", { name: /punto de control/i });
    // Desde el atajo no hay mensaje tuyo que marque el corte: solo el código.
    expect(screen.queryByRole("button", { name: /^las dos/i })).toBeNull();
  });

  it("/deshacer sin ningún punto lo dice en vez de callarse", async () => {
    // Caso negativo y el que justifica el mandamiento 11: sin foto no hay nada
    // que deshacer, y quedarse mudo deja al usuario creyendo que sí.
    montar({ turnos: [TURNOS[0], TURNOS[1]] });
    await screen.findAllByText("hecho");
    escribir("/deshacer");
    expect(
      await screen.findByText(/no hay ningún punto de control al que volver/),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("/puntos lista los que hay", async () => {
    montar({
      puntos: [
        { sha: "abcdef1234567890", ts: "2026-09-22T10:01:20Z", etiqueta: "antes de claude" },
      ],
    });
    escribir("/puntos");
    const aviso = await screen.findByText(/abcdef12/);
    expect(aviso.textContent).toContain("antes de claude");
  });

  it("/puntos sin ninguno explica cuándo se toman", async () => {
    montar({ puntos: [] });
    escribir("/puntos");
    expect(
      await screen.findByText(/no tiene puntos de control/),
    ).toBeTruthy();
  });
});
