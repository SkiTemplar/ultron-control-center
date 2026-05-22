// ULTRON Control Center — Button prompts client helper
//
// Mirrors the Rust catalog in `src-tauri/src/button_prompts.rs`. Components
// that spawn AI sessions used to inline their prompt as a string literal.
// They now go through `getPrompt(key, vars)` so the catalog (and any user
// override stored in `~/.ultron/cockpit/button-prompts.json`) becomes the
// single source of truth.
//
// v2.0: AI Router integration removed. `resolveAndSpawn` spawns `claude`
// directly (no router resolution). `useRoutingTitle` is a no-op kept for
// backward-compat with components that import it.

import { useEffect, useState } from "react";
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

export async function refreshButtonPrompts(): Promise<ButtonPromptsCatalog> {
  return loadCatalog(true);
}

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

export async function resetButtonPrompt(key: string): Promise<ButtonPrompt> {
  const updated = (await invoke("reset_button_prompt", { key })) as ButtonPrompt;
  await refreshButtonPrompts();
  return updated;
}

export function cachedCatalog(): ButtonPromptsCatalog | null {
  return cache;
}

// ---------------------------------------------------------------------------
// Spawn helper (no AI Router)
// ---------------------------------------------------------------------------

export type ResolvedRoute = {
  entry: {
    provider: string;
    model: string | null;
    agent: string | null;
    auto_mode: boolean;
  };
  auto_resolved: boolean;
  matched_agent: string | null;
  matched_score: number | null;
  fallback_reason: string | null;
};

export type ResolveAndSpawnOptions = {
  key: string;
  vars?: Record<string, string>;
  cwd?: string | null;
  extraFlags?: Record<string, unknown>;
  /** Deprecated in v2.0 (no AI router). Kept for back-compat at call sites. */
  routeOnPrompt?: boolean;
};

export type ResolveAndSpawnResult = {
  prompt: string;
  resolved: ResolvedRoute;
};

function staticRoute(): ResolvedRoute {
  return {
    entry: { provider: "claude", model: null, agent: null, auto_mode: false },
    auto_resolved: false,
    matched_agent: null,
    matched_score: null,
    fallback_reason: null,
  };
}

/**
 * Resolve `{key}` against the prompt catalog and spawn a Claude session.
 * v2.0: no AI router — always spawns `claude` with provider defaults.
 */
export async function resolveAndSpawn(
  opts: ResolveAndSpawnOptions,
): Promise<ResolveAndSpawnResult> {
  const { key, vars = {}, cwd = null, extraFlags = {} } = opts;
  const catalog = await loadCatalog();
  const entry = catalog.buttons.find((b) => b.key === key);
  if (!entry) {
    throw new Error(`unknown button prompt key: ${key}`);
  }
  let prompt = entry.prompt;
  for (const [k, v] of Object.entries(vars)) {
    prompt = prompt.split(`{${k}}`).join(v);
  }
  const resolved = staticRoute();
  await invoke("spawn_session", {
    provider: resolved.entry.provider,
    prompt,
    cwd,
    flags: {
      dangerouslySkipPermissions: false,
      ...extraFlags,
    },
  });
  return { prompt, resolved };
}

/**
 * Back-compat hook: returns `baseTitle` unchanged. Originally appended an AI
 * Router routing hint; the router is gone in v2.0 so this is a no-op.
 */
export function useRoutingTitle(_key: string, baseTitle = ""): string {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_state] = useState<string>("");
  useEffect(() => {
    /* no-op */
  }, []);
  return baseTitle;
}
