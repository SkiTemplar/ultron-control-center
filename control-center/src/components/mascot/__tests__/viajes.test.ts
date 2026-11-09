import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, MascotEngine, type MascotSettings } from "../engine";
import { Navigator } from "../navigator";
import type { Env, ScreenInfo } from "../screens";
import type { WinRect } from "../world";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const W = 1600;
const H = 860;

function engine(patch: Partial<MascotSettings> = {}) {
  return new MascotEngine(W, H, { ...DEFAULT_SETTINGS, wander: false, ...patch }, () => 0.5);
}

function run(e: MascotEngine, seconds: number) {
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) e.update({ dt, cursor: null, hovered: false, chat: "none" });
}

/**
 * Vacía las microtareas pendientes (las promesas del mock de `invoke`). Sin
 * `setTimeout`: en Windows cada espera cuesta ~15 ms de temporizador y, con
 * cientos de fotogramas, el test dependía del reloj real y caducaba con la
 * suite completa.
 */
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Deja que termine la animación de entrada (saludo) y quede en el suelo. */
function settled(patch: Partial<MascotSettings> = {}) {
  const e = engine(patch);
  run(e, 2);
  return e;
}

describe("Ctrl+Alt+clic: viajes", () => {
  it("clic en el suelo: va corriendo y llega", () => {
    const e = settled();
    e.goTo(700, H - 10);
    run(e, 8);
    expect(e.takeArrival()).toBe(true);
    expect(Math.abs(e.x - 700)).toBeLessThan(2);
    expect(e.y).toBe(H);
    expect(e.isTraveling()).toBe(false);
  });

  it("clic en mitad de la nada: vuela con la hélice y se queda colgado allí", () => {
    const e = settled();
    e.goTo(800, 200);
    run(e, 0.2);
    expect(e.mode).toBe("fly");
    expect(e.frame("none").heli).not.toBeNull();
    run(e, 6);
    expect(e.takeArrival()).toBe(true);
    expect(e.mode).toBe("hang");
    const f = e.frame("none");
    expect(f.pin).not.toBeNull();
    expect(Math.abs(f.pin!.x - 800)).toBeLessThan(2);
    expect(Math.abs(f.pin!.y - 200)).toBeLessThan(2);
  });

  it("clic en la barra de título de una ventana: sube saltando de ventana en ventana", () => {
    const e = settled();
    e.x = 200;
    const wins: WinRect[] = [
      { id: 1, left: 350, top: 640, right: 750, bottom: 860 },
      { id: 2, left: 800, top: 420, right: 1200, bottom: 860 },
    ];
    e.setWindows(wins);
    e.goTo(1000, 430);
    let flew = false;
    for (let i = 0; i < 12 * 60 && e.isTraveling(); i++) {
      run(e, 1 / 60);
      if (e.mode === "fly") flew = true;
    }
    expect(flew).toBe(false);
    expect(e.takeArrival()).toBe(true);
    expect(e.standingOn()?.id).toBe(2);
  });

  it("si la ventana está demasiado alta para saltar, vuela y se posa en ella", () => {
    const e = settled();
    e.setWindows([{ id: 7, left: 900, top: 120, right: 1300, bottom: 860 }]);
    e.goTo(1100, 130);
    run(e, 0.3);
    expect(e.mode).toBe("fly");
    run(e, 8);
    expect(e.takeArrival()).toBe(true);
    expect(e.standingOn()?.id).toBe(7);
  });

  it("muy lejos no corre: vuela y se posa en el suelo", () => {
    const e = settled();
    e.x = 1500;
    e.goTo(100, H - 5);
    run(e, 0.2);
    expect(e.mode).toBe("fly");
    run(e, 6);
    expect(e.takeArrival()).toBe(true);
    expect(e.y).toBe(H);
  });

  it("cogerlo cancela el viaje", () => {
    const e = settled();
    e.goTo(800, 200);
    run(e, 0.2);
    e.startDrag(e.x, e.y, 0);
    expect(e.isTraveling()).toBe(false);
  });
});

describe("bordes que dan a otro monitor", () => {
  it("sin monitor al lado el borde es una pared", () => {
    const e = settled();
    e.flyTo(W + 400, 400, null);
    run(e, 3);
    expect(e.exitRequest).toBeNull();
    expect(e.x).toBeLessThanOrEqual(W);
  });

  it("con monitor a la derecha pide salir y entra por la izquierda del nuevo", () => {
    const e = settled();
    e.exits = { left: [], right: [[0, H]] };
    e.flyTo(W + 400, 400, null);
    for (let i = 0; i < 6 * 60 && !e.exitRequest; i++) run(e, 1 / 60);
    expect(e.exitRequest?.side).toBe("right");
    e.setArea(1200, 700);
    e.enterFrom("right", 380);
    expect(e.x).toBeLessThan(100);
    expect(e.exitRequest).toBeNull();
  });

  it("un destino pegado al borde no lo muda de monitor aunque se pase de frenada (negativo)", () => {
    const e = settled();
    e.exits = { left: [[0, H]], right: [[0, H]] };
    for (const x of [W - 1, 1]) {
      e.goTo(x, 300);
      for (let i = 0; i < 8 * 60 && !e.takeArrival(); i++) {
        run(e, 1 / 60);
        expect(e.exitRequest).toBeNull();
      }
      expect(e.mode).toBe("hang");
    }
  });
});

describe("Navigator.walkTo (useTaskbar): viaje sin preguntar al Explorador", () => {
  const envOf = (x: number): Env => ({ origin_x: x, origin_y: 0, width: W, height: H, scale_factor: 1, supported: true });
  const screen = (x: number, current: boolean): ScreenInfo => ({
    x,
    y: 0,
    width: W,
    height: H,
    work_x: x,
    work_y: 0,
    work_width: W,
    work_height: H,
    scale: 1,
    current,
  });

  function setup(quiet = false) {
    let env = envOf(0);
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "mascot_screens") return [screen(0, env.origin_x === 0), screen(W, env.origin_x === W)];
      if (cmd === "mascot_move_to_screen") return (env = envOf(W));
      if (cmd === "mascot_file_at") return null;
      throw new Error(`comando inesperado: ${cmd}`);
    });
    const e = settled();
    const nav = new Navigator({
      engine: () => e,
      env: () => env,
      applyEnv: (n) => {
        env = n;
        e.setArea(n.width, n.height);
      },
      onFileArrived: () => {
        throw new Error("walkTo no coge ficheros");
      },
      quiet: () => quiet,
    });
    return { e, nav, calls: () => invokeMock.mock.calls.map((c) => c[0] as string) };
  }

  it("a otro monitor: deja el destino pendiente, cruza y llega sin pedir mascot_file_at", async () => {
    const { e, nav, calls } = setup();
    await nav.refreshScreens();
    expect(e.exits.right.length).toBe(1);
    let arrived = false;
    nav.walkTo(W + 700, H - 1, () => {
      arrived = true;
    });
    expect((nav as unknown as { pending: unknown }).pending).toEqual({ x: W + 700, y: H - 1 });
    for (let i = 0; i < 15 * 60 && !arrived; i++) {
      run(e, 1 / 60);
      nav.tick(null, false);
      await flush();
    }
    expect(arrived).toBe(true);
    expect(Math.abs(e.x - 700)).toBeLessThan(3);
    expect(calls()).toContain("mascot_move_to_screen");
    expect(calls()).not.toContain("mascot_file_at");
  });

  it("Ctrl+Alt+clic sí pregunta al Explorador; en silencio de juego, ni eso (negativo)", async () => {
    const click = { x: 300, y: H - 1, ctrl: true, alt: true, lbutton: true };
    const normal = setup();
    await normal.nav.refreshScreens();
    normal.nav.tick(click, false);
    expect(normal.calls()).toContain("mascot_file_at");

    const quiet = setup(true);
    await quiet.nav.refreshScreens();
    quiet.nav.tick(click, false);
    expect(quiet.calls()).not.toContain("mascot_file_at");
    expect(quiet.e.isTraveling()).toBe(false);
  });

  it("walkTo devuelve el id del viaje, que consta como llegado al acabar", async () => {
    const { e, nav } = setup();
    await nav.refreshScreens();
    const trip = nav.walkTo(800, 300);
    expect(nav.currentTrip()).toBe(trip);
    expect(nav.arrivedTrip()).not.toBe(trip);
    for (let i = 0; i < 8 * 60 && nav.arrivedTrip() !== trip; i++) {
      run(e, 1 / 60);
      nav.tick(null, false);
    }
    expect(nav.arrivedTrip()).toBe(trip);
    expect(e.mode).toBe("hang");
  });

  it("un Ctrl+Alt+clic posterior cambia el viaje en curso (negativo: la coreografía cede)", async () => {
    const { nav } = setup();
    await nav.refreshScreens();
    const trip = nav.walkTo(800, 300);
    nav.tick({ x: 300, y: H - 1, ctrl: true, alt: true, lbutton: true }, false);
    expect(nav.currentTrip()).not.toBe(trip);
    expect(nav.arrivedTrip()).not.toBe(trip);
  });
});

describe("Navigator: destino fuera de toda área de trabajo (monitores desalineados)", () => {
  /** Monitor derecho 130 px más abajo: la franja de encima no es de nadie. */
  const DROP = 130;
  const left: ScreenInfo = {
    x: 0, y: 0, width: W, height: H, work_x: 0, work_y: 0, work_width: W, work_height: H, scale: 1, current: true,
  };
  const right: ScreenInfo = { ...left, x: W, y: DROP, work_x: W, work_y: DROP, current: false };
  const envOf = (m: ScreenInfo): Env => ({
    origin_x: m.work_x, origin_y: m.work_y, width: m.work_width, height: m.work_height, scale_factor: 1, supported: true,
  });

  function setup() {
    let env = envOf(left);
    let hops = 0;
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string, args?: { x: number; y: number }) => {
      if (cmd === "mascot_screens")
        return [left, right].map((m) => ({ ...m, current: m.work_x === env.origin_x }));
      if (cmd === "mascot_move_to_screen") {
        hops++;
        return (env = envOf(args!.x >= W ? right : left));
      }
      throw new Error(`comando inesperado: ${cmd}`);
    });
    const e = settled();
    const nav = new Navigator({
      engine: () => e,
      env: () => env,
      applyEnv: (n) => {
        env = n;
        e.setArea(n.width, n.height);
      },
      onFileArrived: () => {},
    });
    return { e, nav, env: () => env, hops: () => hops };
  }

  it("encima del monitor desplazado: cruza una vez y llega al punto más cercano, sin ping-pong", async () => {
    const { e, nav, env, hops } = setup();
    await nav.refreshScreens();
    const trip = nav.walkTo(W + 700, 40);
    for (let i = 0; i < 15 * 60 && nav.arrivedTrip() !== trip; i++) {
      run(e, 1 / 60);
      nav.tick(null, false);
      await flush();
    }
    expect(nav.arrivedTrip()).toBe(trip);
    expect(env().origin_x).toBe(W);
    expect(hops()).toBe(1);
    expect(Math.abs(e.x - 700)).toBeLessThan(3);
  });

  it("si aun así rebota entre monitores, corta el viaje tras pocos saltos (negativo)", async () => {
    const { e, nav, hops } = setup();
    // Sin lista de monitores el destino no se puede ajustar: el tope es la red.
    nav.refreshScreens = async () => {};
    e.exits = { left: [[0, H]], right: [[0, H]] };
    nav.walkTo(W + 700, 40);
    for (let i = 0; i < 12 * 60; i++) {
      run(e, 1 / 60);
      nav.tick(null, false);
      await flush();
    }
    expect(hops()).toBeGreaterThan(0);
    expect(hops()).toBeLessThanOrEqual(3);
  });
});
