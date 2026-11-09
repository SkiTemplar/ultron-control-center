import { describe, expect, it } from "vitest";
import { breathFor, expressionFor } from "../expression";
import { IdleLife, MICRO_DURATION, type MicroKind } from "../idleLife";
import { MOOD_STATES, type MoodState } from "../moodState";
import { STATE_TABLE } from "../moodTable";
import { DEFAULT_SETTINGS, MascotEngine, type Mode } from "../engine";

/** Generador repetible (LCG) para que dos corridas den lo mismo. */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Lo que se ve de un estado en 10 s: ojos, cejas, brazos, rubor, respiración, mirada y temblor. */
function signature(s: MoodState): string {
  const eyes = new Set<string>();
  const brows = new Set<string>();
  const arms = new Set<string>();
  let blush = 0;
  let breath = 0;
  let lookY = 0;
  let dx = 0;
  let sy = 0;
  let n = 0;
  for (let t = 0; t < 10; t += 0.05, n++) {
    const e = expressionFor(s, t);
    eyes.add(e.eyes ?? "-");
    brows.add(e.pose.brows ?? "none");
    arms.add(`${e.pose.armL ?? "out"}/${e.pose.armR ?? "out"}`);
    blush += e.pose.blush ? 1 : 0;
    breath += breathFor(s, t);
    lookY += e.pose.lookY ?? 0;
    dx = Math.max(dx, Math.abs(e.pose.dx ?? 0));
    sy += e.pose.sy ?? 1;
  }
  const r = (v: number) => (v / n).toFixed(2);
  return JSON.stringify([[...eyes].sort(), [...brows].sort(), [...arms].sort(), r(blush), r(breath), r(lookY), dx, r(sy)]);
}

describe("cada estado se distingue solo por el cuerpo", () => {
  it("las firmas de los 16 estados son distintas dos a dos", () => {
    const sigs = new Map<string, MoodState>();
    for (const s of MOOD_STATES) {
      const sig = signature(s);
      expect(sigs.get(sig), `${s} se confunde con ${sigs.get(sig)}`).toBeUndefined();
      sigs.set(sig, s);
    }
  });

  it("el fotograma no lleva ningún campo de estado ni icono persistente", () => {
    const e = new MascotEngine(1600, 860, { ...DEFAULT_SETTINGS, wander: false }, () => 0.5);
    for (const s of MOOD_STATES) {
      e.life.state = s;
      const f = e.frame("none");
      expect(Object.keys(f).sort()).toEqual(
        ["carry", "color", "facing", "hat", "hatDrop", "heli", "icon", "pin", "pose", "stars", "x", "y", "zzz"].sort(),
      );
      expect(f.icon).toBeNull();
    }
  });
});

describe("microanimaciones", () => {
  const traits = { micro: [["glance", 1], ["footTap", 1], ["shiver", 1]] as [MicroKind, number][], microGap: [0.5, 1] as const };

  function runLife(life: IdleLife, mode: Mode, seconds: number, rand: () => number) {
    const seen: (MicroKind | null)[] = [];
    for (let t = 0; t < seconds; t += 0.05) {
      life.step(t, traits, mode, "none", rand);
      seen.push(life.current());
    }
    return seen;
  }

  it("en reposo aparecen micros", () => {
    const seen = runLife(new IdleLife(), "idle", 20, seeded(1));
    expect(seen.some((k) => k !== null)).toBe(true);
  });

  it.each<Mode>(["air", "drag", "hang", "splat", "fly", "drive"])("nunca en %s", (mode) => {
    const life = new IdleLife();
    expect(runLife(life, mode, 20, seeded(2)).every((k) => k === null)).toBe(true);
    expect(life.overlay(10, mode)).toBeNull();
  });

  it("un micro en curso no se aplica si cambia a un modo sin micros", () => {
    const life = new IdleLife();
    runLife(life, "idle", 2.5, () => 0.01);
    expect(life.current()).not.toBeNull();
    expect(life.overlay(2.5, "air")).toBeNull();
  });

  it("andando solo se mueve la mirada", () => {
    const life = new IdleLife();
    const seen = runLife(life, "walk", 30, seeded(3));
    expect(seen.filter((k) => k !== null).every((k) => k === "glance")).toBe(true);
  });

  it("sentado, las patas siguen recogidas", () => {
    const life = new IdleLife();
    const only = { micro: [["footTap", 1]] as [MicroKind, number][], microGap: [0.1, 0.2] as const };
    for (let t = 0; t < 3; t += 0.05) life.step(t, only, "sit", "none", () => 0.3);
    expect(life.current()).toBe("footTap");
    expect(life.overlay(2.9, "sit")?.pose.legs).toBeUndefined();
    expect(life.overlay(2.9, "idle")?.pose.legs).toBeDefined();
  });

  it("con conversación abierta no hay micros", () => {
    const life = new IdleLife();
    for (let t = 0; t < 20; t += 0.05) life.step(t, traits, "idle", "talk", seeded(4));
    expect(life.current()).toBeNull();
  });

  it("mismo azar, misma secuencia", () => {
    const a = runLife(new IdleLife(), "idle", 30, seeded(7));
    const b = runLife(new IdleLife(), "idle", 30, seeded(7));
    expect(a).toEqual(b);
    // Caso negativo: con otra semilla la secuencia cambia.
    expect(runLife(new IdleLife(), "idle", 30, seeded(8))).not.toEqual(a);
  });

  it("todo micro de la tabla tiene duración", () => {
    for (const s of MOOD_STATES) for (const [k] of STATE_TABLE[s].micro) expect(MICRO_DURATION[k]).toBeGreaterThan(0);
  });
});
