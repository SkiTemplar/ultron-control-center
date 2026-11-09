// ULTRON Control Center — AI Router: guardado de una zona.
//
// `ai_router_save_zone` devuelve la zona tal y como queda en disco, o un
// error con el motivo cuando la carga siguiente revertiría la edición (p. ej.
// gemini-cli retirado o un fallback del seed quitado). La UI pinta lo que
// devuelve el backend, nunca su borrador: antes marcaba «Guardado» y copiaba
// el borrador aunque la carga siguiente deshiciera el cambio.

import type { Zone } from "./types";

export type SaveZoneResult = { ok: true; zone: Zone } | { ok: false; error: string };

export type InvokeFn = (cmd: string, args: Record<string, unknown>) => Promise<unknown>;

/** Guarda `draft` y devuelve la zona persistida o el error del backend. */
export async function saveZoneDraft(invokeFn: InvokeFn, draft: Zone): Promise<SaveZoneResult> {
  try {
    const saved = (await invokeFn("ai_router_save_zone", { zone: draft })) as Zone | null;
    if (!saved || typeof saved !== "object" || saved.id !== draft.id) {
      return {
        ok: false,
        error: "El backend no ha devuelto la zona guardada; recarga para ver el estado real.",
      };
    }
    return { ok: true, zone: saved };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
