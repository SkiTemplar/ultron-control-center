// Una edición en Settings surte efecto en el siguiente clic, también desde otra
// ventana: el catálogo no se guarda en memoria entre llamadas.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPrompt } from "./button-prompts";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const catalog = (prompt: string) => ({
  schema_version: 1,
  buttons: [{ key: "a.b", label: "", location: "", description: "", vars: [], prompt, default_prompt: prompt, edited: false }],
});

describe("getPrompt", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("devuelve el texto vigente tras una edición, sin reiniciar", async () => {
    invokeMock.mockResolvedValueOnce(catalog("original {x}"));
    expect(await getPrompt("a.b", { x: "1" })).toBe("original 1");
    invokeMock.mockResolvedValueOnce(catalog("editado {x}"));
    expect(await getPrompt("a.b", { x: "2" })).toBe("editado 2");
  });

  it("llamadas simultáneas comparten una sola lectura", async () => {
    invokeMock.mockResolvedValue(catalog("t"));
    await Promise.all([getPrompt("a.b"), getPrompt("a.b")]);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
