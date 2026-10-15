import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, EMOTE_DURATION, JEALOUS_COLOR_AT, MascotEngine, type MascotSettings } from "../engine";
import { AGENT_COLORS, BASE_MOOD, moodName, parseMood, tickMood, type Mood } from "../mood";

const W = 1600;
const H = 860;

function engine(patch: Partial<MascotSettings> = {}) {
  return new MascotEngine(W, H, { ...DEFAULT_SETTINGS, wander: false, sleep_after_min: 0, ...patch }, () => 0.5);
}

function run(e: MascotEngine, seconds: number, input: { hovered?: boolean; petHover?: boolean; cursor?: { x: number; y: number } | null } = {}) {
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) {
    e.update({ dt, cursor: input.cursor ?? null, hovered: !!input.hovered, petHover: input.petHover, chat: "none" });
    e.frame("none");
  }
}

const near = (a: number[], b: number[], tol = 2) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

describe("ánimo", () => {
  it("cada eje vuelve a su reposo con el tiempo", () => {
    let m: Mood = { happy: -1, energy: 0.8, jealousy: 1, anger: 1, boredom: 0 };
    for (let i = 0; i < 200; i++) m = tickMood(m, 1, { sleeping: false, engaged: true, chattingOther: false });
    expect(m.anger).toBe(0);
    expect(m.jealousy).toBe(0);
    expect(m.happy).toBeCloseTo(BASE_MOOD.happy, 5);
  });

  it("los celos no se pasan mientras siga hablando con otro agente", () => {
    let m: Mood = { ...BASE_MOOD, jealousy: 0.8 };
    for (let i = 0; i < 100; i++) m = tickMood(m, 1, { sleeping: false, engaged: true, chattingOther: true });
    expect(m.jealousy).toBe(0.8);
  });

  it("nombra el ánimo por prioridad", () => {
    expect(moodName({ ...BASE_MOOD, anger: 0.9, jealousy: 0.9 })).toBe("enfadada");
    expect(moodName({ ...BASE_MOOD, jealousy: 0.6 })).toBe("celosa");
    expect(moodName({ ...BASE_MOOD, happy: -0.6 })).toBe("triste");
    expect(moodName({ ...BASE_MOOD, energy: 0.1 })).toBe("cansada");
    expect(moodName({ ...BASE_MOOD, happy: 0.9, energy: 0.9 })).toBe("emocionada");
    expect(moodName(BASE_MOOD)).toBe("contenta");
  });

  it("parseMood acepta lo guardado y rechaza basura", () => {
    expect(parseMood('{"happy":2,"anger":0.5}')?.happy).toBe(1);
    expect(parseMood("no json")).toBeNull();
    expect(parseMood(null)).toBeNull();
  });
});

describe("elegir agente", () => {
  it("elegir GPT da celos y, tras la reacción, se disfraza de verde", () => {
    const e = engine();
    run(e, 2); // termina el saludo inicial
    e.chooseAgent("codex");
    expect(e.mode).toBe("emote");
    expect(e.emote).toBe("jealous");
    expect(e.moodName).toBe("celosa");
    run(e, JEALOUS_COLOR_AT - 0.2);
    expect(near(e.colorTarget, AGENT_COLORS.claude)).toBe(true); // aún no
    run(e, EMOTE_DURATION.jealous - JEALOUS_COLOR_AT + 1.5);
    expect(near(e.colorTarget, AGENT_COLORS.codex)).toBe(true);
    expect(near(e.color, AGENT_COLORS.codex, 30)).toBe(true); // fundido casi completo
    expect(e.effects.some((f) => f.kind === "tear")).toBe(false); // ya cayeron
  });

  it("elegir Gemini la vuelve azul; al cerrar vuelve a su color", () => {
    const e = engine();
    run(e, 2);
    e.chooseAgent("antigravity");
    run(e, 4);
    expect(near(e.colorTarget, AGENT_COLORS.antigravity)).toBe(true);
    e.chatEnded();
    expect(near(e.colorTarget, AGENT_COLORS.claude)).toBe(true);
    expect(e.emote).toBe("poof");
  });

  it("elegir a Claude la alegra y no cambia de color (caso negativo de los celos)", () => {
    const e = engine();
    run(e, 2);
    const before = e.mood.happy;
    e.chooseAgent("claude");
    expect(e.emote).toBe("joy");
    expect(e.mood.happy).toBeGreaterThan(before);
    expect(e.mood.jealousy).toBe(0);
    run(e, 4);
    expect(near(e.colorTarget, AGENT_COLORS.claude)).toBe(true);
  });

  it("en el aire no hay reacción completa: se disfraza al momento", () => {
    const e = engine();
    e.summon();
    e.chooseAgent("codex");
    expect(e.mode).toBe("air");
    expect(near(e.colorTarget, AGENT_COLORS.codex)).toBe(true);
  });
});

describe("reacciones", () => {
  it("cuatro clics seguidos la enfadan", () => {
    const e = engine();
    run(e, 2);
    for (let i = 0; i < 4; i++) {
      e.poke();
      run(e, 0.6);
    }
    expect(e.moodName).toBe("enfadada");
  });

  it("estamparla la enfada un poco", () => {
    const e = engine();
    e.x = 800;
    e.y = 400;
    e.startDrag(800, 400, 0);
    e.dragTo(800 - 175, 400, 0.05);
    e.endDrag(false);
    run(e, 0.5);
    expect(e.mood.anger).toBeGreaterThan(0.1);
  });

  it("acariciarla (frotar el cursor por encima) la enamora", () => {
    const e = engine();
    run(e, 2);
    const dt = 1 / 60;
    for (let i = 0; i < 120; i++) {
      const cursor = { x: e.x + Math.sin(i / 2) * 20, y: e.y - 20 };
      e.update({ dt, cursor, hovered: true, petHover: true, chat: "none" });
      e.frame("none");
    }
    expect(e.emote).toBe("love");
    expect(e.mood.happy).toBeGreaterThan(BASE_MOOD.happy);
  });

  it("entrar desde lejos de golpe NO cuenta como caricia", () => {
    const e = engine();
    run(e, 2);
    for (let i = 0; i < 20; i++) {
      const far = i % 2 === 0;
      e.update({
        dt: 1 / 60,
        cursor: far ? { x: 5, y: 5 } : { x: e.x, y: e.y - 20 },
        hovered: !far,
        petHover: !far,
        chat: "none",
      });
    }
    expect(e.emote).not.toBe("love");
  });

  it("pasar el cursor quieto por encima NO cuenta como caricia", () => {
    const e = engine();
    run(e, 2);
    run(e, 3, { hovered: true, petHover: true, cursor: { x: e.x, y: e.y - 20 } });
    expect(e.emote).not.toBe("love");
  });

  it("cansada se duerme sola y despierta estirándose al recargarse", () => {
    const e = engine();
    run(e, 2);
    e.mood = { ...e.mood, energy: 0.05 };
    run(e, 7);
    expect(e.mode).toBe("sleep");
    run(e, 60);
    expect(["emote", "idle"]).toContain(e.mode);
    expect(e.mood.energy).toBeGreaterThan(0.9);
  });

  it("todas las animaciones con guion terminan y vuelven a reposo", () => {
    for (const name of Object.keys(EMOTE_DURATION) as (keyof typeof EMOTE_DURATION)[]) {
      const e = engine();
      run(e, 2);
      e.play(name);
      expect(e.emote).toBe(name);
      run(e, EMOTE_DURATION[name] + 0.2);
      expect(e.mode, name).toBe("idle");
      expect(e.x).toBeGreaterThanOrEqual(e.halfW);
    }
  });

  it("el muelle de aplastamiento rebota y se asienta en 1", () => {
    const e = engine();
    run(e, 2);
    e.poke();
    let minSy = 9;
    for (let i = 0; i < 180; i++) {
      e.update({ dt: 1 / 60, cursor: null, hovered: false, chat: "none" });
      minSy = Math.min(minSy, e.frame("none").pose.sy);
    }
    expect(minSy).toBeLessThan(0.95);
    expect(e.frame("none").pose.sy).toBeCloseTo(1, 1);
  });
});
