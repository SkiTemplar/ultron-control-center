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

/**
 * Render a prompt template against its vars (no I/O). Useful for previewing
 * what would be sent without touching the backend. Returns the template as-is
 * with missing vars left in `{placeholder}` form.
 */
export function renderButtonPrompt(
  entry: ButtonPrompt,
  vars: Record<string, string> = {},
): string {
  return renderPrompt(entry.prompt, vars);
}

/**
 * Copy a rendered prompt to the system clipboard. Uses `navigator.clipboard`,
 * which is the convention already used elsewhere in the Control Center
 * (InboxModal, PluginsSection, CodexFallbackButton).
 *
 * Throws if the browser denies clipboard access (e.g. when the WebView is
 * focusless). Callers should surface the error to the user.
 */
export async function copyButtonPromptToClipboard(
  entry: ButtonPrompt,
  vars: Record<string, string> = {},
): Promise<string> {
  const rendered = renderButtonPrompt(entry, vars);
  if (!navigator.clipboard || !navigator.clipboard.writeText) {
    throw new Error("Clipboard API not available in this WebView.");
  }
  await navigator.clipboard.writeText(rendered);
  return rendered;
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
