// Registro de incidentes (fiabilidad de Sessions): cada aviso `warn`/`error`
// del chat, cada error global de la ventana y cada atasco nuevo se manda al
// backend (`sesiones_incident`), que lo guarda con la pantalla de la TUI y el
// estado de la máquina en ese instante (src-tauri/src/sesiones/incidentes.rs).
// Varias ventanas informan del mismo aviso: el backend descarta la repetición.

import { store } from "./store";
import type { NoticeLevel, SessionId, SessionInfo } from "./types";

export type IncidentOrigin = "note" | "stall" | "error";

export interface IncidentReport {
  id: SessionId | null;
  origin: IncidentOrigin;
  level: Exclude<NoticeLevel, "info">;
  text: string;
}

type Sink = (report: IncidentReport) => Promise<void>;

let sink: Sink | null = null;
let failureNoted = false;

/** Destino de los incidentes (la API real); `null` lo desconecta (tests, mock). */
export function setIncidentSink(next: Sink | null): void {
  sink = next;
  failureNoted = false;
}

/**
 * Manda el incidente sin esperar. Si el registro falla se avisa una vez por
 * ejecución con una nota `info` (que no genera otro incidente).
 */
export function reportIncident(report: IncidentReport): void {
  if (!sink) return;
  void sink(report).catch((e: unknown) => {
    if (failureNoted || !report.id) return;
    failureNoted = true;
    const detail = e instanceof Error ? e.message : String(e);
    store.dispatch({
      type: "note",
      id: report.id,
      note: { id: `incident-${Date.now().toString(36)}`, at: new Date().toISOString(), level: "info", text: `No se pudo guardar el aviso en el registro de incidentes: ${detail}` },
    });
  });
}

/** Clave de un atasco: el mismo motivo y la misma herramienta no son un atasco nuevo. */
function stallKey(s: SessionInfo): string | null {
  return s.stalled ? `${s.stalled.reason}|${s.stalled.tool ?? ""}` : null;
}

/**
 * Atascos nuevos respecto a la lista anterior. Devuelve los incidentes y el
 * mapa de claves vigente (no muta `prev`).
 */
export function newStalls(prev: ReadonlyMap<SessionId, string>, sessions: readonly SessionInfo[]): { reports: IncidentReport[]; seen: Map<SessionId, string> } {
  const seen = new Map<SessionId, string>();
  const reports: IncidentReport[] = [];
  for (const s of sessions) {
    const key = stallKey(s);
    if (key === null || !s.stalled) continue;
    seen.set(s.id, key);
    if (prev.get(s.id) !== key) reports.push({ id: s.id, origin: "stall", level: "warn", text: `${s.stalled.reason}: ${s.stalled.detail}` });
  }
  return { reports, seen };
}
