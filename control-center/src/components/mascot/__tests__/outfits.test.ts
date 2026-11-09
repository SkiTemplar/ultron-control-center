import { describe, expect, it } from "vitest";
import { chooseHat, chooseLook, contextHat, gameLook, nightHat, seasonalHat } from "../outfits";
import type { GameEntry } from "../settings";

const uni = ["tfg-trabajofingrado", "cde-creaciondireccionempresas", "asignaturas"];
const fg = (exe: string, title = "") => ({ exe, title, uni_keys: uni });

describe("contextHat", () => {
  it("Unreal, Unity y Blender por el ejecutable", () => {
    expect(contextHat(fg("UnrealEditor.exe"))).toBe("hardhat");
    expect(contextHat(fg("Unity.exe"))).toBe("cap");
    expect(contextHat(fg("blender.exe"))).toBe("beret");
  });
  it("un proyecto de la uni por el título de la ventana", () => {
    expect(contextHat(fg("Code.exe", "main.tex - TFG-TrabajoFinGrado - Visual Studio Code"))).toBe("grad");
    expect(contextHat(fg("explorer.exe", "ASIGNATURAS"))).toBe("grad");
  });
  it("cualquier otra cosa: sin gorro", () => {
    expect(contextHat(fg("chrome.exe", "YouTube"))).toBeNull();
    expect(contextHat(null)).toBeNull();
  });
});

describe("temporada y noche", () => {
  it("Navidad y Halloween en sus fechas, nada el resto", () => {
    expect(seasonalHat(new Date(2026, 11, 24))).toBe("santa");
    expect(seasonalHat(new Date(2027, 0, 6))).toBe("santa");
    expect(seasonalHat(new Date(2026, 9, 31))).toBe("witch");
    expect(seasonalHat(new Date(2026, 9, 15))).toBeNull();
  });
  it("gorro de dormir de madrugada, o tarde si duerme", () => {
    expect(nightHat(new Date(2026, 9, 15, 2), false)).toBe("nightcap");
    expect(nightHat(new Date(2026, 9, 15, 23), false)).toBeNull();
    expect(nightHat(new Date(2026, 9, 15, 23), true)).toBe("nightcap");
    expect(nightHat(new Date(2026, 9, 15, 14), true)).toBeNull();
  });
  it("la noche es de 01:00 a 07:00 (límites incluidos y excluidos)", () => {
    const at = (h: number, m: number) => new Date(2026, 9, 15, h, m);
    expect(nightHat(at(0, 59), false)).toBeNull();
    expect(nightHat(at(1, 0), false)).toBe("nightcap");
    expect(nightHat(at(6, 59), false)).toBe("nightcap");
    expect(nightHat(at(7, 0), false)).toBeNull();
    expect(nightHat(at(0, 30), false)).toBeNull();
  });
  it("de 22:00 a 00:59 solo si duerme", () => {
    const at = (h: number, m: number) => new Date(2026, 9, 15, h, m);
    expect(nightHat(at(0, 59), true)).toBe("nightcap");
    expect(nightHat(at(22, 0), true)).toBe("nightcap");
    expect(nightHat(at(21, 59), true)).toBeNull();
    expect(nightHat(at(7, 0), true)).toBeNull();
  });
  it("lo que tienes abierto manda sobre la temporada y la noche", () => {
    expect(chooseHat(fg("UnrealEditor.exe"), new Date(2026, 11, 24, 3), true)).toBe("hardhat");
    expect(chooseHat(fg("chrome.exe"), new Date(2026, 11, 24, 3), true)).toBe("santa");
  });
});

describe("disfraces de juego", () => {
  const game = (outfit: GameEntry["outfit"]): GameEntry => ({ exe: "x.exe", name: "X", outfit });
  const halloweenNight = new Date(2026, 9, 31, 3);

  it("el juego gana al casco de Unreal y a Halloween", () => {
    expect(chooseLook(fg("UnrealEditor.exe"), game("tactical"), halloweenNight, true)).toEqual({
      hat: "helmet",
      body: "vest",
    });
    expect(chooseLook(null, game("pirate"), halloweenNight, false)).toEqual({ hat: "pirate", body: "eyepatch" });
    expect(chooseLook(null, game("car"), halloweenNight, false)).toEqual({ hat: null, body: "car" });
  });

  it("sin juego, la cadena de gorros de siempre", () => {
    expect(chooseLook(fg("UnrealEditor.exe"), null, halloweenNight, true)).toEqual({ hat: "hardhat", body: null });
    expect(chooseLook(fg("chrome.exe"), null, halloweenNight, true)).toEqual({ hat: "witch", body: null });
    expect(chooseHat(fg("chrome.exe"), halloweenNight, true)).toBe("witch");
  });

  it("un juego con disfraz «none» no disfraza (y no tapa la temporada)", () => {
    expect(gameLook("none")).toEqual({ hat: null, body: null });
    expect(chooseLook(fg("chrome.exe"), game("none"), halloweenNight, false)).toEqual({ hat: "witch", body: null });
  });
});
