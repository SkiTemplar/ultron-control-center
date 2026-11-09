/**
 * PopupHost — in-app popup system for ULTRON Control Center.
 *
 * Renders a vertical stack of toasts and confirm prompts in the bottom-left
 * corner of the content column (App.tsx mounts it inside that column, so the
 * stack never covers the sidebar). Replaces:
 *   - Windows-native notifications (toast_emit.rs sent OS toasts).
 *   - Central modal confirmDialog (Tauri plugin:dialog|confirm).
 *
 * All popups are non-invasive: they slide in over content without blocking
 * input, auto-dismiss (toasts; paused while hovered, × closes them) or wait
 * for inline button click (confirms).
 *
 * Subscribes to Tauri event `ultron-toast` and to in-process popup queue.
 * Mounted ONCE at the App root.
 */
import { useEffect, useState } from "react";
import { dismissToast, pauseToast, resumeToast, subscribeQueue, type Popup } from "../lib/popups";

const IN_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function PopupHost() {
    const [items, setItems] = useState<Popup[]>([]);

    useEffect(() => {
        const unsub = subscribeQueue(setItems);
        return unsub;
    }, []);

    useEffect(() => {
        // listen() resolves asynchronously: if the effect is cleaned up first
        // (StrictMode mounts twice), the late listener is dropped on arrival.
        // Without this every ultron-toast rendered two cards.
        let cancelled = false;
        let unlisten: (() => void) | undefined;
        if (IN_TAURI) {
            import("@tauri-apps/api/event")
                .then(({ listen }) =>
                    listen<{ source: string; severity?: string; message: string }>(
                        "ultron-toast",
                        (event) => {
                            import("../lib/popups").then(({ showToast }) =>
                                showToast({
                                    source: event.payload.source,
                                    message: event.payload.message,
                                    severity: (event.payload.severity ?? "info") as
                                        | "info" | "warn" | "critical" | "blocking",
                                })
                            );
                        }
                    )
                )
                .then((u) => {
                    if (cancelled) u();
                    else unlisten = u;
                })
                .catch(() => { /* listen unavailable — best effort */ });
        }
        return () => {
            cancelled = true;
            if (unlisten) unlisten();
        };
    }, []);

    if (items.length === 0) return null;

    return (
        <div
            style={{
                position: "absolute",
                bottom: "1rem",
                left: "1rem",
                display: "flex",
                flexDirection: "column-reverse",
                gap: "0.5rem",
                zIndex: 10_000,
                maxWidth: "min(420px, calc(100% - 2rem))",
                pointerEvents: "none",
            }}
        >
            {items.map((p) => (
                <PopupCard key={p.id} popup={p} />
            ))}
        </div>
    );
}

function PopupCard({ popup }: { popup: Popup }) {
    const accent = severityAccent(popup.severity ?? "info");
    const isToast = popup.kind === "toast";
    return (
        <div
            role={popup.kind === "confirm" ? "alertdialog" : "status"}
            aria-live={isToast ? "polite" : "assertive"}
            onMouseEnter={isToast ? () => pauseToast(popup.id) : undefined}
            onMouseLeave={isToast ? () => resumeToast(popup.id) : undefined}
            style={{
                position: "relative",
                background: "var(--color-surface-2)",
                border: `1px solid ${accent}`,
                borderLeft: `3px solid ${accent}`,
                borderRadius: 6,
                padding: isToast ? "0.65rem 2rem 0.65rem 0.85rem" : "0.65rem 0.85rem",
                color: "var(--color-text)",
                fontFamily: "var(--font-sans)",
                fontSize: "0.85rem",
                lineHeight: 1.4,
                pointerEvents: "auto",
                boxShadow: "0 6px 16px rgba(0,0,0,0.4)",
                animation: "ultron-popup-in 220ms ease-out",
            }}
        >
            {popup.source && (
                <div style={{ color: accent, fontSize: "0.72rem", fontWeight: 600, marginBottom: 2, letterSpacing: 0.4 }}>
                    {popup.source.toUpperCase()}
                </div>
            )}
            <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{popup.message}</div>
            {isToast && (
                <button
                    type="button"
                    onClick={() => dismissToast(popup.id)}
                    aria-label="Cerrar"
                    title="Cerrar"
                    style={{
                        position: "absolute",
                        top: "0.35rem",
                        right: "0.35rem",
                        width: "1.4rem",
                        height: "1.4rem",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        background: "transparent",
                        color: "var(--color-text-tertiary)",
                        border: "none",
                        borderRadius: 4,
                        fontSize: "1rem",
                        lineHeight: 1,
                        cursor: "pointer",
                    }}
                >
                    ×
                </button>
            )}
            {popup.kind === "confirm" && (
                <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.6rem", justifyContent: "flex-end" }}>
                    <button
                        type="button"
                        onClick={() => popup.resolve!(false)}
                        style={btnStyle("var(--color-surface-3)", "var(--color-text-secondary)")}
                    >
                        {popup.cancelLabel ?? "Cancelar"}
                    </button>
                    <button
                        type="button"
                        onClick={() => popup.resolve!(true)}
                        style={btnStyle(accent, "var(--color-bg)")}
                    >
                        {popup.okLabel ?? "Confirmar"}
                    </button>
                </div>
            )}
        </div>
    );
}

function btnStyle(bg: string, color: string): React.CSSProperties {
    return {
        background: bg,
        color,
        border: "none",
        borderRadius: 4,
        padding: "0.35rem 0.75rem",
        fontFamily: "inherit",
        fontSize: "0.8rem",
        fontWeight: 600,
        cursor: "pointer",
    };
}

function severityAccent(s: string): string {
    switch (s) {
        case "blocking":
        case "critical": return "var(--color-danger)";
        case "warn":     return "var(--color-warn)";
        default:         return "var(--color-text-secondary)";
    }
}
