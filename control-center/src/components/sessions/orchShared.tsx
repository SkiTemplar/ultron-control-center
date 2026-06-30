// ULTRON Control Center — helpers compartidos del dominio "orquestación".
//
// Extraídos para que el panel global en vivo (LiveSessionMonitor) y las tarjetas
// por sesión (SessionCard) compartan tintes, formato y etiquetas SIN duplicar.
// Antes KIND_TINT estaba copiado literalmente en ambos y fmtTime/statusColor/
// ROUTING_MSG/SectionLabel vivían solo en el monitor.

import type { ReactNode } from "react";

/** Tinte por tipo de skill (persona / technical / meta). */
export const KIND_TINT: Record<string, string> = {
  persona: "#a855f7",
  technical: "#3b82f6",
  meta: "#22c55e",
};

/** Hora local hh:mm:ss desde un ISO; "" si no hay; el crudo si no parsea. */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Color semántico del estado de una delegación/agente. */
export function statusColor(status: string): string {
  const s = status.toLowerCase();
  if (s === "done" || s === "launched") return "var(--color-success, #3fb950)";
  if (s === "running" || s === "delegating") return "var(--color-accent)";
  if (s === "timeout" || s === "failed") return "var(--color-danger, #ef4444)";
  return "var(--color-text-tertiary)";
}

const ROUTING_MSG: Record<string, { label: string; color: string }> = {
  high_confidence_routing: {
    label: "alta confianza",
    color: "var(--color-success, #3fb950)",
  },
  medium_confidence_routing: { label: "media confianza", color: "var(--color-accent)" },
  low_confidence_skip: { label: "baja (omitido)", color: "var(--color-text-faint)" },
  lazy_skill_injected: {
    label: "skill inyectada",
    color: "var(--color-success, #3fb950)",
  },
  semantic_fallback_empty: { label: "sin match semantico", color: "var(--color-text-faint)" },
  no_match: { label: "sin match", color: "var(--color-text-faint)" },
};

/** ¿Es una decisión de routing "interesante" (mapeada, no ruido de debug)? */
export function isRelevantRoutingMsg(msg: string | null): boolean {
  return msg != null && Object.prototype.hasOwnProperty.call(ROUTING_MSG, msg);
}

export function routingMeta(msg: string | null): { label: string; color: string } {
  if (!msg) return { label: "—", color: "var(--color-text-tertiary)" };
  return ROUTING_MSG[msg] ?? { label: msg, color: "var(--color-text-tertiary)" };
}

/** Etiqueta de sección en mayúsculas (estilo uniforme del panel). */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p
      className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.07em]"
      style={{ color: "var(--color-text-tertiary)" }}
    >
      {children}
    </p>
  );
}
