import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, MascotEngine } from "../engine";
import { DRIVE_HOVER_MUTE_MS, DriveHoverGuard } from "../driveHover";

describe("DriveHoverGuard", () => {
  it("tras soltar el cursor, el hover queda silenciado un rato", () => {
    const g = new DriveHoverGuard();
    const cur = { x: 100, y: 100 };
    expect(g.muted(0, cur)).toBe(false);
    g.ended(1000, cur);
    expect(g.muted(1000 + DRIVE_HOVER_MUTE_MS - 1, cur)).toBe(true);
    expect(g.muted(1000 + DRIVE_HOVER_MUTE_MS, cur)).toBe(false);
  });

  it("si mueves el ratón tú, el hover vuelve al momento", () => {
    const g = new DriveHoverGuard();
    g.ended(0, { x: 100, y: 100 });
    expect(g.muted(100, { x: 104, y: 101 })).toBe(true);
    expect(g.muted(200, { x: 160, y: 100 })).toBe(false);
    expect(g.muted(300, { x: 100, y: 100 })).toBe(false);
  });

  it("empezar a conducir otra vez anula el silencio pendiente", () => {
    const g = new DriveHoverGuard();
    g.ended(0, { x: 0, y: 0 });
    g.started();
    expect(g.muted(10, { x: 0, y: 0 })).toBe(false);
  });
});

describe("motor: hover provocado por el cursor del MCP", () => {
  const W = 1600;
  const H = 860;
  /** Cursor justo encima de la cabeza de la mascota. */
  const overPet = (e: MascotEngine) => ({ x: e.x, y: e.y - e.height / 2 });

  function runGuarded(e: MascotEngine, g: DriveHoverGuard, fromMs: number, seconds: number, moveCursor: boolean) {
    const dt = 1 / 60;
    let cur = overPet(e);
    let reacted = false;
    for (let t = 0; t < seconds; t += dt) {
      if (moveCursor) cur = overPet(e);
      const hovered = !g.muted(fromMs + t * 1000, cur);
      const before = e.mode;
      e.update({ dt, cursor: cur, hovered, chat: "none" });
      if (e.mode === "wave" && before !== "wave") reacted = true;
    }
    return reacted;
  }

  it("al terminar la conducción con el cursor encima, no saluda; pasado el margen, sí", () => {
    const e = new MascotEngine(W, H, { ...DEFAULT_SETTINGS, wander: false, sleep_after_min: 0 });
    // Ya posada, conducida un momento y soltada con el cursor encima.
    for (let i = 0; i < 180; i++) e.update({ dt: 1 / 60, cursor: null, hovered: false, chat: "none" });
    e.driveStart();
    e.driveEnd();
    for (let i = 0; i < 120; i++) e.update({ dt: 1 / 60, cursor: null, hovered: false, chat: "none" });
    const g = new DriveHoverGuard();
    g.ended(0, overPet(e));
    expect(runGuarded(e, g, 0, (DRIVE_HOVER_MUTE_MS - 200) / 1000, false)).toBe(false);
    expect(runGuarded(e, g, DRIVE_HOVER_MUTE_MS, 0.5, false)).toBe(true);
  });

  it("caso negativo: sin el filtro, el mismo cursor sí provoca la reacción", () => {
    const e = new MascotEngine(W, H, { ...DEFAULT_SETTINGS, wander: false, sleep_after_min: 0 });
    for (let i = 0; i < 300; i++) e.update({ dt: 1 / 60, cursor: null, hovered: false, chat: "none" });
    expect(runGuarded(e, new DriveHoverGuard(), 0, 0.5, false)).toBe(true);
  });
});
