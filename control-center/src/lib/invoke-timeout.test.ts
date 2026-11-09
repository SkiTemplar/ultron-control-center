import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { invokeWithTimeout, InvokeTimeoutError } from "./invoke-timeout";

describe("invokeWithTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(null);
  });

  it("devuelve la respuesta si llega a tiempo", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(42);
    await expect(invokeWithTimeout<number>("cmd", { a: 1 }, 1_000)).resolves.toBe(42);
    expect(invoke).toHaveBeenCalledWith("cmd", { a: 1 });
  });

  it("propaga el error del comando tal cual", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("fallo del backend");
    await expect(invokeWithTimeout("cmd", undefined, 1_000)).rejects.toBe("fallo del backend");
  });

  it("rechaza con InvokeTimeoutError si no hay respuesta en el plazo", async () => {
    vi.mocked(invoke).mockImplementationOnce(() => new Promise(() => {}));
    const p = invokeWithTimeout("memory_stats", undefined, 5_000);
    const check = expect(p).rejects.toBeInstanceOf(InvokeTimeoutError);
    await vi.advanceTimersByTimeAsync(5_001);
    await check;
    await expect(p).rejects.toThrow(/«memory_stats» en 5 s/);
  });

  it("no rechaza antes de agotar el plazo", async () => {
    let settled = false;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise(() => {}));
    invokeWithTimeout("cmd", undefined, 5_000).catch(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(4_900);
    expect(settled).toBe(false);
  });

  it("convierte un throw síncrono de invoke en rechazo", async () => {
    vi.mocked(invoke).mockImplementationOnce(() => {
      throw new Error("sin IPC");
    });
    await expect(invokeWithTimeout("cmd", undefined, 1_000)).rejects.toThrow("sin IPC");
  });
});
