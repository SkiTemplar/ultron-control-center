// Path helpers for the frontend.
//
// The Tauri backend owns the canonical knowledge of where the user's home
// directory and the ULTRON root live (see `ultron_root()` in lib.rs).
// Frontend code MUST go through these helpers instead of hardcoding
// `C:\Users\<name>\.ultron` or `~/.claude` so the app stays portable
// across user accounts and OSes.
//
// Both helpers cache the result for the lifetime of the page so repeated
// calls don't roundtrip through the Tauri bridge.

import { invoke } from "@tauri-apps/api/core";

let ultronRootCache: string | null = null;
let homeDirCache: string | null = null;

export async function getUltronRoot(): Promise<string> {
  if (ultronRootCache !== null) return ultronRootCache;
  const root = await invoke<string>("ultron_root_str");
  ultronRootCache = root;
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
