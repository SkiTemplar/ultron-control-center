import { describe, expect, it } from "vitest";
import {
  COMMANDS,
  helpText,
  parseLine,
  parseProvider,
  suggestFor,
} from "../chatCommands";

describe("suggestFor", () => {
  it("propone todos los comandos al escribir solo la barra", () => {
    expect(suggestFor("/")).toHaveLength(COMMANDS.length);
  });

  it("filtra por prefijo", () => {
    const s = suggestFor("/mi");
    expect(s.map((c) => c.name)).toEqual(["/migrar"]);
  });

  it("no abre el menú en un mensaje normal", () => {
    // Caso negativo: sin esto, hablar de una ruta abría el desplegable encima
    // del texto que estás escribiendo.
    expect(suggestFor("mira en /tmp/logs")).toEqual([]);
    expect(suggestFor("")).toEqual([]);
    expect(suggestFor("hola")).toEqual([]);
  });

  it("con el comando ya escrito deja solo su ficha de argumentos", () => {
    expect(suggestFor("/migrar ").map((c) => c.name)).toEqual(["/migrar"]);
    // Un comando sin argumentos no tiene nada que sugerir después del espacio.
    expect(suggestFor("/cerrar ")).toEqual([]);
    expect(suggestFor("/inventado ")).toEqual([]);
  });
});

describe("parseLine", () => {
  it("distingue mensaje, comando y comando inexistente", () => {
    expect(parseLine("hola qué tal")).toEqual({ kind: "message", text: "hola qué tal" });
    expect(parseLine("/cerrar")).toEqual({ kind: "command", name: "/cerrar", arg: "" });
    expect(parseLine("/migrar gemini")).toEqual({
      kind: "command",
      name: "/migrar",
      arg: "gemini",
    });
    expect(parseLine("/noexiste x")).toEqual({ kind: "unknown", name: "/noexiste" });
  });

  it("acepta mayúsculas y espacios de sobra", () => {
    expect(parseLine("  /CERRAR  ")).toEqual({ kind: "command", name: "/cerrar", arg: "" });
    expect(parseLine("/titulo   router y dns  ")).toEqual({
      kind: "command",
      name: "/titulo",
      arg: "router y dns",
    });
  });
});

describe("parseProvider", () => {
  it("acepta los proveedores del catálogo", () => {
    expect(parseProvider("claude")).toBe("claude");
    expect(parseProvider("  GEMINI ")).toBe("gemini");
  });

  it("rechaza un proveedor inventado", () => {
    // Caso negativo: forzar a un nombre que no existe dejaría el chat
    // mandando a ninguna parte y sin decirlo.
    for (const malo of ["gpt-4", "deepseek", "", "claude2"]) {
      expect(parseProvider(malo)).toBeNull();
    }
  });
});

describe("helpText", () => {
  it("lista un comando por línea", () => {
    const lineas = helpText().split("\n");
    expect(lineas).toHaveLength(COMMANDS.length);
    expect(lineas[0]).toContain("/nueva");
    expect(helpText()).toContain("/migrar <claude|codex|gemini|local>");
  });
});
