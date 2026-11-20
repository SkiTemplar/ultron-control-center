import { afterEach, describe, expect, it, vi } from "vitest";
import mainSource from "../main.tsx?raw";
import { DEFAULT_FONT, FONTS, applyFont, fontVars, getFont, loadFontId, saveFontId } from "../fonts";
import { applyTheme } from "../themes";

describe("fuentes del chat", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    document.documentElement.removeAttribute("style");
  });

  it("Geist Mono es la de por defecto y no hay ids repetidos", () => {
    expect(DEFAULT_FONT).toBe("geist-mono");
    expect(new Set(FONTS.map((f) => f.id)).size).toBe(FONTS.length);
    expect(fontVars(getFont(DEFAULT_FONT))["--f-chat"]).toBe("var(--f-mono)");
  });

  it("toda pila acaba en la genérica monospace", () => {
    for (const f of FONTS) expect(f.mono).toMatch(/, monospace$/);
  });

  it("cada familia «Variable» de una pila está importada en main.tsx", () => {
    for (const f of FONTS) {
      for (const [, family] of f.mono.matchAll(/"([^"]+) Variable"/g)) {
        const pkg = `@fontsource-variable/${family.toLowerCase().replace(/ /g, "-")}`;
        expect(mainSource).toContain(`import "${pkg}";`);
      }
    }
  });

  it("aplica la fuente por CSSOM y la proporcional solo cambia el chat", () => {
    applyFont("jetbrains-mono");
    const root = document.documentElement;
    expect(root.getAttribute("data-font")).toBe("jetbrains-mono");
    expect(root.style.getPropertyValue("--f-mono")).toContain("JetBrains Mono Variable");
    expect(root.style.getPropertyValue("--f-chat")).toBe("var(--f-mono)");
    applyFont("geist");
    expect(root.style.getPropertyValue("--f-chat")).toBe("var(--f-body)");
    expect(root.style.getPropertyValue("--f-mono")).toContain("Geist Mono Variable");
    expect(document.querySelectorAll("style").length).toBe(0);
  });

  it("cambiar de tema no pisa la fuente elegida", () => {
    applyFont("fira-code");
    applyTheme("neon");
    expect(document.documentElement.style.getPropertyValue("--f-mono")).toContain("Fira Code Variable");
  });

  it("persiste la fuente y tolera un valor inventado o un localStorage roto", () => {
    saveFontId("cascadia");
    expect(loadFontId()).toBe("cascadia");
    localStorage.setItem("ultron.sesiones.font", "comic-sans");
    expect(loadFontId()).toBe(DEFAULT_FONT);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denegado");
    });
    expect(loadFontId()).toBe(DEFAULT_FONT);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("cuota");
    });
    expect(() => saveFontId("geist")).not.toThrow();
  });
});
