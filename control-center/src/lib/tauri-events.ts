// mar.ia — Tauri event listeners
//
// Wires the backend tray events to the React shell. Call
// `setupTrayEventListeners` once from the root component (e.g. inside
// App.tsx's first useEffect). It returns an async teardown that
// unregisters the listener — wire that into the cleanup return so React
// StrictMode double-mounts don't leak.
//
// Backend contract:
//   - "tray-action": { action: "open_chat" | "open_terminals"
//                            | "open_mosaic" | "open_memory"
//                            | "open_settings" }
//
// "open_settings" lo emite tambien el atajo global (Ctrl+Alt+M): es la forma
// de que la ventana se abra ya en Ajustes.
//
// Per-project hotkeys are a separate path: the backend emits
// "project-hotkey-custom" and App.tsx listens for it directly.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Tab keys understood by Sidebar — keep in sync with App.tsx. */
type TabKey =
  | "chat"
  | "terminals"
  | "mosaic"
  | "memory"

  | "skills"
  | "projects"
  | "mcps"
  | "settings"
  | "system";

export interface TrayActionPayload {
  action:
    | "open_chat"
    | "open_terminals"
    | "open_mosaic"
    | "open_memory"
    | "open_settings";
}

export interface TrayEventOptions {
  /** Switches the active tab. Wire this to the App's `setTab` setter. */
  setTab: (tab: TabKey) => void;
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
  const unlistenTray = await listen<TrayActionPayload>(
    "tray-action",
    (event) => {
      const action = event.payload?.action;
      switch (action) {
        case "open_chat":
          opts.setTab("chat");
          break;
        case "open_terminals":
          opts.setTab("terminals");
          break;
        case "open_mosaic":
          opts.setTab("mosaic");
          break;
        case "open_memory":
          opts.setTab("memory");
          break;
        case "open_settings":
          opts.setTab("settings");
          break;
        default:
          // Accion desconocida: se avisa para que un cambio en el menu de la
          // bandeja no se quede en un no-op silencioso.
          console.warn("[mar.ia] acción de bandeja desconocida:", action);
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
