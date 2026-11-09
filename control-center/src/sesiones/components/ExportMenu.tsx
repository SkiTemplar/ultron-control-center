// Menú «Exportar» de la barra superior: conversación completa de la sesión
// enfocada a Markdown o HTML (`sesiones_export`). Tras guardar, un aviso con la
// ruta y los botones «Abrir» y «Mostrar en carpeta»; los fallos van al chat
// como nota de error (ver `export.ts`).

import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "../context";
import { dismissExport, EXPORT_FORMATS, exportConversation, openExported, useExport } from "../export";
import type { ExportFormat, SessionId } from "../types";
import { IconChevronDown, IconClose, IconFile } from "./icons";
import "../styles/exportar.css";

function useCloseOnOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

export function ExportMenu({ sessionId }: { sessionId: SessionId }) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useCloseOnOutside(open, close);
  const busy = useExport((s) => s.busy !== null);
  const last = useExport((s) => (s.last?.sessionId === sessionId ? s.last : null));

  function run(format: ExportFormat) {
    setOpen(false);
    void exportConversation(api, sessionId, format);
  }

  return (
    <div className="xport" ref={ref}>
      <button className="tbtn" aria-haspopup="menu" aria-expanded={open} disabled={busy} onClick={() => setOpen((o) => !o)}
        title="Exporta la conversación completa a Markdown o HTML">
        <IconFile /> {busy ? "Exportando…" : "Exportar"} <IconChevronDown />
      </button>
      {open && (
        <div className="xport-pop" role="menu" aria-label="Exportar conversación">
          {EXPORT_FORMATS.map((f) => (
            <button key={f.format} role="menuitem" className="xport-item" onClick={() => run(f.format)}>{f.label}</button>
          ))}
        </div>
      )}
      {last && !open && (
        <div className="xport-pop xport-done" role="status" aria-label="Conversación exportada">
          <div className="xport-head">
            <b>Conversación exportada</b>
            <button className="xport-x" aria-label="Cerrar aviso" onClick={dismissExport}><IconClose /></button>
          </div>
          <code className="xport-path" title={last.result.path}>{last.result.path}</code>
          <div className="xport-actions">
            <button className="tbtn" onClick={() => void openExported(api, sessionId, last.result.path, false)}>Abrir</button>
            <button className="tbtn" onClick={() => void openExported(api, sessionId, last.result.path, true)}>Mostrar en carpeta</button>
          </div>
        </div>
      )}
    </div>
  );
}
