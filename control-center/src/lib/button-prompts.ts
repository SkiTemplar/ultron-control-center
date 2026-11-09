// Control Center — Button prompts client helper
//
// Mirrors the Rust catalog in `src-tauri/src/button_prompts.rs`. Components
// that spawn AI sessions go through `getPrompt(key, vars)` so the catalog
// (and any user override stored on disk) becomes the single source of truth
// without having to recompile when prompts change.

// No React runtime imports needed — useRoutingTitle is a pure function stub.
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

// Sin caché entre llamadas: `getPrompt` corre al pulsar un botón, el IPC cuesta
// milisegundos y una caché por ventana ignoraba las ediciones de Settings hasta
// reiniciar. Solo se comparte la lectura en curso.
let inflight: Promise<ButtonPromptsCatalog> | null = null;

async function loadCatalog(): Promise<ButtonPromptsCatalog> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      return (await invoke("list_button_prompts")) as ButtonPromptsCatalog;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function renderPrompt(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{${k}}`).join(v);
  }
  return out;
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
  return renderPrompt(entry.prompt, vars);
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
  /** Deprecated. Kept for back-compat at call sites. */
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
 * Always spawns `claude` with provider defaults (no AI router).
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
  const prompt = renderPrompt(entry.prompt, vars);
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
 * Back-compat stub: returns `baseTitle` unchanged.
 *
 * Originally appended an AI Router routing hint to button titles; the router
 * was removed in v2.9.2. All call sites (Plans, Notifications, MCPs) still
 * import this so they compile without changes — the return value is identical
 * to `baseTitle` in every case.
 *
 * Do NOT add React state or side-effects here. This must remain a pure
 * synchronous function so callers don't need to change their render logic.
 */
export function useRoutingTitle(_key: string, baseTitle = ""): string {
  return baseTitle;
}
