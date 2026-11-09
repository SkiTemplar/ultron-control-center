import { describe, expect, it } from "vitest";
import {
  blankMcp,
  configToEditable,
  editableToConfig,
  formatAge,
  parseOrigin,
  statusLabel,
  validateEditable,
} from "../utils";

describe("parseOrigin (H14)", () => {
  it("trata el ámbito de usuario de ~/.claude.json como editable", () => {
    expect(parseOrigin("user").kind).toBe("user");
    expect(parseOrigin("user-claudejson").kind).toBe("user");
  });

  it("separa el legado de settings.json del resto", () => {
    expect(parseOrigin("settings")).toEqual({ kind: "settings", label: "settings.json" });
  });

  it("no confunde proyectos, plugins ni orígenes desconocidos con el usuario", () => {
    expect(parseOrigin("project:Foo")).toEqual({ kind: "project", label: "Foo" });
    expect(parseOrigin("plugin:github")).toEqual({ kind: "plugin", label: "github" });
    expect(parseOrigin("otra-cosa").kind).toBe("unknown");
    expect(parseOrigin(undefined).kind).toBe("unknown");
  });
});

describe("editableToConfig", () => {
  it("escribe type explícito en stdio", () => {
    const m = { ...blankMcp(), name: "x", command: "npx", argsText: "-y\npkg" };
    expect(editableToConfig(m)).toEqual({ type: "stdio", command: "npx", args: ["-y", "pkg"] });
  });

  it("escribe type http o sse con la url", () => {
    const http = { ...blankMcp(), name: "x", transport: "http" as const, url: " https://a/mcp " };
    expect(editableToConfig(http)).toEqual({ type: "http", url: "https://a/mcp" });
    const sse = { ...http, transport: "sse" as const };
    expect(editableToConfig(sse)).toEqual({ type: "sse", url: "https://a/mcp" });
  });

  it("ida y vuelta de una entrada real con env", () => {
    const cfg = { type: "stdio", command: "cmd", args: ["/c", "npx", "pkg"], env: { TOKEN: "t" } };
    expect(editableToConfig(configToEditable("x", cfg))).toEqual(cfg);
  });
});

describe("validateEditable", () => {
  const m = { ...blankMcp(), name: "MiServidor", command: "node" };
  it("rechaza nombres con mayúsculas en un alta", () => {
    expect(validateEditable(m)).not.toBeNull();
  });
  it("acepta el nombre existente al editar", () => {
    expect(validateEditable(m, true)).toBeNull();
  });
  it("sigue exigiendo comando al editar", () => {
    expect(validateEditable({ ...m, command: " " }, true)).not.toBeNull();
  });
});

describe("statusLabel", () => {
  it("no reutiliza «unknown» ni «desconocido» para la salud sin dato", () => {
    expect(statusLabel("unknown", false, false)).toBe("sin comprobar");
    expect(statusLabel("ok", false, true)).toBe("sin comprobar");
  });
  it("mantiene el estado verificado cuando el dato es reciente", () => {
    expect(statusLabel("ok", false, false)).toBe("conectado");
    expect(statusLabel("degraded", true, false)).toBe("desconectado");
    expect(statusLabel("degraded", false, false)).toBe("degradado");
    expect(statusLabel("missing", false, false)).toBe("no encontrado");
  });
});

describe("formatAge", () => {
  it("formatea la antigüedad en español con espacio antes de la unidad", () => {
    expect(formatAge(10_000)).toBe("ahora mismo");
    expect(formatAge(5 * 60_000)).toBe("hace 5 min");
    expect(formatAge(20 * 3_600_000)).toBe("hace 20 h");
    expect(formatAge(3 * 86_400_000)).toBe("hace 3 d");
  });
});
