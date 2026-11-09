import { describe, expect, it } from "vitest";
import { AWAY_MS, classifyForeground, diffAmbient, isFocusActivity, type Activity, type AmbientSample } from "../ambient";

const fg = (exe: string, title = "") => ({ exe, title });

describe("qué estás haciendo", () => {
  it.each<[string, string, Activity]>([
    ["Code.exe", "engine.ts - ultron", "ide"],
    ["devenv.exe", "Arcadia", "ide"],
    ["UnrealEditor.exe", "Explored", "ide"],
    ["WindowsTerminal.exe", "pwsh", "terminal"],
    ["chrome.exe", "Docs de React", "navegador"],
    ["msedge.exe", "Cosas - YouTube", "video"],
    ["vlc.exe", "peli.mkv", "video"],
    ["Zoom.exe", "Reunión de Zoom", "llamada"],
    ["ms-teams.exe", "Reunión | Microsoft Teams", "llamada"],
    ["chrome.exe", "Meet - abc-defg-hij", "llamada"],
    ["Discord.exe", "#general - Voz conectada", "llamada"],
    ["control-center.exe", "ULTRON", "ultron"],
    ["notepad.exe", "nota", "otro"],
  ])("%s «%s» → %s", (exe, title, act) => {
    expect(classifyForeground(fg(exe, title))).toBe(act);
  });

  it("Discord sin voz no es una llamada (caso negativo); Teams en el chat tampoco", () => {
    expect(classifyForeground(fg("Discord.exe", "#general - Mi servidor"))).toBe("otro");
    expect(classifyForeground(fg("ms-teams.exe", "Chat | Microsoft Teams"))).toBe("otro");
  });

  it("el micrófono en uso cuenta como llamada; un juego delante manda", () => {
    expect(classifyForeground(fg("notepad.exe"), true)).toBe("llamada");
    expect(classifyForeground({ ...fg("cs2.exe"), game: { exe: "cs2.exe" } }, true)).toBe("juego");
    expect(classifyForeground({ ...fg("x.exe"), quiet: true })).toBe("juego");
    expect(classifyForeground(null)).toBe("otro");
  });

  it("concentrado: programar, terminal y llamadas; navegar no", () => {
    expect(isFocusActivity("ide") && isFocusActivity("terminal") && isFocusActivity("llamada")).toBe(true);
    expect(isFocusActivity("navegador")).toBe(false);
  });
});

const s = (activity: Activity, idleMs: number | null, atMs = 0): AmbientSample => ({ atMs, activity, idleMs });

describe("sucesos entre muestras", () => {
  it("la primera muestra no emite nada", () => {
    expect(diffAmbient(null, s("juego", AWAY_MS * 2))).toEqual([]);
  });

  it("empieza y termina un juego y una llamada", () => {
    expect(diffAmbient(s("ide", 0), s("juego", 0))).toEqual(["juegoEmpieza"]);
    expect(diffAmbient(s("juego", 0), s("ide", 0))).toEqual(["juegoTermina"]);
    expect(diffAmbient(s("otro", 0), s("llamada", 0))).toEqual(["llamadaEmpieza"]);
    expect(diffAmbient(s("llamada", 0), s("juego", 0))).toEqual(["juegoEmpieza", "llamadaTermina"]);
  });

  it("30 s sin tocar nada no es irse (caso negativo); 5 min sí", () => {
    expect(diffAmbient(s("ide", 25_000), s("ide", 30_000))).toEqual([]);
    expect(diffAmbient(s("ide", AWAY_MS - 1000), s("ide", AWAY_MS + 4000))).toEqual(["teVas"]);
  });

  it("volver solo cuenta tras una ausencia de más de 5 min", () => {
    expect(diffAmbient(s("ide", AWAY_MS + 60_000), s("ide", 2000))).toEqual(["vuelves"]);
    expect(diffAmbient(s("ide", 4 * 60_000), s("ide", 2000))).toEqual([]);
  });

  it("sin dato de presencia no hay idas ni vueltas", () => {
    expect(diffAmbient(s("ide", null), s("ide", AWAY_MS * 3))).toEqual([]);
    expect(diffAmbient(s("ide", AWAY_MS * 3), s("ide", null))).toEqual([]);
  });
});
