// HIGH de la auditoría 2026-11-01: App.tsx solo monta la pestaña activa, así que
// cambiar de pestaña desmontaba Notes y perdía lo escrito sin aviso.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Notes } from "../Notes";
import { loadDraft, saveDraft } from "../notes/draftStore";

const invokeMock = vi.hoisted(() => vi.fn());
const confirmMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../../lib/dialog", () => ({ confirmDialog: confirmMock }));

const NOTE = { slug: "idea", title: "Idea", size_bytes: 5, modified_iso: null, preview: "" };

function backend(onDisk = "disco") {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "notes_list_global") return [NOTE];
    if (cmd === "notes_load_global") return onDisk;
    return undefined;
  });
}

async function openAndEdit(text: string) {
  fireEvent.click(await screen.findByRole("button", { name: /Idea/ }));
  await screen.findByText("disco");
  fireEvent.click(await screen.findByRole("button", { name: "Editar" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Texto de la nota" }), {
    target: { value: text },
  });
}

describe("Notes: el borrador sobrevive al cambio de pestaña", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    confirmMock.mockReset();
    window.localStorage.clear();
    backend();
  });

  it("al desmontar y volver, recupera lo escrito y lo señala", async () => {
    const { unmount } = render(<Notes />);
    await openAndEdit("texto sin guardar");
    unmount();

    render(<Notes />);
    const editor = (await screen.findByRole("textbox", { name: "Texto de la nota" })) as HTMLTextAreaElement;
    expect(editor.value).toBe("texto sin guardar");
    expect(screen.getByRole("status").textContent).toContain("Borrador sin guardar recuperado");
    expect(invokeMock).not.toHaveBeenCalledWith("notes_save_global", expect.anything());
  });

  it("guardar borra el borrador", async () => {
    render(<Notes />);
    await openAndEdit("definitivo");
    expect(loadDraft("idea")).toBe("definitivo");
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("notes_save_global", { slug: "idea", body: "definitivo" }),
    );
    await waitFor(() => expect(loadDraft("idea")).toBeNull());
  });

  it("si guardar falla, el borrador se conserva", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "notes_list_global") return [NOTE];
      if (cmd === "notes_load_global") return "disco";
      if (cmd === "notes_save_global") throw new Error("disco lleno");
      return undefined;
    });
    render(<Notes />);
    await openAndEdit("no perder");
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await screen.findByText(/disco lleno/);
    expect(loadDraft("idea")).toBe("no perder");
  });

  it("cancelar y confirmar el descarte borra el borrador; rechazarlo no", async () => {
    render(<Notes />);
    await openAndEdit("quizá");
    confirmMock.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledOnce());
    expect(loadDraft("idea")).toBe("quizá");

    confirmMock.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(loadDraft("idea")).toBeNull());
  });

  it("un texto idéntico al del disco no es un borrador", async () => {
    render(<Notes />);
    await openAndEdit("disco");
    expect(loadDraft("idea")).toBeNull();
  });

  it("un borrador igual al disco no se recupera ni avisa", async () => {
    saveDraft("idea", "disco");
    render(<Notes />);
    fireEvent.click(await screen.findByRole("button", { name: /Idea/ }));
    await screen.findByRole("button", { name: "Editar" });
    expect(screen.queryByRole("status")).toBeNull();
    expect(loadDraft("idea")).toBeNull();
  });

  it("sin localStorage disponible lo dice en vez de fingir que está a salvo", async () => {
    render(<Notes />);
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    await openAndEdit("x");
    await screen.findByText(/No se pudo guardar el borrador/);
    spy.mockRestore();
  });
});
