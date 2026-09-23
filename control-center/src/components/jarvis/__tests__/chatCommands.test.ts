import { describe, expect, it } from "vitest";
import { scrollParaVer,
  COMMANDS,
  helpText,
  parseEsfuerzo,
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
    expect(parseProvider("  ANTIGRAVITY ")).toBe("antigravity");
    // Gemini salio del relevo el 2026-09-20: ya no es un proveedor valido.
    expect(parseProvider("gemini")).toBeNull();
  });

  it("rechaza un proveedor inventado", () => {
    // Caso negativo: forzar a un nombre que no existe dejaría el chat
    // mandando a ninguna parte y sin decirlo.
    for (const malo of ["gpt-4", "deepseek", "", "claude2"]) {
      expect(parseProvider(malo)).toBeNull();
    }
  });
});

describe("parseEsfuerzo", () => {
  it("acepta los tres niveles", () => {
    expect(parseEsfuerzo("bajo")).toBe("bajo");
    expect(parseEsfuerzo(" ALTO ")).toBe("alto");
    expect(parseEsfuerzo("medio")).toBe("medio");
  });

  it("rechaza cualquier otro nivel", () => {
    // Caso negativo: "turbo" no puede caer en "alto" y encarecer todas las
    // respuestas sin que el usuario lo haya pedido.
    for (const malo of ["turbo", "high", "", "9"]) {
      expect(parseEsfuerzo(malo)).toBeNull();
    }
  });
});

describe("helpText", () => {
  it("lista un comando por línea", () => {
    const lineas = helpText().split("\n");
    expect(lineas).toHaveLength(COMMANDS.length);
    expect(lineas[0]).toContain("/nueva");
    expect(helpText()).toContain("/migrar <claude|codex|antigravity|local>");
  });
});

describe("scrollParaVer (menú de «/», 2026-09-23)", () => {
  it("baja justo lo necesario para ver el elemento de abajo", () => {
    // 24 filas de 24 px en una lista de 320 px: la última empieza en 552.
    expect(scrollParaVer(552, 24, 0, 320)).toBe(256);
  });
  it("sube hasta el elemento si está por encima", () => {
    expect(scrollParaVer(0, 24, 256, 320)).toBe(0);
  });
  it("no mueve nada si ya se ve (caso negativo)", () => {
    expect(scrollParaVer(48, 24, 0, 320)).toBeNull();
  });
});
