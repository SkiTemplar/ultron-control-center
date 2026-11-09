// El balanceo de las piernas (`swing`) es un desplazamiento del mundo: al
// volar, arrastrar o conducir hacia la izquierda, las piernas se quedan
// atrás, a la derecha. drawPet refleja el sprite cuando Pupus mira a la
// izquierda, así que la pose tiene que pasar ese balanceo al espacio del
// sprite. Se comprueba pintando de verdad: ir hacia la izquierda tiene que
// ser el espejo exacto, píxel a píxel, de ir hacia la derecha.

import { describe, expect, it } from "vitest";
import { modePose, type PoseCtx } from "../framePose";
import { BASE_POSE, drawPet, type Pose } from "../sprite";
import type { Mode } from "../engineTypes";

type Rect = [number, number, number, number];

const FX = 200;
const FY = 300;
const S = 3;

function recorder(): { ctx: CanvasRenderingContext2D; rects: Rect[] } {
  const rects: Rect[] = [];
  const ctx = {
    fillStyle: "",
    fillRect: (x: number, y: number, w: number, h: number) => rects.push([x, y, w, h]),
  } as unknown as CanvasRenderingContext2D;
  return { ctx, rects };
}

function ctxFor(mode: Mode, swing: number, facing: 1 | -1): PoseCtx {
  return {
    t: 1.25,
    mode,
    modeT: 0.5,
    vy: 0,
    swing,
    facing,
    splatSide: "floor",
    hangAnchor: null,
    hangStruggle: false,
    dragSpeed: 0,
    happyUntil: 0,
    state: "contento",
    walkPace: 1,
    emote: null,
    driveAct: null,
    blink: null,
    actPose: () => null,
  };
}

/** Píxeles pintados (ordenados) con la pose del modo en esa dirección. */
function paint(mode: Mode, swing: number, facing: 1 | -1): string[] {
  const p: Pose = { ...BASE_POSE };
  modePose(p, "open", ctxFor(mode, swing, facing));
  const { ctx, rects } = recorder();
  drawPet(ctx, p, FX, FY, S, facing);
  return rects.map((r) => r.join(",")).sort();
}

/** Espejo horizontal de los rectángulos respecto a la vertical de los pies. */
function mirror(rects: string[]): string[] {
  return rects
    .map((s) => {
      const [x, y, w, h] = s.split(",").map(Number);
      return [2 * FX - x - w, y, w, h].join(",");
    })
    .sort();
}

describe("balanceo de las piernas según la dirección", () => {
  // Velocidad hacia la derecha => swing negativo (las piernas quedan atrás).
  const cases: [Mode, number][] = [
    ["fly", -2],
    ["drag", -2],
    ["drive", -2],
    ["hang", -2],
  ];

  it.each(cases)("%s hacia la izquierda es el espejo de hacia la derecha", (mode, swing) => {
    const right = paint(mode, swing, 1);
    const left = paint(mode, -swing, -1);
    expect(left).toEqual(mirror(right));
  });

  it("al volar hacia la izquierda las piernas quedan a la derecha del cuerpo", () => {
    const p: Pose = { ...BASE_POSE };
    modePose(p, "open", ctxFor("fly", 2, -1));
    // Con facing = -1, la x del sprite se invierte: piernas a la derecha del
    // mundo = legSwing negativo en el espacio del sprite.
    expect(p.legSwing).toBeLessThan(0);
  });
});
