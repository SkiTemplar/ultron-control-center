import { describe, expect, it } from "vitest";
import {
  caretOnFirstLine, caretOnLastLine, initialNav, mergeHistory, pushHistory, searchHistory, stepHistory,
} from "../components/composer/history";
import { buildPalette, recommendCommands, touchesTests, type RecoContext } from "../components/composer/palette";
import type { CommandDef } from "../types";

describe("historial de prompts (E5)", () => {
  const entries = ["tercero", "segundo", "primero"];

  it("↑ guarda el borrador, recorre del más reciente al más antiguo y para al final", () => {
    let step = stepHistory(entries, initialNav, "older", "mi borrador");
    expect(step).toEqual({ nav: { index: 0, draft: "mi borrador" }, text: "tercero" });
    step = stepHistory(entries, step!.nav, "older", "tercero");
    step = stepHistory(entries, step!.nav, "older", "segundo");
    expect(step?.text).toBe("primero");
    expect(stepHistory(entries, step!.nav, "older", "primero")).toBeNull();
  });

  it("↓ vuelve hasta el borrador intacto y no pasa de él (caso negativo)", () => {
    const a = stepHistory(entries, initialNav, "older", "borrador a medias")!;
    const b = stepHistory(entries, a.nav, "older", a.text)!;
    const c = stepHistory(entries, b.nav, "newer", b.text)!;
    expect(c.text).toBe("tercero");
    const d = stepHistory(entries, c.nav, "newer", c.text)!;
    expect(d).toEqual({ nav: { index: -1, draft: "borrador a medias" }, text: "borrador a medias" });
    expect(stepHistory(entries, d.nav, "newer", d.text)).toBeNull();
    expect(stepHistory([], initialNav, "older", "x")).toBeNull();
  });

  it("solo navega con el cursor en la primera o la última línea", () => {
    const text = "línea uno\nlínea dos";
    expect(caretOnFirstLine(text, 3)).toBe(true);
    expect(caretOnFirstLine(text, 12)).toBe(false);
    expect(caretOnLastLine(text, 12)).toBe(true);
    expect(caretOnLastLine(text, 3)).toBe(false);
  });

  it("añade sin duplicar el último, une con lo sembrado y busca sin repetir", () => {
    expect(pushHistory(["a"], "  a ")).toEqual(["a"]);
    expect(pushHistory(["a"], "")).toEqual(["a"]);
    expect(pushHistory(["a", "b"], "c", 2)).toEqual(["c", "a"]);
    expect(mergeHistory(["x"], ["x", "y", "y", "z"])).toEqual(["x", "y", "z"]);
    expect(searchHistory(["Arregla el HUD", "otra cosa", "arregla el hud"], "ARREGLA")).toEqual(["Arregla el HUD", "arregla el hud"]);
    expect(searchHistory(["a", "a", "b"], "")).toEqual(["a", "b"]);
    expect(searchHistory(["a"], "zzz")).toEqual([]);
  });
});

describe("paleta y recomendados (E6)", () => {
  const cmds: CommandDef[] = [
    { name: "compact", description: "Compacta", source: "builtin", kind: "prompt", needsArgs: false, immediate: false },
    { name: "relevo", description: "Relevo", source: "mod", origin: "ultron-relevo", kind: "prompt", needsArgs: false, immediate: false },
    { name: "probar", description: "Tests", source: "mod", kind: "prompt", needsArgs: false, immediate: false },
    { name: "mejorar", description: "Mejora el borrador", source: "mod", kind: "prompt", needsArgs: false, immediate: false },
    { name: "commit", description: "Commit", source: "skill", kind: "prompt", needsArgs: false, immediate: false },
    { name: "context", description: "Contexto usado", source: "builtin", kind: "prompt", needsArgs: false, immediate: false },
  ];
  const calm: RecoContext = { contextPct: 20, gitDirty: false, testsTouched: false };

  it("recomienda según el estado y nunca propone /mejorar (F14: solo bajo demanda)", () => {
    const r = recommendCommands({ contextPct: 82, gitDirty: true, testsTouched: true }, cmds).map((x) => x.name);
    expect(r).toEqual(["compact", "relevo", "commit", "probar"]);
    expect(r).not.toContain("mejorar");
  });

  it("no recomienda nada en calma, con el contexto justo en el umbral ni sin dato (caso negativo)", () => {
    expect(recommendCommands(calm, cmds)).toEqual([]);
    expect(recommendCommands({ ...calm, contextPct: 70 }, cmds)).toEqual([]);
    expect(recommendCommands({ ...calm, contextPct: null }, cmds)).toEqual([]);
  });

  it("no recomienda comandos que no existen en el catálogo (caso negativo)", () => {
    const noCommit = cmds.filter((c) => c.name !== "commit" && c.name !== "probar");
    expect(recommendCommands({ ...calm, gitDirty: true, testsTouched: true }, noCommit)).toEqual([]);
  });

  it("detecta ficheros de test tocados", () => {
    expect(touchesTests(["src/a.ts", "src/__tests__/a.test.ts"])).toBe(true);
    expect(touchesTests(["e2e/sesiones.spec.ts"])).toBe(true);
    expect(touchesTests(["src/latest.ts", "docs/testing.md"])).toBe(false);
  });

  it("pone los recomendados arriba, filtra por la consulta y no deja secciones vacías", () => {
    const recos = recommendCommands({ ...calm, contextPct: 90 }, cmds);
    const all = buildPalette(cmds, recos, "/");
    expect(all.map((s) => s.title)).toEqual(["Recomendados", "Comandos"]);
    expect(all[0].items.map((i) => i.name)).toEqual(["compact", "relevo"]);
    const co = buildPalette(cmds, recos, "/co");
    expect(co[0].items.map((i) => i.name)).toEqual(["compact"]);
    expect(co[1].items.map((i) => i.name).slice(0, 2)).toEqual(["commit", "context"]);
    // Un recomendado sale una sola vez (caso negativo: no se repite en «Comandos»).
    const names = all.flatMap((s) => s.items.map((i) => i.name));
    expect(names.filter((n) => n === "compact")).toHaveLength(1);
    expect(buildPalette(cmds, recos, "/zzz")).toEqual([]);
  });
});
