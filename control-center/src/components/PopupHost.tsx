/**
 * PopupHost — in-app popup system for ULTRON Control Center.
 *
 * Renders a vertical stack of toasts and confirm prompts in the bottom-left
 * corner. Replaces:
 *   - Windows-native notifications (toast_emit.rs sent OS toasts).
 *   - Central modal confirmDialog (Tauri plugin:dialog|confirm).
 *
 * All popups are non-invasive: they slide in over content without blocking
 * input, auto-dismiss (toasts) or wait for inline button click (confirms).
 *
 * Subscribes to Tauri event `ultron-toast` and to in-process popup queue.
 * Mounted ONCE at the App root.
 */
import { useEffect, useState } from "react";
import { subscribeQueue, type Popup } from "../lib/popups";

const IN_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function PopupHost() {
    const [items, setItems] = useState<Popup[]>([]);

    useEffect(() => {
        const unsub = subscribeQueue(setItems);
        return unsub;
    }, []);

    useEffect(() => {
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
                .then((u) => { unlisten = u; })
                .catch(() => { /* listen unavailable — best effort */ });
        }
        return () => { if (unlisten) unlisten(); };
    }, []);

    if (items.length === 0) return null;

    return (
        <div
            style={{
                position: "fixed",
                bottom: "1rem",
                left: "1rem",
                display: "flex",
                flexDirection: "column-reverse",
                gap: "0.5rem",
                zIndex: 10_000,
                maxWidth: "min(420px, calc(100vw - 2rem))",
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
    return (
        <div
            role={popup.kind === "confirm" ? "alertdialog" : "status"}
            aria-live={popup.kind === "toast" ? "polite" : "assertive"}
            style={{
                background: "#131313",
                border: `1px solid ${accent}`,
                borderLeft: `3px solid ${accent}`,
                borderRadius: 6,
                padding: "0.65rem 0.85rem",
                color: "#e8e8e8",
                fontFamily: "Inter, Segoe UI, sans-serif",
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
            {popup.kind === "confirm" && (
                <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.6rem", justifyContent: "flex-end" }}>
                    <button
                        type="button"
                        onClick={() => popup.resolve!(false)}
                        style={btnStyle("#2a2a2a", "#bbb")}
                    >
                        {popup.cancelLabel ?? "Cancel"}
                    </button>
                    <button
                        type="button"
                        onClick={() => popup.resolve!(true)}
                        style={btnStyle(accent, "#0a0a0a")}
                    >
                        {popup.okLabel ?? "Confirm"}
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
        case "blocking": return "#ff5050";
        case "critical": return "#ff8c42";
        case "warn":     return "#f0c020";
        case "info":     return "#3a9dff";
        default:         return "#3a9dff";
    }
}
