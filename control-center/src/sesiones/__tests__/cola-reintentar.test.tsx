// Hallazgo 20 (3): Reintentar un envío que la CLI no llegó a confirmar puede
// duplicarlo, porque Claude pudo recibirlo. Antes de reenviar se avisa y se pide
// confirmación; un fallo de otro tipo se reintenta al momento.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { QueuePanel } from "../components/composer/QueuePanel";
import { ApiContext } from "../context";
import { store } from "../store";
import type { QueueItem } from "../types";

const failed = (error: string): QueueItem => ({
  clientId: "c1", text: "hola", attachments: [], delegate: false, kind: "prompt", origin: "ultron", state: "failed",
  createdAt: "2026-10-13T10:00:00Z", error,
});

function setup(id: string, item: QueueItem) {
  const queueRetry = vi.fn(async () => [{ ...item, state: "queued" as const, error: undefined }]);
  const api = { isMock: true, queueRetry } as unknown as SesionesApi;
  act(() => store.dispatch({ type: "queue", id, items: [item] }));
  render(<ApiContext.Provider value={api}><QueuePanel sessionId={id} /></ApiContext.Provider>);
  return { queueRetry };
}

afterEach(() => cleanup());

describe("Reintentar en la cola", () => {
  it("sin confirmación de la CLI avisa de que puede haberse enviado y no reenvía hasta confirmar", async () => {
    const { queueRetry } = setup("q1", failed("La CLI no confirmó el envío"));
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(queueRetry).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog").textContent).toMatch(/puede que Claude ya lo recibiera/i);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reenviar igualmente" }));
      await Promise.resolve();
    });
    expect(queueRetry).toHaveBeenCalledWith({ id: "q1", clientId: "c1" });
  });

  it("cancelar el aviso no reenvía", () => {
    const { queueRetry } = setup("q2", failed("La CLI no confirmó el envío"));
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    fireEvent.click(screen.getByRole("button", { name: "No reenviar" }));
    expect(queueRetry).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("caso negativo: un fallo de escritura se reintenta sin aviso", async () => {
    const { queueRetry } = setup("q3", failed("no se pudo escribir en el PTY"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
      await Promise.resolve();
    });
    expect(queueRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
