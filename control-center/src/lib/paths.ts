// Path helpers for the frontend.
//
// El backend es el que sabe donde estan el home del usuario y la raiz de
// mar.ia (`maria_root()` en lib.rs, que a su vez pregunta a `maria_paths`).
// El frontend NUNCA construye `C:\Users\<nombre>\.maria` a mano: asi la
// aplicacion sigue funcionando en otra cuenta, otro disco u otro sistema.
//
// Both helpers cache the result for the lifetime of the page so repeated
// calls don't roundtrip through the Tauri bridge.

import { invoke } from "@tauri-apps/api/core";

let mariaRootCache: string | null = null;
let homeDirCache: string | null = null;

export async function getMariaRoot(): Promise<string> {
  if (mariaRootCache !== null) return mariaRootCache;
  const root = await invoke<string>("maria_root_str");
  mariaRootCache = root;
  return root;
}

export async function getHomeDir(): Promise<string> {
  if (homeDirCache !== null) return homeDirCache;
  const home = await invoke<string>("home_dir_str");
  homeDirCache = home;
  return home;
}

/// Joins path segments with the platform separator inferred from the base.
/// We avoid pulling in a path lib by using a tiny heuristic: if the base
/// contains a backslash, treat it as Windows-style; otherwise POSIX.
export function joinPath(base: string, ...segments: string[]): string {
  const sep = base.includes("\\") ? "\\" : "/";
  // Strip trailing separator from base, leading from each segment.
  const trimmedBase = base.replace(/[\\/]+$/, "");
  const cleaned = segments.map((s) => s.replace(/^[\\/]+|[\\/]+$/g, ""));
  return [trimmedBase, ...cleaned].join(sep);
}
