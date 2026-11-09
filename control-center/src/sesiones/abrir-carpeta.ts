// Sesión nueva de Claude en una carpeta pedida desde fuera: entrada «ULTRON Sessions aquí»
// del menú contextual del Explorador (`control-center.exe --sesiones-cwd <ruta>`, ver
// `src-tauri/src/sesiones/abrir_carpeta.rs`). Llega por `?cwd=<ruta>` si la ventana se
// crea en ese momento o por `sesiones://new-in-cwd` si ya estaba abierta.

import type { SesionesApi } from "./api";
import { lastUsedProfile, launchWithProfile } from "./launch-profiles";

export const CWD_PARAM = "cwd";

/**
 * Carpeta pedida en la URL y la URL sin el parámetro. `cwd` es null si no hay o está
 * vacío; `url` es null si la URL no lleva el parámetro (nada que reescribir).
 */
export function takeCwdParam(href: string): { cwd: string | null; url: string | null } {
  const url = new URL(href);
  if (!url.searchParams.has(CWD_PARAM)) return { cwd: null, url: null };
  const cwd = url.searchParams.get(CWD_PARAM)?.trim() || null;
  url.searchParams.delete(CWD_PARAM);
  return { cwd, url: url.toString() };
}

/**
 * Lee `?cwd=` y lo quita de la URL antes de crear la sesión: una recarga de la página
 * (F5 o el vigilante de caídas del renderer) no debe abrir otra sesión en la carpeta.
 */
export function consumeCwdParam(): string | null {
  const { cwd, url } = takeCwdParam(window.location.href);
  if (url) window.history.replaceState(window.history.state, "", url);
  return cwd;
}

/** Sesión nueva en `cwd` con el último perfil usado (como Ctrl+T). */
export function newSessionInFolder(api: SesionesApi, cwd: string): Promise<void> {
  return launchWithProfile(api, { kind: "cwd", cwd }, lastUsedProfile());
}
