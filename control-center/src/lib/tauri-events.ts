// ULTRON Control Center — Tauri event listeners
//
// Wires the backend tray events to the React shell. Call
// `setupTrayEventListeners` once from the root component (e.g. inside
// App.tsx's first useEffect). It returns an async teardown that
// unregisters the listener — wire that into the cleanup return so React
// StrictMode double-mounts don't leak.
//
// Backend contract:
//   - "tray-action": { action: "new_claude" | "new_codex"
//                            | "open_plans" | "open_memory" }
//
// Per-project hotkeys are a separate path: the backend emits
// "project-hotkey-custom" and App.tsx listens for it directly.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Tab keys understood by Sidebar — keep in sync with App.tsx. */
type TabKey =
  | "dashboard"
  | "skills"
  | "projects"
  | "mcps"
  | "plans"
  | "settings"
  | "system";

/** Provider keys accepted by the spawn_session backend command. */
type SessionProvider = "claude" | "codex";

export interface TrayActionPayload {
  action: "new_claude" | "new_codex" | "open_plans";
}

export interface TrayEventOptions {
  /** Switches the active tab. Wire this to the App's `setTab` setter. */
  setTab: (tab: TabKey) => void;
  /**
   * Optional override for session spawning. Defaults to invoking the
   * backend `spawn_session` command with no prompt. Pass a custom
   * implementation if the UI already has session-launch state (recent
   * prompts, default skill bindings) the tray should respect.
   */
  spawnSession?: (provider: SessionProvider) => void | Promise<void>;
}

async function defaultSpawnSession(provider: SessionProvider): Promise<void> {
  try {
    await invoke("spawn_session", { provider, prompt: null });
  } catch (err) {
    console.error("[ultron] spawn_session failed", provider, err);
  }
}

/**
 * Register the listener for tray-action events. Returns an async
 * teardown — call it from the useEffect cleanup.
 *
 * Usage:
 *   useEffect(() => {
 *     const teardownP = setupTrayEventListeners({ setTab });
 *     return () => { teardownP.then((fn) => fn()); };
 *   }, []);
 */
export async function setupTrayEventListeners(
  opts: TrayEventOptions,
): Promise<UnlistenFn> {
  const spawn = opts.spawnSession ?? defaultSpawnSession;

  const unlistenTray = await listen<TrayActionPayload>(
    "tray-action",
    (event) => {
      const action = event.payload?.action;
      switch (action) {
        case "new_claude":
          void spawn("claude");
          break;
        case "new_codex":
          void spawn("codex");
          break;
        case "open_plans":
          opts.setTab("plans");
          break;
        default:
          // Unknown action — log so future tray menu changes don't
          // silently no-op when the frontend forgets to update.
          console.warn("[ultron] unknown tray-action:", action);
      }
    },
  );

  return () => {
    try {
      unlistenTray();
    } catch (err) {
      console.warn("[ultron] tray-action unlisten threw", err);
    }
  };
}
