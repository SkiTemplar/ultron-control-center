// Conjunto de notificaciones ocultas en este navegador.
//
// Cada huella guarda el instante en que se ocultó (`hiddenAt`, ms). Un grupo
// solo queda oculto mientras no tenga una repetición posterior: si la misma
// alerta vuelve a dispararse después, reaparece. Antes era un `Set` de huellas
// que nadie podaba, así que ocultar o borrar una alerta escondía para siempre
// cada repetición, críticas incluidas.

export type Dismissed = ReadonlyMap<string, number>;

/** Oculto si se ocultó y no ha vuelto a ocurrir después. Sin fecha legible, manda la ocultación. */
export function isHidden(dismissed: Dismissed, fp: string, lastTs: string): boolean {
  const hiddenAt = dismissed.get(fp);
  if (hiddenAt === undefined) return false;
  const last = Date.parse(lastTs);
  return Number.isNaN(last) || last <= hiddenAt;
}

/** Copia con las huellas ocultas en `now`. */
export function hideAll(dismissed: Dismissed, fps: readonly string[], now: number): Map<string, number> {
  const next = new Map(dismissed);
  for (const fp of fps) next.set(fp, now);
  return next;
}

/** Copia sin las huellas indicadas (tras borrarlas del disco ya no hay nada que ocultar). */
export function forget(dismissed: Dismissed, fps: readonly string[]): Map<string, number> {
  const next = new Map(dismissed);
  for (const fp of fps) next.delete(fp);
  return next;
}

/** Copia de `current` con las huellas indicadas como estaban en `previous` (deshace una máscara optimista). */
export function restore(current: Dismissed, previous: Dismissed, fps: readonly string[]): Map<string, number> {
  const next = forget(current, fps);
  for (const fp of fps) {
    const at = previous.get(fp);
    if (at !== undefined) next.set(fp, at);
  }
  return next;
}

/** Lee el formato persistido (`{huella: hiddenAt}`); descarta lo que no encaje. */
export function parseDismissed(raw: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [fp, at] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof at === "number" && Number.isFinite(at)) out.set(fp, at);
  }
  return out;
}

export function serializeDismissed(dismissed: Dismissed): Record<string, number> {
  return Object.fromEntries(dismissed);
}
