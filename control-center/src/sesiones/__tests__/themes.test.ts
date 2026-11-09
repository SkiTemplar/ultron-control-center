import { afterEach, describe, expect, it, vi } from "vitest";
import sesionesHtml from "../../../sesiones.html?raw";
import { DEFAULT_THEME, THEMES, applyTheme, contrastRatio, getTheme, loadThemeId, saveThemeId } from "../themes";

describe("temas", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("hay siete temas, Acero es el de por defecto y los tres primeros van en negro puro", () => {
    expect(THEMES.map((t) => t.id)).toEqual(["obsidiana", "vacio", "fosforo", "acero", "grafito", "medianoche", "ambar"]);
    expect(DEFAULT_THEME).toBe("acero");
    for (const id of ["obsidiana", "vacio", "fosforo"]) {
      expect(THEMES.find((t) => t.id === id)?.tokens.bg).toBe("#000000");
    }
  });

  it.each(THEMES.map((t) => [t.label, t] as const))("%s cumple contraste AA", (_label, t) => {
    const k = t.tokens;
    for (const surface of [k.bg, k.panel, k.raised]) {
      for (const color of [k.fg, k.muted, k.accent, k.info, k.ok, k.warn, k.err, k.codex, k.gemini]) {
        expect(contrastRatio(color, surface)).toBeGreaterThanOrEqual(4.5);
      }
    }
    // El texto tenue se usa en metadatos sobre fondo y panel.
    expect(contrastRatio(k.faint, k.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(k.faint, k.panel)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(k.accentFg, k.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(k.fg, k.add)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(k.fg, k.del)).toBeGreaterThanOrEqual(4.5);
  });

  it("aplica el tema por CSSOM sin inyectar <style> (la CSP de Tauri lo bloquearía)", () => {
    applyTheme("fosforo");
    const root = document.documentElement;
    expect(root.getAttribute("data-theme")).toBe("fosforo");
    expect(root.style.getPropertyValue("--accent")).toBe(getTheme("fosforo").tokens.accent);
    expect(root.style.getPropertyValue("--accent-fg")).toBe(getTheme("fosforo").tokens.accentFg);
    expect(root.style.getPropertyValue("--f-chat")).toBe("var(--f-mono)");
    applyTheme("obsidiana");
    expect(root.style.getPropertyValue("--accent")).toBe(getTheme("obsidiana").tokens.accent);
    expect(root.style.getPropertyValue("--gemini")).toBe(getTheme("obsidiana").tokens.gemini);
    // E2: el chat va en monoespaciada en todos los temas.
    expect(root.style.getPropertyValue("--f-chat")).toBe("var(--f-mono)");
    expect(document.querySelectorAll("style").length).toBe(0);
  });

  it("sesiones.html no lleva estilos inline (activarían el nonce de style-src)", () => {
    expect(sesionesHtml).toContain('id="root"');
    expect(sesionesHtml).not.toMatch(/<style|\sstyle=/i);
  });

  it("persiste el tema y tolera un localStorage roto", () => {
    saveThemeId("acero");
    expect(loadThemeId()).toBe("acero");
    localStorage.setItem("ultron.sesiones.theme", "inventado");
    expect(loadThemeId()).toBe(DEFAULT_THEME);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denegado");
    });
    expect(loadThemeId()).toBe(DEFAULT_THEME);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("cuota");
    });
    expect(() => saveThemeId("vacio")).not.toThrow();
  });
});
