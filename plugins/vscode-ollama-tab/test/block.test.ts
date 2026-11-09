import { describe, expect, it } from "vitest";
import {
  BLOCK_MAX_LINES,
  BLOCK_NUM_PREDICT,
  buildGenerateRequest,
  completionMode,
  sanitizeBlock,
} from "../src/logic";

describe("completionMode", () => {
  it("pide bloque en una linea vacia debajo de un comentario", () => {
    expect(completionMode("# programa que suma dos numeros:\n")).toBe("block");
    expect(completionMode("def main():\n    // suma\n    ")).toBe("block");
    expect(completionMode("# suma\n\n")).toBe("block");
  });

  it("pide linea si el cursor no esta en una linea vacia o encima no hay comentario", () => {
    expect(completionMode("# suma\nprint(")).toBe("line");
    expect(completionMode("x = 1\n")).toBe("line");
    expect(completionMode("")).toBe("line");
    expect(completionMode("\n\n")).toBe("line");
  });
});

describe("buildGenerateRequest en modo bloque", () => {
  const base = { model: "m", prefix: "# suma\n", suffix: "", maxPrefixChars: 3000, maxSuffixChars: 1000, keepAlive: "5m" };

  it("deja pasar saltos de linea y pide mas tokens", () => {
    const req = buildGenerateRequest({ ...base, mode: "block" });
    expect(req.options.stop).toEqual(["\n\n\n"]);
    expect(req.options.num_predict).toBe(BLOCK_NUM_PREDICT);
  });

  it("en modo linea sigue cortando en el primer salto", () => {
    const req = buildGenerateRequest(base);
    expect(req.options.stop).toEqual(["\n"]);
    expect(req.options.num_predict).toBe(48);
  });
});

describe("sanitizeBlock", () => {
  it("conserva varias lineas y quita \\r y el espacio final", () => {
    expect(sanitizeBlock("a = 1\r\nb = 2\nprint(a + b)\n\n", "")).toBe("a = 1\nb = 2\nprint(a + b)");
  });

  it("corta en BLOCK_MAX_LINES", () => {
    const raw = Array.from({ length: BLOCK_MAX_LINES + 5 }, (_, i) => `l${i}`).join("\n");
    expect(sanitizeBlock(raw, "")?.split("\n")).toHaveLength(BLOCK_MAX_LINES);
  });

  it("descarta lo vacio y lo que ya sigue al cursor", () => {
    expect(sanitizeBlock("  \n\n", "")).toBeNull();
    expect(sanitizeBlock(null, "")).toBeNull();
    expect(sanitizeBlock("print(1)", "\nprint(1)\n")).toBeNull();
  });
});
