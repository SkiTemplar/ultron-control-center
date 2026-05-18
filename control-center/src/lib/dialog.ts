/**
 * Dialog wrappers using @tauri-apps/plugin-dialog instead of native `window.confirm`.
 *
 * v15.5.16 (internal-review-note root cause): In Tauri 2 + WebView2, native `window.confirm`
 * gets routed through the `plugin:dialog|confirm` ACL check at runtime even
 * though `capabilities/default.json` permits it. The interception fails with
 * `"Command plugin:dialog|confirm not allowed by ACL"` and destructive flows
 * (Clear all notifications, Empty Recycle Bin, Close Control Center, uninstall,
 * Delete scheduled task, etc.) silently no-op.
 *
 * The fix is to call the plugin explicitly. `@tauri-apps/plugin-dialog`'s
 * `confirm()` returns a Promise<boolean> — async signature, drop-in replacement
 * for the few call sites that were already inside async handlers.
 *
 * For dev / browser preview (no Tauri runtime), we fall back to native
 * `window.confirm` so the React tree still works under `vite dev`.
 */
import { confirm as tauriConfirm } from "@tauri-apps/plugin-dialog";

const IN_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface ConfirmOptions {
    /** Window title (Tauri only — `window.confirm` ignores it). */
    title?: string;
    /** "warning" | "error" | "info" — Tauri only. */
    kind?: "info" | "warning" | "error";
    /** Custom label for the OK button (Tauri only). */
    okLabel?: string;
    /** Custom label for the Cancel button (Tauri only). */
    cancelLabel?: string;
}

/**
 * Show a confirm dialog. Resolves to true if the user clicked OK, false otherwise.
 *
 * Use this instead of `window.confirm()` — see file header for the why.
 */
export async function confirmDialog(
    message: string,
    options: ConfirmOptions = {}
): Promise<boolean> {
    if (IN_TAURI) {
        try {
            return await tauriConfirm(message, options);
        } catch (err) {
            // Plugin failed (very unusual — ACL, network, etc.) — fall through
            // to native confirm so the user is still able to answer rather than
            // silently no-op'ing.
            console.warn("[confirmDialog] tauri plugin failed; falling back to window.confirm", err);
            return window.confirm(message);
        }
    }
    return window.confirm(message);
}
