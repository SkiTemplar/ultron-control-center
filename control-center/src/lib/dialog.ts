/**
 * Confirm dialogs — routed to the in-app PopupHost (bottom-left), NOT a
 * central modal.
 *
 * v15.5.20: Central modal confirms (Tauri `plugin:dialog|confirm`) were
 * removed per user directive — they jumped to the middle of the screen
 * and felt invasive. The new flow uses `showConfirm` from `popups.ts`,
 * which renders an inline popup card in the bottom-left corner with
 * [Cancel] [Confirm] buttons. Same `Promise<boolean>` contract, so call
 * sites do not change.
 */
import { showConfirm } from "./popups";

export interface ConfirmOptions {
    /** Source label rendered as a small uppercase tag at the top of the card. */
    title?: string;
    /** Severity tint — defaults to "warn". */
    kind?: "info" | "warning" | "error";
    /** Custom label for the OK button (default "Confirm"). */
    okLabel?: string;
    /** Custom label for the Cancel button (default "Cancel"). */
    cancelLabel?: string;
}

function mapKind(k?: ConfirmOptions["kind"]): "info" | "warn" | "critical" {
    if (k === "error") return "critical";
    if (k === "info") return "info";
    return "warn";
}

/**
 * Show an inline confirm popup (bottom-left). Resolves true if the user
 * clicked OK, false otherwise. Use this instead of `window.confirm()` or
 * any native modal — never blocks the UI thread.
 */
export async function confirmDialog(
    message: string,
    options: ConfirmOptions = {}
): Promise<boolean> {
    return showConfirm({
        message,
        source: options.title,
        severity: mapKind(options.kind),
        okLabel: options.okLabel,
        cancelLabel: options.cancelLabel,
    });
}
