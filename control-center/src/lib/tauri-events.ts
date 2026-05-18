// ULTRON Control Center — Tauri event listeners
//
// Wires the backend tray + per-project hotkey events to the React
// shell. Call `setupTrayEventListeners` once from the root component
// (e.g. inside App.tsx's first useEffect). It returns an async
// teardown that unregisters every listener — wire that into the
// cleanup return so React StrictMode double-mounts don't leak.
//
// Backend contracts:
//   - "tray-action": { action: "new_claude" | "new_codex" | "new_gemini"
//                            | "open_plans" | "open_memory" }
//   - "project-hotkey": { index: 1..9 }

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Tab keys understood by Sidebar — keep in sync with App.tsx. */
type TabKey =
  | "dashboard"
  | "skills"
  | "projects"
  | "mcps"
  | "memory"
  | "plans"
  | "settings"
  | "news"
  | "system";

/** Provider keys accepted by the spawn_session backend command. */
type SessionProvider = "claude" | "codex" | "gemini";

export interface TrayActionPayload {
  action:
    | "new_claude"
    | "new_codex"
    | "new_gemini"
    | "open_plans"
    | "open_memory";
}

export interface ProjectHotkeyPayload {
  index: number;
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
  /**
   * Optional override for opening a project. Defaults to invoking
   * `open_project` directly. Override if the UI tracks recent
   * projects or shows a confirmation toast.
   */
  openProject?: (id: string) => void | Promise<void>;
}

async function defaultSpawnSession(provider: SessionProvider): Promise<void> {
  try {
    await invoke("spawn_session", { provider, prompt: null });
  } catch (err) {
    console.error("[ultron] spawn_session failed", provider, err);
  }
}

async function defaultOpenProject(id: string): Promise<void> {
  try {
    await invoke("open_project", { id });
  } catch (err) {
    console.error("[ultron] open_project failed", id, err);
  }
}

/**
 * Register listeners for tray-action and project-hotkey events.
 * Returns an async teardown — call it from the useEffect cleanup.
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
  const openProj = opts.openProject ?? defaultOpenProject;

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
        case "new_gemini":
          void spawn("gemini");
          break;
        case "open_plans":
          opts.setTab("plans");
          break;
        case "open_memory":
          opts.setTab("memory");
          break;
        default:
          // Unknown action — log so future tray menu changes don't
          // silently no-op when the frontend forgets to update.
          console.warn("[ultron] unknown tray-action:", action);
      }
    },
  );

  const unlistenHotkey = await listen<ProjectHotkeyPayload>(
    "project-hotkey",
    async (event) => {
      const slot = event.payload?.index;
      if (typeof slot !== "number" || slot < 1 || slot > 9) {
        console.warn("[ultron] invalid project-hotkey index:", slot);
        return;
      }
      // Resolve slot -> project id on the backend so the pinned/
      // fallback logic stays in one place (Rust). Re-reading on each
      // press means user reorderings of `projects.json` take effect
      // immediately without restarting.
      try {
        const id = (await invoke("project_at_slot", { slot })) as
          | string
          | null;
        if (!id) {
          console.warn("[ultron] no project at slot", slot);
          return;
        }
        await openProj(id);
      } catch (err) {
        console.error("[ultron] project-hotkey dispatch failed", err);
      }
    },
  );

  // Combined teardown — call once to remove BOTH listeners. Tauri's
  // listen() returns a fn; we wrap so the consumer only tracks one.
  return () => {
    try {
      unlistenTray();
    } catch (err) {
      console.warn("[ultron] tray-action unlisten threw", err);
    }
    try {
      unlistenHotkey();
    } catch (err) {
      console.warn("[ultron] project-hotkey unlisten threw", err);
    }
  };
}
