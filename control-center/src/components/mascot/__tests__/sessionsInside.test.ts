// Dentro de Sessions: el borde del cuadro de texto como plataforma y los
// laterales de la ventana como paredes (sessionsInside.ts, engineClimb.ts).

import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, MascotEngine, type MascotSettings } from "../engine";
import { visiblePlatforms, type WinRect } from "../world";
import {
  composerId,
  jumpablePlatforms,
  visibleWalls,
  wallToClimbDown,
  wallToClimbUp,
  withComposers,
  type SessionsInside,
} from "../sessionsInside";
import { CLIMB_COOLDOWN_S } from "../engineClimb";

const W = 1600;
const H = 860;

const SESSIONS: WinRect = { id: 7, left: 600, top: 300, right: 1200, bottom: H };
const INSIDE: SessionsInside[] = [{ id: 7, composer: { left: 650, top: 760, right: 1150, bottom: 840 } }];

const DIMS = { halfW: 24, height: 40, areaWidth: W, maxWalk: 480 };

function engine(patch: Partial<MascotSettings> = {}, rand = () => 0.5) {
  const e = new MascotEngine(W, H, { ...DEFAULT_SETTINGS, wander: false, ...patch }, rand);
  e.now = () => new Date(2026, 9, 16, 12, 0, 0);
  return e;
}

function run(e: MascotEngine, seconds: number, each?: (e: MascotEngine) => void) {
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) {
    e.update({ dt, cursor: null, hovered: false, chat: "none" });
    each?.(e);
  }
}

/** En el suelo, quieto, en x. */
function standAt(e: MascotEngine, x: number) {
  run(e, 2);
  e.x = x;
  expect(e.isGrounded()).toBe(true);
}

describe("plataforma del cuadro de texto", () => {
  it("sale del informe, encima de Sessions en el orden Z y en sus coordenadas", () => {
    const plats = visiblePlatforms(withComposers([SESSIONS], INSIDE), W);
    const comp = plats.find((p) => p.id === composerId(7));
    expect(comp).toMatchObject({ left: 650, right: 1150, top: 760 });
    expect(plats.find((p) => p.id === 7)).toMatchObject({ left: 600, right: 1200, top: 300 });
  });

  it("sin Sessions en la lista de ventanas no hay plataforma (negativo)", () => {
    const other: WinRect = { id: 3, left: 100, top: 200, right: 500, bottom: 600 };
    const plats = visiblePlatforms(withComposers([other], INSIDE), W);
    expect(plats.some((p) => p.id === composerId(7))).toBe(false);
    expect(visiblePlatforms(withComposers([], INSIDE), W)).toEqual([]);
  });

  it("una ventana por encima de Sessions le quita el tramo que tapa", () => {
    const above: WinRect = { id: 9, left: 500, top: 700, right: 900, bottom: H };
    const plats = visiblePlatforms(withComposers([above, SESSIONS], INSIDE), W);
    const comp = plats.filter((p) => p.id === composerId(7)).map((p) => [p.left, p.right]);
    expect(comp).toEqual([[900, 1150]]);
    const full: WinRect = { id: 9, left: 0, top: 0, right: W, bottom: H };
    const hidden = visiblePlatforms(withComposers([full, SESSIONS], INSIDE), W);
    expect(hidden.some((p) => p.id === composerId(7))).toBe(false);
  });

  it("el motor se posa en él al caer dentro de Sessions", () => {
    const e = engine();
    e.setWindows([SESSIONS], INSIDE);
    e.x = 900;
    e.y = 500;
    e.startDrag(900, 500, 0);
    e.endDrag(false);
    run(e, 2);
    expect(e.y).toBe(760);
    expect(e.standingOn()?.id).toBe(composerId(7));
  });

  it("con «subirse a ventanas» apagado no hay plataforma ni paredes (negativo)", () => {
    const e = engine({ climb_windows: false });
    e.setWindows([SESSIONS], INSIDE);
    expect(e.plats).toEqual([]);
    expect(e.walls).toEqual([]);
  });
});

describe("salto al cuadro de texto con ventanas sólidas", () => {
  const plats = visiblePlatforms(withComposers([SESSIONS], INSIDE), W);
  const hasComposer = (ps: { id: number }[]) => ps.some((p) => p.id === composerId(7));

  it("desde fuera de Sessions no es un destino (chocaría con su lateral)", () => {
    expect(hasComposer(jumpablePlatforms(plats, [SESSIONS], 400, H, true))).toBe(false);
    expect(jumpablePlatforms(plats, [SESSIONS], 400, H, true).some((p) => p.id === 7)).toBe(true);
  });

  it("desde dentro de Sessions o sin colisiones sí lo es (negativo)", () => {
    expect(hasComposer(jumpablePlatforms(plats, [SESSIONS], 900, H, true))).toBe(true);
    expect(hasComposer(jumpablePlatforms(plats, [SESSIONS], 400, H, false))).toBe(true);
  });
});

describe("paredes de Sessions", () => {
  it("detecta los dos laterales, de arriba abajo", () => {
    expect(visibleWalls([SESSIONS], INSIDE, W)).toEqual([
      { id: 7, side: "left", x: 600, top: 300, bottom: H },
      { id: 7, side: "right", x: 1200, top: 300, bottom: H },
    ]);
  });

  it("otras ventanas no tienen paredes y una tapada arriba tampoco (negativo)", () => {
    const other: WinRect = { id: 3, left: 100, top: 200, right: 500, bottom: 600 };
    expect(visibleWalls([other], INSIDE, W)).toEqual([]);
    const corner: WinRect = { id: 9, left: 550, top: 250, right: 700, bottom: 400 };
    const walls = visibleWalls([corner, SESSIONS], INSIDE, W);
    expect(walls.map((w) => w.side)).toEqual(["right"]);
    const maximized: WinRect = { ...SESSIONS, top: 0 };
    expect(visibleWalls([maximized], INSIDE, W)).toEqual([]);
  });

  it("una ventana a media altura corta el tramo visible", () => {
    const mid: WinRect = { id: 9, left: 400, top: 500, right: 700, bottom: 600 };
    const left = visibleWalls([mid, SESSIONS], INSIDE, W).find((w) => w.side === "left");
    expect(left?.bottom).toBe(500);
  });

  it("elige la pared alcanzable desde el suelo y no una que no le llega a las manos", () => {
    const walls = visibleWalls([SESSIONS], INSIDE, W);
    const up = wallToClimbUp(walls, { x: 400, y: H, left: 24, right: W - 24 }, DIMS);
    expect(up?.side).toBe("left");
    const short = [{ id: 7, side: "left" as const, x: 600, top: 300, bottom: 700 }];
    expect(wallToClimbUp(short, { x: 400, y: H, left: 24, right: W - 24 }, DIMS)).toBeNull();
    const far = wallToClimbUp(walls, { x: 30, y: H, left: 24, right: W - 24 }, { ...DIMS, maxWalk: 100 });
    expect(far).toBeNull();
  });

  it("para bajar, solo desde el borde de esa misma ventana", () => {
    const walls = visibleWalls([SESSIONS], INSIDE, W);
    const top = { x: 700, y: 300, left: 602, right: 1198 };
    expect(wallToClimbDown(walls, 7, top, DIMS)?.side).toBe("left");
    expect(wallToClimbDown(walls, 3, top, DIMS)).toBeNull();
  });
});

describe("trepar por el lateral de Sessions", () => {
  it("anda hasta la pared, sube pegado a ella y pasa al borde superior", () => {
    const e = engine();
    e.setWindows([SESSIONS], INSIDE);
    standAt(e, 400);
    const wall = e.climbableUp();
    expect(wall?.side).toBe("left");
    expect(e.planClimb(wall!, -1)).toBe(true);
    const xs = new Set<number>();
    let sawClimb = false;
    run(e, 12, (en) => {
      if (en.mode !== "climb") return;
      sawClimb = true;
      xs.add(en.x);
      expect(en.facing).toBe(1);
    });
    expect(sawClimb).toBe(true);
    expect([...xs]).toEqual([600 - e.halfW]);
    expect(e.standingOn()?.id).toBe(7);
    expect(e.y).toBe(300);
    expect(e.climbing()).toBeNull();
  });

  it("si Sessions desaparece a media trepada, se suelta y cae al suelo", () => {
    const e = engine();
    e.setWindows([SESSIONS], INSIDE);
    standAt(e, 560);
    e.startClimb(e.climbableUp()!, -1);
    run(e, 1);
    expect(e.mode).toBe("climb");
    expect(e.y).toBeLessThan(H - 50);
    e.setWindows([], []);
    run(e, 0.05);
    expect(e.mode).toBe("air");
    run(e, 3);
    expect(e.y).toBe(H);
    expect(e.climbing()).toBeNull();
  });

  it("si arrastran Sessions hasta el borde de la pantalla a media trepada, se suelta", () => {
    const e = engine();
    e.setWindows([SESSIONS], INSIDE);
    standAt(e, 560);
    e.startClimb(e.climbableUp()!, -1);
    run(e, 1);
    expect(e.mode).toBe("climb");
    e.setWindows([{ ...SESSIONS, left: 10, right: 610 }], [{ id: 7, composer: { left: 60, top: 760, right: 560, bottom: 840 } }]);
    run(e, 0.05);
    expect(e.mode).toBe("air");
    expect(e.x).toBeGreaterThanOrEqual(e.halfW);
  });

  it("baja por la pared desde el borde superior hasta el suelo", () => {
    const e = engine();
    e.setWindows([SESSIONS], INSIDE);
    e.x = 700;
    e.y = 200;
    e.startDrag(700, 200, 0);
    e.endDrag(false);
    run(e, 2);
    expect(e.standingOn()?.id).toBe(7);
    const wall = e.climbableDown();
    expect(wall?.side).toBe("left");
    e.planClimb(wall!, 1);
    let sawClimb = false;
    run(e, 10, (en) => void (sawClimb ||= en.mode === "climb"));
    expect(sawClimb).toBe(true);
    expect(e.y).toBe(H);
    expect(e.isGrounded()).toBe(true);
  });

  it("no vuelve a trepar hasta pasado el descanso (sin bucle)", () => {
    const e = engine();
    e.setWindows([SESSIONS], INSIDE);
    standAt(e, 560);
    e.startClimb(e.climbableUp()!, -1);
    run(e, 8);
    expect(e.climbableDown()).toBeNull();
    run(e, CLIMB_COOLDOWN_S);
    expect(e.climbableDown()?.id).toBe(7);
  });

  it("la decisión de subir puede acabar en trepar (misma entrada que saltar)", () => {
    const e = engine({}, () => 0.1);
    e.setWindows([SESSIONS], INSIDE);
    standAt(e, 400);
    const decide = e as unknown as { tryClimbOrJumpUp(): boolean };
    expect(decide.tryClimbOrJumpUp()).toBe(true);
    expect(e.climbing()).toEqual({ dir: -1, planned: true });
  });

  it("sin Sessions la decisión de subir no trepa (negativo)", () => {
    const e = engine({}, () => 0.1);
    e.setWindows([], []);
    standAt(e, 400);
    const decide = e as unknown as { tryClimbOrJumpUp(): boolean };
    expect(decide.tryClimbOrJumpUp()).toBe(false);
    expect(e.climbing()).toBeNull();
  });
});
