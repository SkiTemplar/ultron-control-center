import { describe, expect, it } from "vitest";
import { BASE_MOOD, moodSpeed, type Mood, type MoodName } from "../mood";
import { BASE_FEELINGS, type Feelings } from "../feelings";
import { MARGIN, MOOD_STATES, URGENT, pickState, scoreStates, transitionCue, type MoodState, type Scene } from "../moodState";
import { STATE_TABLE, choicesFor } from "../moodTable";
import type { Episode } from "../episodes";

const NOON = new Date(2026, 9, 14, 12, 0, 0);
const NIGHT = new Date(2026, 9, 14, 3, 0, 0);
const day: Scene = { now: NOON, activity: "otro", userActive: true, cursorPlay: false };

interface Fixture {
  mood?: Partial<Mood>;
  feel?: Partial<Feelings>;
  scene?: Partial<Scene>;
  eps?: Episode[];
}

const FIXTURES: Record<MoodState, Fixture> = {
  contento: {},
  feliz: { mood: { happy: 0.6 } },
  emocionado: { mood: { happy: 0.9, energy: 0.9 } },
  jugueton: { mood: { happy: 0.5, energy: 0.8, boredom: 0.5 }, scene: { cursorPlay: true } },
  curioso: { feel: { curiosity: 0.8 } },
  concentrado: { scene: { activity: "ide" } },
  orgulloso: { feel: { pride: 0.8 } },
  aburrido: { mood: { boredom: 0.9 } },
  somnoliento: { scene: { now: NIGHT } },
  cansado: { mood: { energy: 0.1 } },
  solitario: { feel: { lonely: 0.9 } },
  grunon: { mood: { anger: 0.4 } },
  asustado: { feel: { fear: 0.8 } },
  triste: { mood: { happy: -0.6 } },
  enfadado: { mood: { anger: 0.8 } },
  celoso: { mood: { jealousy: 0.6 } },
};

function scoresOf(f: Fixture) {
  const nowMs = (f.scene?.now ?? NOON).getTime();
  return scoreStates({ ...BASE_MOOD, ...f.mood }, { ...BASE_FEELINGS, ...f.feel }, { ...day, ...f.scene }, f.eps ?? [], nowMs);
}

describe("estados de ánimo", () => {
  it("cada uno de los 16 estados es alcanzable", () => {
    expect(MOOD_STATES).toHaveLength(16);
    for (const s of MOOD_STATES) {
      const prev: MoodState = s === "contento" ? "feliz" : "contento";
      expect(pickState(prev, scoresOf(FIXTURES[s]), 999, 0), s).toBe(s);
    }
  });

  it("concentrado necesita que estés usando el equipo", () => {
    expect(pickState("contento", scoresOf({ scene: { activity: "ide", userActive: false } }), 999, 0)).toBe("contento");
  });

  it("gruñón al despertarle y tras dos fallos seguidos", () => {
    const now = NOON.getTime();
    const woke = scoresOf({ eps: [{ k: "despertado", at: now - 10_000 }] });
    expect(pickState("contento", woke, 999, 0)).toBe("grunon");
    const old = scoresOf({ eps: [{ k: "despertado", at: now - 120_000 }] });
    expect(pickState("contento", old, 999, 0)).toBe("contento");
    const reds = scoresOf({ eps: [{ k: "testsRojos", at: now - 1 }, { k: "testsRojos", at: now }] });
    expect(pickState("contento", reds, 999, 0)).toBe("grunon");
  });

  it("histéresis: puntuaciones que oscilan ±0.05 apenas cambian el estado", () => {
    const base = scoresOf({});
    let state: MoodState = "contento";
    let naive: MoodState = "contento";
    let since = 0;
    let changes = 0;
    let naiveChanges = 0;
    for (let i = 0; i < 60; i++) {
      const scores = { ...base, feliz: base.contento + (i % 2 ? 0.05 : -0.05) };
      since += 1;
      const next = pickState(state, scores, since, STATE_TABLE[state].dwellS);
      if (next !== state) {
        changes++;
        since = 0;
      }
      state = next;
      const top = scores.feliz > scores.contento ? "feliz" : "contento";
      if (top !== naive) naiveChanges++;
      naive = top;
    }
    expect(changes).toBeLessThanOrEqual(1);
    // Caso negativo: sin margen ni permanencia, el estado parpadearía.
    expect(naiveChanges).toBeGreaterThan(30);
    expect(MARGIN).toBeGreaterThan(0.05);
  });

  it("los urgentes entran al momento aunque no se haya cumplido la permanencia", () => {
    const scared = scoresOf({ feel: { fear: 0.8, pride: 0.8 } });
    expect(pickState("orgulloso", scared, 0, STATE_TABLE.orgulloso.dwellS)).toBe("asustado");
    expect(URGENT.has("asustado")).toBe(true);
    // Caso negativo: uno que no es urgente espera a la permanencia mínima.
    const proud = scoresOf({ feel: { pride: 0.9 } });
    expect(pickState("curioso", proud, 1, STATE_TABLE.curioso.dwellS)).toBe("curioso");
    expect(pickState("curioso", proud, STATE_TABLE.curioso.dwellS, STATE_TABLE.curioso.dwellS)).toBe("orgulloso");
  });

  it("gestos de transición", () => {
    expect(transitionCue("somnoliento", "emocionado")).toBe("stretch");
    expect(transitionCue("feliz", "asustado")).toBe("surprised");
    expect(transitionCue("grunon", "contento")).toBe("sigh");
    expect(transitionCue("feliz", "feliz")).toBeNull();
    expect(transitionCue("feliz", "triste")).toBeNull();
  });
});

describe("tabla de conductas", () => {
  it("los ocho estados de mood.ts conservan su velocidad de moodSpeed", () => {
    const old: MoodName[] = ["emocionado", "feliz", "contento", "aburrido", "cansado", "celoso", "triste", "enfadado"];
    for (const s of old) expect(STATE_TABLE[s].speed, s).toBe(moodSpeed(s));
  });

  it("sin ganas de pasear casi no camina ni salta a ventanas", () => {
    const weight = (w: [string, number][], c: string) => w.filter(([k]) => k === c).reduce((a, [, n]) => a + n, 0);
    const free = choicesFor("contento", true, false, true);
    const still = choicesFor("contento", true, false, false);
    expect(weight(still, "walk")).toBeLessThan(weight(free, "walk") / 4);
    expect(weight(still, "jumpUp")).toBe(0);
    expect(weight(free, "jumpUp")).toBeGreaterThan(0);
    // Sin energía no salta ni con ganas.
    expect(weight(choicesFor("cansado", true, true, true), "hopDown")).toBe(0);
  });

  it("solo los estados que ya lo tenían (los cinco de antes) muestran icono al pasar el cursor", () => {
    const withIcon = MOOD_STATES.filter((s) => STATE_TABLE[s].hoverIcon);
    expect(withIcon.sort()).toEqual(["celoso", "emocionado", "enfadado", "feliz", "triste"].sort());
  });
});
