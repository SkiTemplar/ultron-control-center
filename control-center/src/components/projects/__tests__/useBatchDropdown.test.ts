// Cola de batch-capture en el desplegable «Ejecutar .bat» (hooks-6, auditoría
// 2026-10-23): la cola se drena y se cuenta al montar, y un fallo del drenaje
// o de la lectura llega a la UI en vez de quedarse en una lista vacía.

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBatchDropdown } from "../batch-dropdown/useBatchDropdown";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const entry = {
  id: "bq-1",
  name: "queued-aaaaaaaaaaaa.ps1",
  path: "",
  reason: "rejected",
  kind: "auto",
  description: null,
  created_at: "epoch:1",
  last_error: null,
  attempts: 1,
};

describe("useBatchDropdown: cola de capturas", () => {
  beforeEach(() => invokeMock.mockReset());

  it("drena y cuenta la cola al montar, sin abrir el desplegable", async () => {
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "batches_list_queue" ? { entries: [entry], drain_error: null } : [],
    );
    const { result } = renderHook(() => useBatchDropdown());
    await waitFor(() => expect(result.current.queue).toHaveLength(1));
    expect(invokeMock).toHaveBeenCalledWith("batches_list_queue");
    expect(result.current.open).toBe(false);
    expect(result.current.queueError).toBeNull();
  });

  it("un drenaje fallido llega a la UI y no oculta la cola", async () => {
    invokeMock.mockResolvedValue({ entries: [entry], drain_error: "rename pending: acceso denegado" });
    const { result } = renderHook(() => useBatchDropdown());
    await waitFor(() => expect(result.current.queueError).toContain("acceso denegado"));
    expect(result.current.queue).toHaveLength(1);
  });

  it("si la lectura falla lo dice en vez de enseñar una cola vacía sin más", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "batches_list_queue") throw new Error("queue.jsonl ilegible");
      return [];
    });
    const { result } = renderHook(() => useBatchDropdown());
    await waitFor(() => expect(result.current.queueError).toContain("queue.jsonl ilegible"));
    expect(result.current.queue).toEqual([]);
  });
});

describe("useBatchDropdown: un script solo se ejecuta tras revisarlo", () => {
  const script = {
    name: entry.name,
    path: "C:/x/" + entry.name,
    size_bytes: 12,
    content: "Remove-Item x",
    too_large: false,
  };

  function backend(preview: unknown = script) {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "batches_list_queue") return { entries: [entry], drain_error: null };
      if (cmd === "batch_read_script") {
        if (preview instanceof Error) throw preview;
        return preview;
      }
      if (cmd === "execute_batch") return { success: true, exit_code: 0, stdout: "ok", stderr: "" };
      return [];
    });
  }
  const executed = () => invokeMock.mock.calls.filter(([cmd]) => cmd === "execute_batch");

  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("pedir la ejecución enseña el script y no lanza nada", async () => {
    backend();
    const { result } = renderHook(() => useBatchDropdown());
    await act(() => result.current.requestRun(entry.name, entry as never));
    expect(result.current.review).toMatchObject({ status: "ready", script: { content: "Remove-Item x" } });
    expect(executed()).toHaveLength(0);
  });

  it("confirmar ejecuta con el contenido revisado y saca la entrada de la cola", async () => {
    backend();
    const { result } = renderHook(() => useBatchDropdown());
    await act(() => result.current.requestRun(entry.name, entry as never));
    await act(() => result.current.confirmRun());
    expect(executed()).toEqual([["execute_batch", { name: entry.name, reviewed: "Remove-Item x" }]]);
    expect(invokeMock).toHaveBeenCalledWith("batches_dismiss_queue", { id: entry.id });
    expect(result.current.review).toBeNull();
  });

  it("cancelar no lanza nada", async () => {
    backend();
    const { result } = renderHook(() => useBatchDropdown());
    await act(() => result.current.requestRun(entry.name, entry as never));
    act(() => result.current.cancelRun());
    await act(() => result.current.confirmRun());
    expect(result.current.review).toBeNull();
    expect(executed()).toHaveLength(0);
  });

  it("sin script legible no hay nada que confirmar", async () => {
    backend(new Error("batch 'x' not found"));
    const { result } = renderHook(() => useBatchDropdown());
    await act(() => result.current.requestRun(entry.name, entry as never));
    expect(result.current.review).toMatchObject({ status: "error" });
    await act(() => result.current.confirmRun());
    expect(executed()).toHaveLength(0);
  });

  it("un script que no cabe en la vista previa no se ejecuta", async () => {
    backend({ ...script, content: "", too_large: true });
    const { result } = renderHook(() => useBatchDropdown());
    await act(() => result.current.requestRun(entry.name));
    await act(() => result.current.confirmRun());
    expect(executed()).toHaveLength(0);
  });

  it("una lectura vieja no pisa la revisión de otro script", async () => {
    let releaseOld: (value: unknown) => void = () => {};
    invokeMock.mockImplementation((cmd: string, args?: { name?: string }) => {
      if (cmd === "batch_read_script" && args?.name === "viejo.ps1") {
        return new Promise((resolve) => { releaseOld = resolve; });
      }
      if (cmd === "batch_read_script") return Promise.resolve(script);
      return Promise.resolve({ entries: [], drain_error: null });
    });
    const { result } = renderHook(() => useBatchDropdown());
    void act(() => { void result.current.requestRun("viejo.ps1"); });
    await act(() => result.current.requestRun(entry.name));
    await act(async () => releaseOld({ ...script, name: "viejo.ps1", content: "viejo" }));
    expect(result.current.review).toMatchObject({ name: entry.name, script: { content: "Remove-Item x" } });
  });
});
