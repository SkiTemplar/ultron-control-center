// Formulario de hooks (hooks-8, auditoría 2026-10-23): timeout y async se
// pueden fijar desde la UI y el mensaje de guardado enseña el resultado de
// regenerar hooks/manifest.json.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HookFormModal, parseTimeout } from "./HookFormModal";
import type { HookRecord } from "./types";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const hook: HookRecord = {
  id: "hk_1",
  event: "Stop",
  matcher: "*",
  command: "node a.js",
  enabled: true,
  source: "user",
  description: null,
  extra: { timeout: 15, async: true },
};

describe("parseTimeout", () => {
  it("vacío es 0 (sin tope propio) y acepta enteros hasta 600", () => {
    expect(parseTimeout("")).toBe(0);
    expect(parseTimeout(" 30 ")).toBe(30);
    expect(parseTimeout("600")).toBe(600);
  });
  it("rechaza lo que no es un entero válido", () => {
    expect(parseTimeout("abc")).toBeUndefined();
    expect(parseTimeout("1.5")).toBeUndefined();
    expect(parseTimeout("601")).toBeUndefined();
  });
});

describe("HookFormModal", () => {
  beforeEach(() => invokeMock.mockReset());

  it("edita timeout y async y envía los dos al backend", async () => {
    invokeMock.mockResolvedValue({ success: true, hook: null, backup_path: "b", manifest_sync: "manifest regenerado: 31 hooks" });
    const onSaved = vi.fn();
    render(<HookFormModal mode="edit" initial={hook} onClose={() => {}} onSaved={onSaved} />);
    const timeout = screen.getByLabelText("Timeout en segundos") as HTMLInputElement;
    const async = screen.getByLabelText("Async") as HTMLInputElement;
    expect(timeout.value).toBe("15");
    expect(async.checked).toBe(true);
    fireEvent.change(timeout, { target: { value: "45" } });
    fireEvent.click(async);
    fireEvent.click(screen.getByText("Guardar"));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(invokeMock).toHaveBeenCalledWith(
      "update_hook",
      expect.objectContaining({ id: "hk_1", timeout: 45, runAsync: false }),
    );
    expect(onSaved.mock.calls[0][0]).toContain("manifest regenerado");
  });

  it("un timeout inválido no llega al backend", async () => {
    render(<HookFormModal mode="add" onClose={() => {}} onSaved={() => {}} />);
    fireEvent.change(screen.getByRole("textbox", { name: /Comando/ }), { target: { value: "node x.js" } });
    fireEvent.change(screen.getByLabelText("Timeout en segundos"), { target: { value: "diez" } });
    fireEvent.click(screen.getByText("Añadir hook", { selector: "button" }));
    await screen.findByText(/número entero de segundos/);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
