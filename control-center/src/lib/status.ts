import type { GlobalStatus, AlertEntry } from "../types";

// Estado global del pie de la barra lateral.
//
// Hasta el 2026-09-21 bastaba UN aviso sin descartar, de cualquier fecha, para
// que el pie dijera "Degraded" para siempre: tres avisos del dia anterior
// (enlaces del chat que no se abrian) lo tenian en amarillo sin que nada
// estuviera fallando. El estado tiene que hablar de AHORA: un aviso caduca como
// señal de salud aunque siga en la pestaña Avisos para quien quiera leerlo.

/** Un aviso de nivel "warn" deja de contar como degradacion pasado este plazo. */
const VIGENCIA_WARN_MS = 12 * 60 * 60 * 1000;
/** Uno critico aguanta un dia: es lo que hay que mirar al volver al equipo. */
const VIGENCIA_CRITICO_MS = 24 * 60 * 60 * 1000;

const CRITICOS = new Set(["critical", "blocking"]);

export type EstadoGlobal = {
  status: GlobalStatus;
  /** Por que esta asi, en una frase. Vacio si todo va bien. */
  motivo: string;
  /** Avisos que cuentan ahora mismo. */
  vigentes: number;
};

function cuando(a: AlertEntry): number {
  const t = Date.parse(a.timestamp ?? a.ts ?? "");
  // Sin fecha legible se trata como reciente: mejor avisar de mas que callar.
  return Number.isNaN(t) ? Date.now() : t;
}

export function estadoGlobal(alerts: AlertEntry[], ahora = Date.now()): EstadoGlobal {
  const ok: EstadoGlobal = { status: "ok", motivo: "", vigentes: 0 };
  if (!alerts || alerts.length === 0) return ok;

  // Lo que el usuario ya descarto en Avisos no vuelve a encender el piloto.
  const dismissed = loadDismissedFingerprints();
  const vigentes = alerts.filter((a) => {
    if (!a || typeof a !== "object") return false;
    const msg = (a.message ?? "").trim().replace(/\s+/g, " ");
    if (dismissed.has(`${a.source ?? ""}::${msg.slice(0, 80)}`)) return false;
    const edad = ahora - cuando(a);
    if (CRITICOS.has(a.severity)) return edad <= VIGENCIA_CRITICO_MS;
    if (a.severity === "warn") return edad <= VIGENCIA_WARN_MS;
    return false;
  });
  if (vigentes.length === 0) return ok;

  const criticos = vigentes.filter((a) => CRITICOS.has(a.severity));
  const peor = (criticos[0] ?? vigentes[0]) as AlertEntry;
  const resto = vigentes.length - 1;
  const motivo =
    `${peor.source}: ${(peor.message ?? "").slice(0, 120)}` +
    (resto > 0 ? ` (y ${resto} más)` : "");
  return { status: criticos.length > 0 ? "down" : "warn", motivo, vigentes: vigentes.length };
}

export function computeGlobalStatus(alerts: AlertEntry[]): GlobalStatus {
  return estadoGlobal(alerts).status;
}

function loadDismissedFingerprints(): Set<string> {
  try {
    const raw = localStorage.getItem("ultron.cc.dismissed_fingerprints.v1");
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

export function statusColor(s: GlobalStatus): string {
  switch (s) {
    case "ok":
      return "var(--color-success)";
    case "warn":
      return "var(--color-warn)";
    case "down":
      return "var(--color-danger)";
    default:
      return "var(--color-text-tertiary)";
  }
}

export function statusLabel(s: GlobalStatus): string {
  switch (s) {
    case "ok":
      return "Operativo";
    case "warn":
      return "Con avisos";
    case "down":
      return "Algo falla";
    default:
      return "Cargando…";
  }
}
