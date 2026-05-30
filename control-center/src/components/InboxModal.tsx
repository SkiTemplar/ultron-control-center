import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { InboxTriage } from "./InboxTriage";

// Quick capture inbox overlay. Triggered by the Tauri event "open-inbox"
// (emitted by the global Ctrl+Alt+I hotkey in src-tauri/src/hotkeys.rs).
// Submitted notes are appended to ~/.ultron/cockpit/inbox.jsonl for
// later triage. Esc closes; Cancel returns text to clipboard so a
// half-typed thought is never lost.
//
// FIX (2026-05-30): Botón "Ver bandeja" abre InboxTriage modal para revisar
// las capturas guardadas (list_inbox) sin salir del flujo de captura rápida.

const MAX_LEN = 4000;

export function InboxModal() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [triageOpen, setTriageOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Subscribe to the open-inbox event once.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen("open-inbox", () => {
      setOpen(true);
      setText("");
      setSaved(false);
      setError(null);
    })
      .then((u) => {
        unlisten = u;
      })
      .catch(() => {
        // Listening failed — likely Tauri context unavailable.
        // We swallow because the modal is purely a quick-capture
        // convenience; the rest of the app should keep working.
      });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Autofocus the textarea when opening.
  useEffect(() => {
    if (open) {
      // Give the modal a tick to mount before focusing.
      const t = setTimeout(() => textareaRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Esc closes (after auto-saving any text to clipboard so it's not lost).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        handleCancel();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        handleSubmit();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, text, busy]);

  async function copyToClipboard(s: string) {
    if (!s) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(s);
      }
    } catch {
      // Clipboard may be blocked in some webview contexts; we silently
      // skip — the user can still re-type from memory.
    }
  }

  async function handleSubmit() {
    if (busy) return;
    const t = text.trim();
    if (t.length === 0) return;
    if (t.length > MAX_LEN) {
      setError(`Note too long (${t.length} chars, max ${MAX_LEN})`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await invoke("append_inbox", { text: t });
      setSaved(true);
      // Auto-close after a brief "Saved" flash.
      setTimeout(() => {
        setOpen(false);
        setText("");
        setSaved(false);
      }, 1000);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    if (text.trim().length > 0) {
      await copyToClipboard(text);
    }
    setOpen(false);
    setText("");
    setSaved(false);
    setError(null);
  }

  const charCount = text.length;
  const overLimit = charCount > MAX_LEN;

  return (
    <>
      {/* Vista de triage: se puede abrir con o sin el modal de captura abierto */}
      {triageOpen && (
        <InboxTriage asModal onClose={() => setTriageOpen(false)} />
      )}

      {/* Modal de captura rápida */}
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Quick capture"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
          }}
          onClick={(e) => {
            // Click on backdrop = cancel
            if (e.target === e.currentTarget) handleCancel();
          }}
        >
          <div
            style={{
              width: "min(28rem, 92vw)",
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border-strong)",
              borderRadius: 6,
              boxShadow: "0 12px 36px rgba(0, 0, 0, 0.6)",
              padding: 16,
              fontFamily: "var(--font-sans)",
              color: "var(--color-text)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                marginBottom: 10,
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 500 }}>Quick capture</div>
              <div
                style={{
                  fontSize: 10.5,
                  color: "var(--color-text-tertiary)",
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                }}
              >
                Ctrl+Alt+I
              </div>
            </div>

            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={busy || saved}
              placeholder="Drop a thought. Saved to ~/.ultron/cockpit/inbox.jsonl for later triage."
              rows={5}
              style={{
                width: "100%",
                resize: "vertical",
                background: "var(--color-surface-1)",
                color: "var(--color-text)",
                border: `1px solid ${
                  overLimit ? "var(--color-danger)" : "var(--color-border)"
                }`,
                borderRadius: 4,
                padding: 8,
                fontSize: 12.5,
                fontFamily: "var(--font-mono)",
                lineHeight: 1.5,
                outline: "none",
              }}
            />

            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginTop: 10,
              }}
            >
              <div
                style={{
                  fontSize: 10.5,
                  color: overLimit
                    ? "var(--color-danger)"
                    : "var(--color-text-tertiary)",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {charCount} / {MAX_LEN}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={busy}
                  style={{
                    fontSize: 11.5,
                    padding: "4px 10px",
                    background: "var(--color-surface-3)",
                    color: "var(--color-text-secondary)",
                    border: "1px solid var(--color-border-strong)",
                    borderRadius: 4,
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={busy || saved || overLimit || text.trim().length === 0}
                  style={{
                    fontSize: 11.5,
                    padding: "4px 10px",
                    background: saved
                      ? "rgba(63, 185, 80, 0.16)"
                      : "var(--color-accent)",
                    color: saved
                      ? "var(--color-success)"
                      : "var(--color-accent-text)",
                    border: `1px solid ${
                      saved ? "rgba(63, 185, 80, 0.40)" : "var(--color-accent)"
                    }`,
                    borderRadius: 4,
                    cursor: busy || saved ? "default" : "pointer",
                    fontWeight: 500,
                    opacity:
                      busy || overLimit || text.trim().length === 0 ? 0.55 : 1,
                  }}
                >
                  {saved ? "Saved" : busy ? "Saving..." : "Save"}
                </button>
              </div>
            </div>

            {error && (
              <div
                style={{
                  marginTop: 10,
                  padding: 8,
                  fontSize: 11,
                  background: "rgba(248, 81, 73, 0.08)",
                  border: "1px solid rgba(248, 81, 73, 0.30)",
                  color: "var(--color-danger)",
                  borderRadius: 4,
                }}
              >
                {error}
              </div>
            )}

            <div
              style={{
                marginTop: 10,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <div style={{ fontSize: 10.5, color: "var(--color-text-faint)" }}>
                Ctrl+Enter para guardar. Esc cancela (texto copiado al portapapeles).
              </div>
              <button
                type="button"
                onClick={() => setTriageOpen(true)}
                style={{
                  fontSize: 10.5,
                  padding: "2px 8px",
                  background: "transparent",
                  color: "var(--color-text-secondary)",
                  border: "1px solid var(--color-border-strong)",
                  borderRadius: 4,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                Ver bandeja
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// Re-exportar InboxTriage para que otros módulos (App.tsx) puedan
// abrirlo directamente sin necesidad de pasar por el modal de captura.
export { InboxTriage };
