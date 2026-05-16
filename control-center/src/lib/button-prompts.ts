// ULTRON Control Center — Button prompts client helper
//
// Mirrors the Rust catalog in `src-tauri/src/button_prompts.rs`. Components
// that spawn AI sessions used to inline their prompt as a string literal.
// They now go through `getPrompt(key, vars)` so the catalog (and any user
// override stored in `~/.ultron/cockpit/button-prompts.json`) becomes the
// single source of truth.
//
// Caching strategy: we keep a module-level catalog snapshot + a Set of
// subscribers. `getPrompt(...)` reuses the cache; the Settings panel calls
// `refreshButtonPrompts()` after saving so consumers see the new prompt
// without a hard reload.

import { invoke } from "@tauri-apps/api/core";

export type ButtonPrompt = {
  key: string;
  label: string;
  location: string;
  description: string;
  /** Effective prompt (default merged with user override, if any). */
  prompt: string;
  /** Canonical default — what the prompt would be without overrides. */
  default_prompt: string;
  /** True when `prompt !== default_prompt`. */
  overridden: boolean;
  /** AI Router zone hint, empty when not applicable. */
  zone: string;
  /** Names of `{vars}` the consumer should pass to `getPrompt`. */
  vars: string[];
};

export type ButtonPromptsCatalog = {
  schema_version: number;
  buttons: ButtonPrompt[];
};

let cache: ButtonPromptsCatalog | null = null;
let inflight: Promise<ButtonPromptsCatalog> | null = null;
const subscribers = new Set<(c: ButtonPromptsCatalog) => void>();

function notify() {
  if (cache) {
    subscribers.forEach((cb) => cb(cache as ButtonPromptsCatalog));
  }
}

async function loadCatalog(force = false): Promise<ButtonPromptsCatalog> {
  if (!force && cache) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const c = (await invoke("list_button_prompts")) as ButtonPromptsCatalog;
      cache = c;
      notify();
      return c;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Subscribe to catalog changes. Returns an unsubscribe fn. The callback is
 * fired immediately when the cache is already populated so callers don't
 * have to special-case the first render.
 */
export function subscribeButtonPrompts(
  cb: (c: ButtonPromptsCatalog) => void,
): () => void {
  subscribers.add(cb);
  if (cache) cb(cache);
  else void loadCatalog().catch(() => {});
  return () => {
    subscribers.delete(cb);
  };
}

/** Force a reload — the Settings tab calls this after every save. */
export async function refreshButtonPrompts(): Promise<ButtonPromptsCatalog> {
  return loadCatalog(true);
}

/**
 * Return the effective prompt for `key`, interpolating any `{var}` placeholders
 * with values from `vars`. Throws if the key is unknown so consumers fail loud
 * rather than spawning a Claude session with an empty prompt.
 */
export async function getPrompt(
  key: string,
  vars: Record<string, string> = {},
): Promise<string> {
  const c = await loadCatalog();
  const entry = c.buttons.find((b) => b.key === key);
  if (!entry) {
    throw new Error(`unknown button prompt key: ${key}`);
  }
  let out = entry.prompt;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{${k}}`).join(v);
  }
  return out;
}

/** Persist an override (or empty string to reset). Refreshes the cache. */
export async function updateButtonPrompt(
  key: string,
  prompt: string,
): Promise<ButtonPrompt> {
  const updated = (await invoke("update_button_prompt", {
    key,
    prompt,
  })) as ButtonPrompt;
  await refreshButtonPrompts();
  return updated;
}

/** Drop the override for a button (back to canonical default). */
export async function resetButtonPrompt(key: string): Promise<ButtonPrompt> {
  const updated = (await invoke("reset_button_prompt", { key })) as ButtonPrompt;
  await refreshButtonPrompts();
  return updated;
}

/** Synchronous accessor for components that already have a cached catalog. */
export function cachedCatalog(): ButtonPromptsCatalog | null {
  return cache;
}
