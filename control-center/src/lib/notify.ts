/**
 * notify.ts — single app-level notification entry point.
 *
 * BEFORE this file existed, frontend notification emission was split in
 * two unconnected paths:
 *
 *   1. `showToast()` (popups.ts) — renders an in-app popup at the App root
 *      (bottom-left, non-invasive). But its ONLY caller was the
 *      `ultron-toast` Tauri event listener inside PopupHost — no frontend
 *      component ever emitted a popup directly.
 *
 *   2. `record_ui_alert` (Rust command) — appends to ~/.ultron/alerts.jsonl.
 *      Used by App.tsx's global error handler, `runQuiet`, and UpdateBanner.
 *      It produces ZERO immediate feedback: the entry only surfaces after
 *      the Notifications tab's 15 s poll, and never pops a toast.
 *
 * Net effect: a palette command failing, or a JS exception, was recorded
 * to disk but completely invisible until the user happened to wander to
 * the Notifications tab. Meanwhile the perfectly good popup surface sat
 * unused by the frontend.
 *
 * `notify()` unifies the two: it shows the popup immediately (app-level,
 * any tab) AND persists to alerts.jsonl so the Notifications tab keeps a
 * durable record. One call, both surfaces, consistent behaviour.
 *
 * This is purely additive — `showToast`/`showConfirm` and `record_ui_alert`
 * are untouched. Components that only need transient, local form feedback
 * (inline "Saved ✓" next to a button) keep their local state; `notify()`
 * is for events worth surfacing app-wide.
 */
import { invoke } from "@tauri-apps/api/core";
import { showToast, type Severity } from "./popups";

export interface NotifyInput {
    /** Human-readable message. */
    message: string;
    /** Short source tag (e.g. "palette", "ui.error"). Rendered uppercase. */
    source?: string;
    /** Severity tint. Defaults to "info". */
    severity?: Severity;
    /**
     * Persist to alerts.jsonl so the Notifications tab keeps a record.
     * Default true. Set false for ephemeral chatter not worth a durable
     * row (e.g. "copied to clipboard").
     */
    persist?: boolean;
    /** Popup auto-dismiss in ms (default 6000, 0 = sticky). */
    ttlMs?: number;
}

/**
 * Emit an app-level notification. Shows an immediate in-app popup and,
 * unless `persist` is false, records it to alerts.jsonl via the existing
 * `record_ui_alert` command so it also appears in the Notifications tab.
 *
 * Fire-and-forget: the disk write is best-effort and never throws.
 */
export function notify(input: NotifyInput): void {
    const severity: Severity = input.severity ?? "info";

    // 1. Immediate, app-level visual feedback (any tab).
    showToast({
        message: input.message,
        source: input.source,
        severity,
        ttlMs: input.ttlMs,
    });

    // 2. Durable record in the Notifications tab. The Rust command maps
    //    severity, caps lengths and strips CR/LF; we just hand it the raw
    //    values. Best-effort — a backend miss must not break the caller.
    if (input.persist !== false) {
        void invoke("record_ui_alert", {
            severity,
            source: input.source ?? "ui",
            message: input.message,
        }).catch(() => {
            /* swallow — the popup already gave the user feedback */
        });
    }
}

/** Convenience wrapper: info-severity notification. */
export function notifyInfo(message: string, source?: string): void {
    notify({ message, source, severity: "info" });
}

/** Convenience wrapper: warn-severity notification. */
export function notifyWarn(message: string, source?: string): void {
    notify({ message, source, severity: "warn" });
}

/** Convenience wrapper: critical-severity notification. */
export function notifyError(message: string, source?: string): void {
    notify({ message, source, severity: "critical" });
}
