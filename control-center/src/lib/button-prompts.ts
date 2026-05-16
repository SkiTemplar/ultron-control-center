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

// ---------------------------------------------------------------------------
// v15.2.40 — AI Router integration helper
//
// Every Control Center button that opens an AI session funnels through the
// `resolveAndSpawn` helper below. It:
//   1. resolves the prompt from the central catalog (with {var} substitution)
//   2. calls `resolve_zone_for_prompt` on the backend — which honours the
//      zone's `auto_mode` flag and falls back to the manual provider/model/
//      agent picks if auto-mode is off or the agents index fails
//   3. invokes `spawn_session` with the resolved provider/model/agent
//
// Components don't need to know about the AI Router internals; they just
// call `resolveAndSpawn({ key, vars, cwd, extraFlags })`. The helper never
// throws on resolver/router errors — it surfaces the failure and uses the
// historical hardcoded provider (claude) so the button keeps working even
// when `ai-router.json` is missing or `embed_agents.py` is broken.
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
  /** Button-prompts catalog key, e.g. `notif.fix_one`. */
  key: string;
  /** `{var}` substitutions for the prompt template. */
  vars?: Record<string, string>;
  /** Working directory for the spawned session. `null` = ULTRON cwd. */
  cwd?: string | null;
  /** Extra flags merged into `spawn_session` flags (model/agent are filled by us). */
  extraFlags?: Record<string, unknown>;
  /**
   * When the prompt is the same regardless of `vars` (no template), the
   * router uses the resolved prompt as input to the agents index. Set
   * this to `false` to deliberately route on a different prompt (e.g.
   * use a routing hint instead of the full prompt). Default `true`.
   */
  routeOnPrompt?: boolean;
};

export type ResolveAndSpawnResult = {
  prompt: string;
  resolved: ResolvedRoute;
};

/** Default route returned when the backend resolver fails. */
function fallbackRoute(): ResolvedRoute {
  return {
    entry: { provider: "claude", model: null, agent: null, auto_mode: false },
    auto_resolved: false,
    matched_agent: null,
    matched_score: null,
    fallback_reason: "resolver call failed",
  };
}

/**
 * Resolve `{key}` against the prompt catalog AND the AI Router zone the
 * catalog entry points at, then invoke `spawn_session`. Returns the
 * prompt + resolved route so the caller can display useful toast info
 * ("opened with agent X via auto-mode", etc.) — but errors raised by
 * `spawn_session` itself are propagated so the caller can show a real
 * error message.
 */
export async function resolveAndSpawn(
  opts: ResolveAndSpawnOptions,
): Promise<ResolveAndSpawnResult> {
  const { key, vars = {}, cwd = null, extraFlags = {}, routeOnPrompt = true } = opts;
  const catalog = await loadCatalog();
  const entry = catalog.buttons.find((b) => b.key === key);
  if (!entry) {
    throw new Error(`unknown button prompt key: ${key}`);
  }
  // Materialise prompt with {var} substitutions.
  let prompt = entry.prompt;
  for (const [k, v] of Object.entries(vars)) {
    prompt = prompt.split(`{${k}}`).join(v);
  }
  // Resolve the zone. Empty zone (entry.zone === "") means the button
  // intentionally bypasses the AI Router — keep historical claude default.
  let resolved: ResolvedRoute = fallbackRoute();
  if (entry.zone) {
    try {
      resolved = (await invoke("resolve_zone_for_prompt", {
        zoneKey: entry.zone,
        prompt: routeOnPrompt ? prompt : entry.label,
      })) as ResolvedRoute;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[button-prompts] resolve_zone_for_prompt failed for ${key}:`, err);
    }
  }
  await invoke("spawn_session", {
    provider: resolved.entry.provider,
    prompt,
    cwd,
    flags: {
      dangerouslySkipPermissions: false,
      ...extraFlags,
      model: resolved.entry.model ?? undefined,
      agent: resolved.entry.agent ?? undefined,
    },
  });
  return { prompt, resolved };
}
