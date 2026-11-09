// Bloques de Codex/Gemini descartados del hilo («Descartar» en EngineBlock). Se
// guardan en localStorage para que no vuelvan al recargar la ventana ni al
// reiniciar ULTRON; la tarea sigue en la pestaña Motores.

export const DISMISSED_KEY = "ultron.sesiones.engineDismissed";
/** Tope de ids recordados (los más antiguos se olvidan). */
export const DISMISSED_CAP = 500;

/** Ids guardados, validados y con tope; vacío si no hay nada o está corrupto. */
export function loadDismissed(max: number = DISMISSED_CAP): string[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(DISMISSED_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter((v): v is string => typeof v === "string" && v.length > 0 && v.length <= 200).slice(-max);
  } catch {
    return [];
  }
}

/** `false` si no se pudo guardar (sin almacenamiento): el descarte dura lo que la ventana. */
export function saveDismissed(ids: readonly string[]): boolean {
  try {
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(ids));
    return true;
  } catch {
    return false;
  }
}
