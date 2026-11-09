import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, MascotEngine } from "../engine";
import { hiddenText, type HiddenStatus } from "../../Settings/MascotSection";

const W = 1600;
const H = 860;

function grounded() {
  const e = new MascotEngine(W, H, { ...DEFAULT_SETTINGS, wander: false, activities: false }, () => 0.5);
  e.summon();
  run(e, 3);
  return e;
}

function run(e: MascotEngine, seconds: number) {
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) e.update({ dt, cursor: null, hovered: false, chat: "none" });
}

describe("arrastrarle un fichero encima", () => {
  it("levanta los brazos, abre los ojos y mira al fichero mientras el arrastre sigue encima", () => {
    const e = grounded();
    e.dropHover({ x: e.x + 30, y: e.y - 60 });
    run(e, 0.2);
    expect(e.awaitingDrop).toBe(true);
    e.facing = 1;
    const f = e.frame("none");
    expect(f.pose.armL).toBe("up");
    expect(f.pose.armR).toBe("up");
    expect(f.pose.brows).toBe("up");
    expect(f.pose.lookX).toBeGreaterThan(0);
  });

  it("mira al fichero también cuando está de cara a la izquierda (sprite reflejado)", () => {
    const e = grounded();
    e.dropHover({ x: e.x + 30, y: e.y - 60 });
    run(e, 0.2);
    // La mirada va en el espacio del sprite: reflejado, el fichero de la
    // derecha queda «detrás» y lookX es negativo. Sin `facing`, miraría al
    // lado contrario.
    e.facing = -1;
    expect(e.frame("none").pose.lookX).toBeLessThan(0);
  });

  it("vuelve a la normalidad al salir el arrastre o al soltarlo fuera", () => {
    const e = grounded();
    e.dropHover({ x: e.x, y: e.y - 40 });
    e.dropHover(null);
    expect(e.awaitingDrop).toBe(false);
    // Caso negativo: sin arrastre encima, los brazos no se levantan.
    const f = e.frame("none");
    expect(f.pose.armL === "up" && f.pose.armR === "up").toBe(false);
  });

  it("deja de esperar si los eventos de arrastre dejan de llegar", () => {
    const e = grounded();
    e.dropHover({ x: e.x, y: e.y - 40 });
    run(e, 11);
    expect(e.awaitingDrop).toBe(false);
  });

  it("se despierta si estaba dormido", () => {
    const e = grounded();
    e.mode = "sleep";
    e.dropHover({ x: e.x, y: e.y - 40 });
    expect(e.mode).not.toBe("sleep");
  });
});

describe("llamar a Pupus", () => {
  it("cae en la X del cursor, dentro de la pantalla", () => {
    const e = grounded();
    e.summon(300);
    expect(e.x).toBe(300);
    e.summon(-50);
    expect(e.x).toBeGreaterThan(0);
    e.summon(W + 500);
    expect(e.x).toBeLessThan(W);
    // Caso negativo: sin X (el cursor en otro monitor), al centro.
    e.summon();
    expect(e.x).toBe(W / 2);
  });
});

describe("motivo de ocultación en Settings", () => {
  const st = (patch: Partial<HiddenStatus>): HiddenStatus => ({
    hidden: true,
    manual: false,
    reason: null,
    shortcut: true,
    ...patch,
  });

  it("explica cada motivo y no dice nada si se ve", () => {
    expect(hiddenText(st({ reason: "manual", manual: true }))).toContain("Ctrl+Alt+P");
    expect(hiddenText(st({ reason: "call" }))).toContain("micrófono");
    expect(hiddenText(st({ reason: "fullscreen" }))).toContain("pantalla completa");
    expect(hiddenText(st({ hidden: false, reason: null }))).toBeNull();
    expect(hiddenText(null)).toBeNull();
  });
});
