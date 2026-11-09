// Una sesión restaurada repone como `queued` el envío que estaba en vuelo al
// cerrar, con un aviso en `error` (AVISO_SENDING o «no se ha podido
// comprobar»). La fila de la cola tiene que enseñarlo: si no, el mensaje sale
// otra vez sin que el usuario sepa por qué.

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SesionesApi } from "../api";
import { QueuePanel } from "../components/composer/QueuePanel";
import { ApiContext } from "../context";
import { store } from "../store";
import type { QueueItem } from "../types";

const AVISO =
  "Se estaba enviando cuando se cerró ULTRON y no se ha podido comprobar en el transcript si llegó: saldrá otra vez en cuanto la sesión quede libre.";

const queued = (error?: string): QueueItem => ({
  clientId: "c1", text: "hola", attachments: [], delegate: false, kind: "prompt", origin: "ultron", state: "queued",
  createdAt: "2026-10-14T10:00:00Z", error,
});

function setup(id: string, item: QueueItem) {
  const api = { isMock: true } as unknown as SesionesApi;
  act(() => store.dispatch({ type: "queue", id, items: [item] }));
  render(<ApiContext.Provider value={api}><QueuePanel sessionId={id} /></ApiContext.Provider>);
}

afterEach(() => cleanup());

describe("Aviso de un elemento en cola", () => {
  it("un queued con error enseña el aviso en la fila", () => {
    setup("aviso1", queued(AVISO));
    const aviso = screen.getByTestId("queue-item-warn");
    expect(aviso.textContent).toContain("no se ha podido comprobar en el transcript");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("caso negativo: un queued sin error no enseña aviso", () => {
    setup("aviso2", queued());
    expect(screen.getByTestId("queue-item").textContent).toContain("hola");
    expect(screen.queryByTestId("queue-item-warn")).toBeNull();
  });
});
