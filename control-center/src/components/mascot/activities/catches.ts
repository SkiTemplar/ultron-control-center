// Mascota — lo que ha pescado Pupus (localStorage). Funciones puras más un
// almacén pequeño; solo se guardan tipos y cuentas, nada personal.
//
// Se consume en dos sitios: la primera captura de cada tipo tiene reacción
// especial (outdoors.ts) y el menú del clic derecho enseña el recuento.

import type { CatchKind } from "./types";

export const CATCHES_KEY = "mascot.catches";

export const CATCH_KINDS: readonly CatchKind[] = ["sardina", "payaso", "bota", "tmp"];

/** Probabilidad de cada captura (suman 1). */
export const CATCH_TABLE: readonly [CatchKind, number][] = [
  ["sardina", 0.5],
  ["payaso", 0.2],
  ["bota", 0.2],
  ["tmp", 0.1],
];

const LABEL: Record<CatchKind, [string, string]> = {
  sardina: ["sardina", "sardinas"],
  payaso: ["pez payaso", "peces payaso"],
  bota: ["bota vieja", "botas viejas"],
  tmp: ["fichero .tmp", "ficheros .tmp"],
};

export type Catches = Readonly<Record<CatchKind, number>>;

export const emptyCatches = (): Catches => ({ sardina: 0, payaso: 0, bota: 0, tmp: 0 });

/** Lee el JSON guardado; si está roto o es de otra versión, sin capturas. */
export function parseCatches(raw: string | null): Catches {
  const out = { ...emptyCatches() };
  if (!raw) return out;
  try {
    const v = JSON.parse(raw) as { v?: unknown; counts?: Record<string, unknown> };
    if (v?.v !== 1 || typeof v.counts !== "object" || !v.counts) return out;
    for (const k of CATCH_KINDS) {
      const n = v.counts[k];
      if (typeof n === "number" && Number.isFinite(n) && n > 0) out[k] = Math.floor(n);
    }
  } catch {
    return out;
  }
  return out;
}

export function serializeCatches(c: Catches): string {
  return JSON.stringify({ v: 1, counts: c });
}

/** Copia nueva con una captura más de `kind`. */
export function addCatch(c: Catches, kind: CatchKind): Catches {
  return { ...c, [kind]: c[kind] + 1 };
}

/** Captura según `r` en [0, 1). */
export function rollCatch(r: number): CatchKind {
  let left = r;
  for (const [k, p] of CATCH_TABLE) if ((left -= p) < 0) return k;
  return CATCH_TABLE[CATCH_TABLE.length - 1][0];
}

/** «Capturas: 3 sardinas, 1 bota vieja», o null si aún no ha pescado nada. */
export function catchSummary(c: Catches): string | null {
  const parts = CATCH_KINDS.filter((k) => c[k] > 0).map((k) => `${c[k]} ${LABEL[k][c[k] === 1 ? 0 : 1]}`);
  return parts.length ? `Capturas: ${parts.join(", ")}` : null;
}

export interface CatchStore {
  load(): Catches;
  save(c: Catches): void;
}

/** Almacén en localStorage; sin almacenamiento, recuerda solo en memoria. */
export function localCatchStore(): CatchStore {
  let mem = emptyCatches();
  return {
    load() {
      try {
        mem = parseCatches(window.localStorage.getItem(CATCHES_KEY));
      } catch {
        /* sin almacenamiento: lo que haya en memoria */
      }
      return mem;
    },
    save(c) {
      mem = c;
      try {
        window.localStorage.setItem(CATCHES_KEY, serializeCatches(c));
      } catch {
        /* sin almacenamiento: se queda en memoria */
      }
    },
  };
}
