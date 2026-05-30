// ULTRON Control Center — Vista de triage del Inbox
//
// Consume `list_inbox` (command registrado en lib.rs) y muestra las capturas
// almacenadas en ~/.ultron/cockpit/inbox.jsonl para revisión.
//
// Comandos de mutación disponibles en el backend:
//   - append_inbox (solo escritura)
//   - list_inbox   (lectura — este componente lo usa)
//
// NO existen comandos delete_inbox / mark_inbox_read en el backend actual.
// El triage avanzado (marcar procesada, convertir a card kanban, borrar)
// queda pendiente de backend. Por ahora se lista todo y se ofrece
// "Copiar al portapapeles" como única acción de triage disponible.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

interface InboxEntry {
  ts: string;
  text: string;
  source: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTs(ts: string): string {
  // El backend guarda ISO-8601 UTC: "2026-05-30T14:32:11Z"
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return ts;
    return d.toLocaleString("es-ES", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return ts;
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // portapapeles bloqueado en algunos contextos webview
  }
  return false;
}

// ---------------------------------------------------------------------------
// Componente principal
// ---------------------------------------------------------------------------

interface InboxTriageProps {
  /** Si es true, el componente se muestra como panel flotante modal. */
  asModal?: boolean;
  onClose?: () => void;
}

export function InboxTriage({ asModal = false, onClose }: InboxTriageProps) {
  const [entries, setEntries] = useState<InboxEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);

  // -------------------------------------------------------------------------
  // Carga de datos
  // -------------------------------------------------------------------------

  const loadEntries = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await invoke<InboxEntry[]>("list_inbox", { limit: 200 });
      setEntries(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadEntries();
  }, []);

  // Esc cierra si es modal.
  useEffect(() => {
    if (!asModal || !onClose) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); onClose!(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [asModal, onClose]);

  // -------------------------------------------------------------------------
  // Acciones
  // -------------------------------------------------------------------------

  const handleCopy = async (idx: number, text: string) => {
    const ok = await copyText(text);
    if (ok) {
      setCopied(idx);
      setTimeout(() => setCopied((prev) => (prev === idx ? null : prev)), 1800);
    }
  };

  // -------------------------------------------------------------------------
  // Render interno
  // -------------------------------------------------------------------------

  const content = (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        fontFamily: "var(--font-sans)",
        color: "var(--color-text)",
      }}
    >
      {/* Cabecera */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "16px 20px 12px",
          borderBottom: "1px solid var(--color-border)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>Bandeja de entrada</span>
          {!loading && (
            <span style={{ fontSize: 11.5, color: "var(--color-text-tertiary)" }}>
              {entries.length} {entries.length === 1 ? "captura" : "capturas"} ·{" "}
              <span style={{ fontFamily: "var(--font-mono)" }}>~/.ultron/cockpit/inbox.jsonl</span>
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            type="button"
            onClick={loadEntries}
            disabled={loading}
            style={{
              fontSize: 11.5,
              padding: "3px 10px",
              background: "var(--color-surface-3)",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border-strong)",
              borderRadius: 4,
              cursor: loading ? "default" : "pointer",
              opacity: loading ? 0.6 : 1,
            }}
          >
            {loading ? "Cargando…" : "Actualizar"}
          </button>
          {asModal && onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Cerrar"
              style={{
                fontSize: 18, lineHeight: 1,
                background: "transparent", border: "none",
                color: "var(--color-text-tertiary)", cursor: "pointer",
                padding: "0 4px",
              }}
            >
              ×
            </button>
          )}
        </div>
      </div>

      {/* Aviso de triage parcial */}
      <div
        style={{
          padding: "8px 20px",
          fontSize: 11,
          color: "var(--color-text-faint)",
          background: "rgba(125,133,144,0.06)",
          borderBottom: "1px solid var(--color-border)",
          flexShrink: 0,
        }}
      >
        Triage avanzado (marcar procesada, convertir a card, borrar) pendiente de backend.
        Por ahora puedes copiar el texto al portapapeles para procesarlo manualmente.
      </div>

      {/* Error */}
      {error && (
        <div
          style={{
            margin: "12px 20px 0",
            padding: "8px 12px",
            fontSize: 12,
            background: "rgba(248,81,73,0.08)",
            border: "1px solid rgba(248,81,73,0.30)",
            color: "var(--color-danger)",
            borderRadius: 4,
            flexShrink: 0,
          }}
        >
          {error}
        </div>
      )}

      {/* Lista */}
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 20px" }}>
        {loading && entries.length === 0 && (
          <p style={{ fontSize: 12, color: "var(--color-text-tertiary)", marginTop: 20, textAlign: "center" }}>
            Cargando capturas…
          </p>
        )}

        {!loading && entries.length === 0 && !error && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              paddingTop: 40,
              textAlign: "center",
            }}
          >
            <p style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
              La bandeja está vacía.
            </p>
            <p style={{ fontSize: 11.5, color: "var(--color-text-faint)" }}>
              Usa <kbd style={{ background: "var(--color-surface-3)", padding: "1px 5px", borderRadius: 3, fontSize: 11 }}>Ctrl+Alt+I</kbd> para capturar pensamientos al vuelo.
            </p>
          </div>
        )}

        {entries.length > 0 && (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            {entries.map((entry, idx) => (
              <li
                key={`${entry.ts}-${idx}`}
                style={{
                  display: "flex",
                  gap: 10,
                  padding: "10px 12px",
                  background: "var(--color-surface-2)",
                  border: "1px solid var(--color-border-strong)",
                  borderRadius: 6,
                  alignItems: "flex-start",
                }}
              >
                {/* Timestamp + fuente */}
                <div
                  style={{
                    flexShrink: 0,
                    width: 110,
                    paddingTop: 1,
                  }}
                >
                  <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", lineHeight: 1.4 }}>
                    {formatTs(entry.ts)}
                  </div>
                  <div
                    style={{
                      fontSize: 9.5,
                      color: "var(--color-text-faint)",
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                      marginTop: 2,
                    }}
                  >
                    {entry.source}
                  </div>
                </div>

                {/* Texto de la captura */}
                <div
                  style={{
                    flex: 1,
                    fontSize: 12.5,
                    fontFamily: "var(--font-mono)",
                    color: "var(--color-text)",
                    lineHeight: 1.55,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    minWidth: 0,
                  }}
                >
                  {entry.text}
                </div>

                {/* Acción: copiar */}
                <button
                  type="button"
                  onClick={() => void handleCopy(idx, entry.text)}
                  title="Copiar al portapapeles"
                  style={{
                    flexShrink: 0,
                    padding: "3px 8px",
                    fontSize: 11,
                    background: copied === idx ? "rgba(63,185,80,0.14)" : "var(--color-surface-3)",
                    color: copied === idx ? "var(--color-success)" : "var(--color-text-secondary)",
                    border: `1px solid ${copied === idx ? "rgba(63,185,80,0.40)" : "var(--color-border-strong)"}`,
                    borderRadius: 4,
                    cursor: "pointer",
                    alignSelf: "flex-start",
                    transition: "background 0.2s, color 0.2s",
                  }}
                >
                  {copied === idx ? "Copiado" : "Copiar"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );

  // -------------------------------------------------------------------------
  // Envuelve en overlay si es modal
  // -------------------------------------------------------------------------

  if (!asModal) return content;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Bandeja de entrada"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9998,
      }}
      onClick={(e) => { if (e.target === e.currentTarget && onClose) onClose(); }}
    >
      <div
        style={{
          width: "min(52rem, 96vw)",
          maxHeight: "85vh",
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border-strong)",
          borderRadius: 8,
          boxShadow: "0 16px 48px rgba(0,0,0,0.65)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {content}
      </div>
    </div>
  );
}
