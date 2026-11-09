// Exportar la conversación completa (`sesiones_export`): acción común del menú
// «Exportar» de la barra superior y de `/exportar md|html` en el composer.
// El backend lee el transcript entero y abre el diálogo «Guardar como»; aquí
// solo se refleja el resultado: nota en el chat con la ruta, aviso con
// «Abrir» y «Mostrar en carpeta», y error visible si algo falla.

import { useSyncExternalStore } from "react";
import type { SesionesApi } from "./api";
import { addNote } from "./bootstrap";
import { createStore } from "./store";
import type { ExportFormat, ExportResult, SessionId } from "./types";

export const EXPORT_FORMATS: readonly { format: ExportFormat; label: string }[] = [
  { format: "md", label: "Markdown (.md)" },
  { format: "html", label: "HTML (.html)" },
];

export interface ExportState {
  /** Sesión con una exportación en curso (el diálogo puede estar abierto). */
  busy: SessionId | null;
  /** Última exportación terminada, para el aviso con «Abrir». */
  last: { sessionId: SessionId; format: ExportFormat; result: ExportResult } | null;
}

type ExportAction = (s: ExportState) => ExportState;

export const exportStore = createStore<ExportState, ExportAction>((s, fn) => fn(s), { busy: null, last: null });

export function useExport<T>(selector: (s: ExportState) => T): T {
  return useSyncExternalStore(exportStore.subscribe, () => selector(exportStore.getState()));
}

export function dismissExport(): void {
  exportStore.dispatch((s) => (s.last ? { ...s, last: null } : s));
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function formatBytes(n: number): string {
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Exporta la sesión `id`. Devuelve el resultado, o `null` si se canceló, si ya
 * había una exportación en curso o si falló (los tres casos dejan una nota).
 */
export async function exportConversation(api: SesionesApi, id: SessionId, format: ExportFormat): Promise<ExportResult | null> {
  if (exportStore.getState().busy) {
    addNote(id, "warn", "Ya hay una exportación en curso: termina o cancela el diálogo abierto.");
    return null;
  }
  exportStore.dispatch((s) => ({ ...s, busy: id }));
  try {
    const result = await api.exportConversation({ id, format });
    if (!result) {
      addNote(id, "info", "Exportación cancelada.");
      return null;
    }
    exportStore.dispatch((s) => ({ ...s, last: { sessionId: id, format, result } }));
    addNote(id, "info", `Conversación exportada (${result.messages} mensajes, ${formatBytes(result.bytes)}): ${result.path}`);
    return result;
  } catch (e) {
    addNote(id, "error", `No se pudo exportar la conversación: ${errorText(e)}`);
    return null;
  } finally {
    exportStore.dispatch((s) => ({ ...s, busy: null }));
  }
}

/** Abre o muestra en su carpeta la última exportación; el fallo va al chat. */
export async function openExported(api: SesionesApi, id: SessionId, path: string, reveal: boolean): Promise<void> {
  try {
    await api.openExport(path, reveal);
  } catch (e) {
    addNote(id, "error", `No se pudo ${reveal ? "mostrar" : "abrir"} ${path}: ${errorText(e)}`);
  }
}
