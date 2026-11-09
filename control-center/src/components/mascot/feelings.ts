// Mascota — sentimientos que completan el ánimo de mood.ts (modelo puro).
//
// mood.ts lleva alegría, energía, celos, enfado y aburrimiento. Aquí van los
// ejes que hacen falta para los estados nuevos, con la misma idea: suben con
// lo que pasa y vuelven solos a su reposo.
//
//   curiosity  0..1  algo nuevo (fichero, sesión que pregunta, fin de juego) ↘ 0.03/s
//   fear       0..1  lanzamientos, zarandeos, fallos                         ↘ 0.08/s
//   pride      0..1  turnos largos que terminan, tests arreglados            ↘ 0.004/s (minutos)
//   lonely     0..1  sube mientras no estás (1/1200 por s: 20 min a tope)    ↘ 0.5/s si le haces caso
//
// El reposo puede no ser 0: la memoria de sucesos (episodes.ts) lo sube,
// por ejemplo, tras varios lanzamientos seguidos (se queda receloso).

export interface Feelings {
  curiosity: number;
  fear: number;
  pride: number;
  lonely: number;
}

export const BASE_FEELINGS: Feelings = { curiosity: 0.1, fear: 0, pride: 0, lonely: 0 };

export interface FeelingsContext {
  /** Alguien le hace caso (hover, arrastre, conversación). */
  engaged: boolean;
  sleeping: boolean;
  /** Llevas más de 5 min sin tocar teclado ni ratón. */
  userAway: boolean;
}

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

export function clampFeelings(f: Feelings): Feelings {
  return {
    curiosity: clamp01(f.curiosity),
    fear: clamp01(f.fear),
    pride: clamp01(f.pride),
    lonely: clamp01(f.lonely),
  };
}

export function nudgeFeelings(f: Feelings, d: Partial<Feelings>): Feelings {
  return clampFeelings({
    curiosity: f.curiosity + (d.curiosity ?? 0),
    fear: f.fear + (d.fear ?? 0),
    pride: f.pride + (d.pride ?? 0),
    lonely: f.lonely + (d.lonely ?? 0),
  });
}

/** Acercar `v` a `target` a `rate` unidades por segundo. */
function toward(v: number, target: number, rate: number, dt: number): number {
  const step = rate * dt;
  return Math.abs(target - v) <= step ? target : v + Math.sign(target - v) * step;
}

function tickLonely(v: number, dt: number, ctx: FeelingsContext, rest: number): number {
  if (ctx.engaged) return toward(v, 0, 0.5, dt);
  if (ctx.sleeping) return v;
  if (ctx.userAway) return v + dt / 1200;
  return toward(v, rest, 0.01, dt);
}

/** Un paso de `dt` segundos. `rest` = reposo de cada eje (por defecto, BASE_FEELINGS). */
export function tickFeelings(
  f: Feelings,
  dt: number,
  ctx: FeelingsContext,
  rest: Feelings = BASE_FEELINGS,
): Feelings {
  return clampFeelings({
    curiosity: toward(f.curiosity, rest.curiosity, 0.03, dt),
    fear: toward(f.fear, rest.fear, 0.08, dt),
    pride: toward(f.pride, rest.pride, 0.004, dt),
    lonely: tickLonely(f.lonely, dt, ctx, rest.lonely),
  });
}

/** Sentimientos guardados (o null si no son un objeto). Los ejes inválidos van a su reposo. */
export function parseFeelings(raw: unknown): Feelings | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Partial<Record<keyof Feelings, unknown>>;
  const n = (x: unknown, d: number) => (typeof x === "number" && Number.isFinite(x) ? x : d);
  return clampFeelings({
    curiosity: n(v.curiosity, BASE_FEELINGS.curiosity),
    fear: n(v.fear, BASE_FEELINGS.fear),
    pride: n(v.pride, BASE_FEELINGS.pride),
    lonely: n(v.lonely, BASE_FEELINGS.lonely),
  });
}
