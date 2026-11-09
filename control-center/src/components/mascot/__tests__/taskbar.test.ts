import { describe, expect, it } from "vitest";
import { findButton, floorTarget, fold, type TaskbarBar, type TaskbarButton, type TaskbarSnapshot } from "../taskbar";

// Disposición de la sonda del 2026-10-16 (px físicos): principal de
// 2560×1600 y secundaria de 1920×1080 a la derecha, barra abajo en las dos.
const main: TaskbarBar = {
  hwnd: 1,
  primary: true,
  rect: [0, 1528, 2560, 1600],
  monitor: [0, 0, 2560, 1600],
  edge: "bottom",
  auto_hidden: false,
};
const second: TaskbarBar = {
  hwnd: 2,
  primary: false,
  rect: [2560, 1032, 4480, 1080],
  monitor: [2560, 0, 4480, 1080],
  edge: "bottom",
  auto_hidden: false,
};

function btn(bar: number, app_id: string, label: string, x: number): TaskbarButton {
  const top = bar === 1 ? 1528 : 1032;
  return { app_id, label, windows: 1, pinned: true, rect: [x, top, x + 44, top + 48], bar };
}

const snap: TaskbarSnapshot = {
  version: 1,
  taken_ms: 70,
  bars: [main, second],
  buttons: [
    btn(1, "windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel", "Configuración", 323),
    btn(1, "ULTRON.Sessions", "ULTRON Control Center", 1277),
    btn(2, "windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel", "Configuración", 2883),
    btn(2, "ULTRON.Sessions", "ULTRON Control Center", 3411),
  ],
};

describe("findButton", () => {
  it("sin tildes ni mayúsculas: «configuracion» encuentra «Configuración»", () => {
    expect(fold("Configuración")).toBe("configuracion");
    expect(findButton(snap, { label: "configuracion" }, null)?.button.label).toBe("Configuración");
  });

  it("prefiere la barra del monitor donde está Pupus", () => {
    expect(findButton(snap, { appId: "ultron.sessions" }, { x: 3000, y: 10 })?.bar.hwnd).toBe(2);
    expect(findButton(snap, { appId: "ULTRON.Sessions" }, { x: 10, y: 10 })?.bar.hwnd).toBe(1);
    // Fuera de todos los monitores: la principal.
    expect(findButton(snap, { appId: "ULTRON.Sessions" }, { x: -900, y: 10 })?.bar.hwnd).toBe(1);
  });

  it("con AppId, la etiqueta no lleva a otro botón que se llama igual", () => {
    // Medido el 2026-10-27: Sessions y el Control Center son el mismo exe y
    // sus dos botones se llaman «ULTRON Control Center».
    const cc = "C:\\ultron\\control-center.exe";
    const twin: TaskbarSnapshot = {
      ...snap,
      buttons: [btn(1, cc, "ULTRON Control Center", 100), btn(1, "ULTRON.Sessions", "ULTRON Control Center", 150)],
    };
    const hit = findButton(twin, { appId: "ULTRON.Sessions", label: "ULTRON Control Center" }, null);
    expect(hit?.button.app_id).toBe("ULTRON.Sessions");
    // Sin AppId que coincida (Windows 10, sin Appid), la etiqueta sigue valiendo.
    expect(findButton(twin, { appId: "otra", label: "ULTRON Control Center" }, null)?.button.app_id).toBe(cc);
  });

  it("una app sin botón no se inventa", () => {
    expect(findButton(snap, { appId: "Code" }, null)).toBeNull();
    expect(findButton(null, { appId: "ULTRON.Sessions" }, null)).toBeNull();
  });
});

describe("floorTarget", () => {
  it("barra abajo: punto del suelo justo encima del botón y flecha en su centro", () => {
    const t = floorTarget(snap.buttons[1], main);
    expect(t).toEqual({ ok: true, x: 1299, y: 1527, arrowX: 1299 });
  });

  it("barra autoocultable: no hay botón visible y se dice por qué", () => {
    expect(floorTarget(snap.buttons[1], { ...main, auto_hidden: true })).toEqual({ ok: false, reason: "barra-oculta" });
  });

  it("barra arriba o a un lado: suelo más cercano, sin flecha", () => {
    const top = { ...main, rect: [0, 0, 2560, 72] as [number, number, number, number], edge: "top" as const };
    expect(floorTarget({ ...snap.buttons[1], rect: [1277, 0, 1343, 72] }, top)).toEqual({
      ok: true,
      x: 1310,
      y: 1599,
      arrowX: null,
    });
    const left = { ...main, rect: [0, 0, 72, 1600] as [number, number, number, number], edge: "left" as const };
    const t = floorTarget(snap.buttons[1], left);
    expect(t.ok && t.x).toBe(73);
  });
});
