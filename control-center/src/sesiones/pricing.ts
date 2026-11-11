// Coste aproximado de un turno a partir del `usage` del transcript o del puente.
// Misma tabla que el agregador de uso (`scripts/lib/usage-transcripts.mjs`): si
// cambia una, cambia la otra. El transcript separa la escritura de caché de 5 min
// (1,25× la entrada) y de 1 h (2×); sin desglose se cobra como 5 min, igual que el
// agregador. El modo rápido (`speed: "fast"`) multiplica por 2 todo el turno.

import type { Usage } from "./types";

/** $/MTok: [entrada, salida, lectura de caché]. */
const PRICES: Record<string, [number, number, number]> = {
  "claude-opus-5-5": [4, 20, 0.2],
  "claude-opus-5": [5, 25, 0.5],
  "claude-opus-4-8": [5, 25, 0.5],
  "claude-opus-4-7": [5, 25, 0.5],
  "claude-opus-4-6": [5, 25, 0.5],
  "claude-sonnet-5-5": [2, 10, 0.2],
  "claude-sonnet-5": [2, 10, 0.2],
  "claude-sonnet-4-6": [3, 15, 0.3],
  "claude-haiku-5-5": [0.1, 0.5, 0.01],
  "claude-fable-5-2": [8, 40, 0.2],
  "claude-fable-5-1": [10, 50, 0.25],
  "claude-fable-5": [10, 50, 0.25],
  "claude-haiku-4-5": [1, 5, 0.1],
};
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;
const FAST_MULTIPLIER = 2;

/** Quita el sufijo de fecha (`-20251001`) y el de contexto (`[1m]`). */
export function normalizeModel(model: string): string {
  return model.replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "");
}

/** Escritura de caché separada en 5 min y 1 h; sin desglose, todo cuenta como 5 min. */
function cacheWrites(u: Usage): { w5m: number; w1h: number } {
  if (u.cacheWrite5m === undefined && u.cacheWrite1h === undefined) return { w5m: u.cacheWrite, w1h: 0 };
  return { w5m: u.cacheWrite5m ?? 0, w1h: u.cacheWrite1h ?? 0 };
}

/** Coste en USD de un uso con un modelo, o `null` si el modelo no tiene precio. */
export function costOf(model: string | undefined | null, u: Usage): number | null {
  const p = model ? PRICES[normalizeModel(model)] : undefined;
  if (!p) return null;
  const [pin, pout, pread] = p;
  const { w5m, w1h } = cacheWrites(u);
  const base = u.input * pin + u.output * pout + u.cacheRead * pread + w5m * pin * CACHE_WRITE_5M + w1h * pin * CACHE_WRITE_1H;
  return (base * (u.speed === "fast" ? FAST_MULTIPLIER : 1)) / 1e6;
}

export const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const hasSplit = (u: Usage): boolean => u.cacheWrite5m !== undefined || u.cacheWrite1h !== undefined;

/** Suma dos usos; el desglose de caché se conserva si cualquiera de los dos lo trae. */
export function addUsage(a: Usage, b: Usage): Usage {
  const out: Usage = { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite };
  if (hasSplit(a) || hasSplit(b)) {
    const ca = cacheWrites(a);
    const cb = cacheWrites(b);
    out.cacheWrite5m = ca.w5m + cb.w5m;
    out.cacheWrite1h = ca.w1h + cb.w1h;
  }
  if (a.speed === "fast" || b.speed === "fast") out.speed = "fast";
  return out;
}
