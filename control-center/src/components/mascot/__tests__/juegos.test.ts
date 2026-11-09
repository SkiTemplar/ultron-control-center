import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, MascotEngine, type MascotSettings } from "../engine";

const W = 1600;
const H = 860;

function settled(patch: Partial<MascotSettings> = {}, rand = () => 0.5) {
  const e = new MascotEngine(W, H, { ...DEFAULT_SETTINGS, wander: false, ...patch }, rand);
  step(e, 2, null);
  return e;
}

function step(
  e: MascotEngine,
  seconds: number,
  cursor: { x: number; y: number } | ((t: number) => { x: number; y: number }) | null,
  petHover = false,
) {
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) {
    const c = typeof cursor === "function" ? cursor(t) : cursor;
    e.update({ dt, cursor: c, hovered: petHover, petHover, chat: "none" });
  }
}

describe("cosquillas", () => {
  it("frotarle muy rápido le da la risa (no las caricias lentas)", () => {
    const e = settled();
    const cy = e.y - e.height / 2;
    // Zigzag rápido de ±30 px a 12 Hz encima de él.
    step(e, 1.2, (t) => ({ x: e.x + (Math.floor(t * 24) % 2 ? 30 : -30), y: cy }), true);
    expect(e.emote).toBe("wiggle");
  });

  it("una caricia lenta no son cosquillas", () => {
    const e = settled();
    const cy = e.y - e.height / 2;
    step(e, 2, (t) => ({ x: e.x + Math.sin(t * 2) * 20, y: cy }), true);
    expect(e.emote).not.toBe("wiggle");
  });
});

describe("zarandearlo", () => {
  it("agitarlo de lado a lado y soltarlo lo deja mareado al caer", () => {
    const e = settled();
    e.startDrag(e.x, e.y - 300, 0);
    let t = 0;
    for (let i = 0; i < 12; i++) {
      t += 0.05;
      e.dragTo(800 + (i % 2 ? 80 : -80), 400, t);
    }
    e.endDrag(false);
    step(e, 3, null);
    expect(["dizzy", "idle"]).toContain(e.mode);
    // Pasó por el mareo (estrellitas) al aterrizar.
    const e2 = settled();
    e2.startDrag(e2.x, e2.y - 300, 0);
    t = 0;
    for (let i = 0; i < 12; i++) {
      t += 0.05;
      e2.dragTo(800 + (i % 2 ? 80 : -80), 400, t);
    }
    e2.endDrag(false);
    let dizzy = false;
    for (let i = 0; i < 180 && !dizzy; i++) {
      step(e2, 1 / 60, null);
      dizzy = e2.mode === "dizzy";
    }
    expect(dizzy).toBe(true);
  });

  it("arrastrarlo tranquilo no lo marea", () => {
    const e = settled();
    e.startDrag(e.x, e.y - 300, 0);
    for (let i = 1; i <= 10; i++) e.dragTo(800 + i * 5, 400, i * 0.05);
    e.endDrag(false);
    let dizzy = false;
    for (let i = 0; i < 180 && !dizzy; i++) {
      step(e, 1 / 60, null);
      dizzy = e.mode === "dizzy";
    }
    expect(dizzy).toBe(false);
  });
});

describe("travesura con el cursor", () => {
  it("con el cursor quieto cerca, tras el enfriamiento, pide tirar de él una sola vez", () => {
    const e = settled({}, () => 0);
    const near = { x: e.x + 100, y: e.y - 40 };
    step(e, 5, near);
    expect(e.takePrank()).toBeNull(); // aún dentro del enfriamiento inicial
    e.t = 700;
    step(e, 5, near);
    const p = e.takePrank();
    expect(p).not.toBeNull();
    step(e, 5, near);
    expect(e.takePrank()).toBeNull(); // enfriamiento otra vez
  });

  it("desactivada en ajustes, nunca", () => {
    const e = settled({ cursor_pranks: false }, () => 0);
    e.t = 700;
    step(e, 6, { x: e.x + 100, y: e.y - 40 });
    expect(e.takePrank()).toBeNull();
  });
});

describe("gorros", () => {
  it("lleva el gorro salvo volando (la hélice va en la cabeza) o si están desactivados", () => {
    const e = settled();
    e.setHat("santa");
    expect(e.frame("none").hat).toBe("santa");
    e.goTo(800, 200);
    step(e, 0.2, null);
    expect(e.frame("none").hat).toBeNull();
    const off = settled({ hats: false });
    off.setHat("santa");
    expect(off.frame("none").hat).toBeNull();
  });
});
