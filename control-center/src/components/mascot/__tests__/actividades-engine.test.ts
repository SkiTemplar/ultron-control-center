// Actividades dentro del motor: el sorteo las lanza, terminan solas, el
// arrastre las corta, la pesca usa el clic, la noche (01:00-07:00) duerme
// antes y bosteza al despertar, «vuelves» saluda y la música hace bailar.

import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, MascotEngine, type MascotSettings } from "../engine";
import type { MoodState } from "../moodState";
import { Vitality } from "../vitality";
import { FISH } from "../activities/outdoors";
import { rollQuarter } from "../activities/play";

const W = 1600;
const H = 860;
const NOON = new Date(2026, 9, 16, 12, 0, 0);
const NIGHT = new Date(2026, 9, 16, 3, 0, 0);

function engine(patch: Partial<MascotSettings> = {}, when = NOON, rand = () => 0.5, state: MoodState = "feliz") {
  const e = new MascotEngine(W, H, { ...DEFAULT_SETTINGS, wander: false, ...patch }, rand);
  e.now = () => when;
  e.life = new Vitality(rand, () => when.getTime()); // el ánimo también con el reloj del test
  e.life.state = state;
  return e;
}

function run(e: MascotEngine, seconds: number, cursor: { x: number; y: number } | null = null) {
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) e.update({ dt, cursor, hovered: false, chat: "none" });
}

describe("ciclo de una actividad", () => {
  it("el sorteo de decide() la lanza (modo «act») y vuelve a reposo al acabar", () => {
    // rand casi 1: pickWeighted elige la última opción, que es «actividad».
    const e = engine({ wander: true }, NOON, () => 0.999);
    e.t = 1000;
    run(e, 7);
    expect(e.mode).toBe("act");
    expect(e.acts.current).not.toBeNull();
    const id = e.acts.current;
    run(e, 40);
    expect(e.acts.current === id && e.mode === "act").toBe(false);
  });

  it("malabares dura 6 s y termina en reposo", () => {
    const e = engine();
    run(e, 3);
    expect(e.doActivity("malabares")).toBe(true);
    run(e, 3);
    expect(e.mode).toBe("act");
    run(e, 3.5);
    expect(e.mode).not.toBe("act");
    expect(e.acts.current).toBeNull();
  });

  it("no empieza nada en pleno vuelo ni arrastrado (caso negativo)", () => {
    const e = engine();
    e.startDrag(e.x, e.y, 0);
    expect(e.doActivity("leer")).toBe(false);
    expect(e.mode).toBe("drag");
  });

  it("la voltereta gira por cuartos y esconde el gorro mientras rueda", () => {
    const e = engine();
    run(e, 3);
    e.setHat("santa");
    e.doActivity("voltereta");
    run(e, 0.3);
    const f = e.frame("none");
    expect(f.pose.rot).not.toBe(0);
    expect(rollQuarter(0)).toBe(0); // agachado todavía no gira
    expect(f.hat).toBeNull();
    run(e, 1.2);
    expect(e.frame("none").hat).toBe("santa");
  });
});

describe("pesca desde el borde de una ventana", () => {
  function fishing() {
    const e = engine({}, NOON, () => 0.5, "contento");
    e.setWindows([{ id: 7, left: 300, top: 400, right: 700, bottom: 700 }]);
    e.ground = { kind: "win", id: 7, winLeft: 300 };
    e.x = 640;
    e.y = 400;
    e.facing = 1;
    run(e, 1.5); // pasado el saludo de arranque
    return e;
  }

  it("con caída libre bajo el borde la ofrece; en el suelo no", () => {
    const e = fishing();
    expect(e.acts.candidates(e).map(([id]) => id)).toContain("pescar");
    const floor = engine({}, NOON, () => 0.5, "contento");
    expect(floor.acts.candidates(floor).map(([id]) => id)).not.toContain("pescar");
  });

  it("un clic cuando pica recoge el sedal y apunta la captura", () => {
    const e = fishing();
    expect(e.doActivity("pescar")).toBe(true);
    run(e, 3);
    const r = e.acts.run!;
    expect(r.data.phase).toBe(FISH.wait);
    expect(e.acts.line(e)).not.toBeNull();
    r.data.biteAt = 0;
    run(e, 0.1);
    expect(r.data.phase).toBe(FISH.bite);
    e.poke();
    expect(e.mode).toBe("act");
    run(e, 0.1);
    expect(r.data.phase).toBe(FISH.show);
    expect(e.acts.catchSummary()).toMatch(/^Capturas: 1 /);
  });

  it("un clic mientras espera no lo consume: salta como siempre y deja de pescar", () => {
    const e = fishing();
    e.doActivity("pescar");
    run(e, 3);
    expect(e.acts.run?.data.phase).toBe(FISH.wait);
    e.poke();
    expect(e.mode).toBe("air");
    expect(e.acts.current).toBeNull();
  });
});

describe("la noche (01:00-07:00)", () => {
  it("de noche se duerme en la mitad del tiempo configurado", () => {
    const e = engine({ sleep_after_min: 2 }, NIGHT);
    run(e, 62);
    expect(e.mode).toBe("sleep");
  });

  it("de día, al mismo tiempo, sigue despierto (caso negativo)", () => {
    const e = engine({ sleep_after_min: 2 }, NOON);
    run(e, 62);
    expect(e.mode).not.toBe("sleep");
  });

  it("de noche, al despertarlo con un clic, bosteza; de día saluda", () => {
    const night = engine({ sleep_after_min: 1 }, NIGHT);
    run(night, 40);
    expect(night.mode).toBe("sleep");
    night.poke();
    expect(night.mode).toBe("emote");
    expect(night.emote).toBe("yawn");
    const day = engine({ sleep_after_min: 1 }, NOON);
    run(day, 70);
    expect(day.mode).toBe("sleep");
    day.poke();
    expect(day.mode).toBe("wave");
  });
});

describe("bienvenida y música", () => {
  it("«vuelves» lo despierta y saluda; de noche bosteza antes", () => {
    const e = engine({ sleep_after_min: 1 }, NIGHT);
    run(e, 40);
    expect(e.mode).toBe("sleep");
    e.feel("vuelves");
    expect(e.mode).toBe("act");
    expect(e.acts.current).toBe("bienvenida");
    expect(e.acts.run?.data.yawn).toBeGreaterThan(0);
  });

  it("de día la bienvenida no bosteza", () => {
    const e = engine();
    run(e, 3);
    e.feel("vuelves");
    expect(e.acts.current).toBe("bienvenida");
    expect(e.acts.run?.data.yawn).toBe(0);
  });

  it("con música baila; sin música, no (caso negativo)", () => {
    const quiet = engine({}, NOON, () => 0.00001);
    quiet.t = 1000;
    run(quiet, 2);
    expect(quiet.acts.current).toBeNull();
    const e = engine({}, NOON, () => 0.00001);
    e.t = 1000;
    e.acts.music = true;
    run(e, 2);
    expect(e.acts.current).toBe("bailar");
  });

  it("si la música para, deja de bailar", () => {
    const e = engine({}, NOON, () => 0.00001);
    e.t = 1000;
    e.acts.music = true;
    run(e, 2);
    expect(e.acts.current).toBe("bailar");
    e.acts.music = false;
    run(e, 0.1);
    expect(e.acts.current).toBeNull();
  });

  it("con «Bailar cuando suena música» apagado no baila", () => {
    const e = engine({ music_dance: false }, NOON, () => 0.00001);
    e.t = 1000;
    e.acts.music = true;
    run(e, 2);
    expect(e.acts.current).toBeNull();
  });
});
