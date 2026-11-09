import { describe, expect, it } from "vitest";
import { BASE_FEELINGS, nudgeFeelings, parseFeelings, tickFeelings, type Feelings, type FeelingsContext } from "../feelings";

const calm: FeelingsContext = { engaged: false, sleeping: false, userAway: false };

function run(f: Feelings, seconds: number, ctx: FeelingsContext = calm, rest = BASE_FEELINGS): Feelings {
  let out = f;
  for (let t = 0; t < seconds; t += 0.1) out = tickFeelings(out, 0.1, ctx, rest);
  return out;
}

describe("sentimientos", () => {
  it("cada eje vuelve a su reposo", () => {
    const shaken: Feelings = { curiosity: 1, fear: 1, pride: 1, lonely: 0.3 };
    const later = run(shaken, 200);
    expect(later.curiosity).toBeCloseTo(BASE_FEELINGS.curiosity, 5);
    expect(later.fear).toBe(0);
    expect(later.lonely).toBe(0);
    // El orgullo dura minutos: a los 200 s aún queda algo; 100 s después, nada.
    expect(later.pride).toBeGreaterThan(0);
    expect(run(later, 100).pride).toBe(0);
  });

  it("el miedo sube y se pasa en menos de 15 s", () => {
    const scared = nudgeFeelings(BASE_FEELINGS, { fear: 0.9 });
    expect(scared.fear).toBeCloseTo(0.9);
    expect(run(scared, 15).fear).toBe(0);
  });

  it("la soledad solo sube mientras no estás", () => {
    const away = run(BASE_FEELINGS, 600, { ...calm, userAway: true });
    expect(away.lonely).toBeCloseTo(0.5, 1);
    // Caso negativo: si le haces caso, no sube aunque el sistema diga que no estás.
    const petted = run(BASE_FEELINGS, 600, { engaged: true, sleeping: false, userAway: true });
    expect(petted.lonely).toBe(0);
    // Caso negativo: estando tú, tampoco.
    expect(run(BASE_FEELINGS, 600).lonely).toBe(0);
  });

  it("el reposo se puede subir (memoria): el miedo no baja de él", () => {
    const wary = run({ ...BASE_FEELINGS, fear: 0.8 }, 30, calm, { ...BASE_FEELINGS, fear: 0.2 });
    expect(wary.fear).toBeCloseTo(0.2, 5);
  });

  it("no muta el objeto de entrada", () => {
    const f = { ...BASE_FEELINGS };
    nudgeFeelings(f, { fear: 1 });
    tickFeelings(f, 1, calm);
    expect(f).toEqual(BASE_FEELINGS);
  });

  it("parseFeelings acepta lo guardado y rechaza basura", () => {
    expect(parseFeelings({ fear: 2, pride: 0.5 })).toEqual({ ...BASE_FEELINGS, fear: 1, pride: 0.5 });
    expect(parseFeelings({ fear: "mucho" })?.fear).toBe(0);
    expect(parseFeelings(null)).toBeNull();
    expect(parseFeelings("no")).toBeNull();
  });
});
