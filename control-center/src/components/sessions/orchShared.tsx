// ULTRON Control Center — helpers compartidos del dominio "orquestación".
//
// Extraídos para que el panel global en vivo (LiveSessionMonitor) y las tarjetas
// por sesión (SessionCard) compartan tintes, formato y etiquetas SIN duplicar.
// Antes KIND_TINT estaba copiado literalmente en ambos y fmtTime/statusColor/
// SectionLabel vivían solo en el monitor.

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

/**
 * Fecha y hora locales desde un ISO: solo la hora si es de hoy y la fecha
 * completa si no, para que un turno de hace semanas no parezca de hoy.
 * "" si no hay; el crudo si no parsea.
 */
export function fmtWhen(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (d.toDateString() === now.toDateString()) return fmtTime(iso);
  const date = d.toLocaleDateString([], { day: "2-digit", month: "2-digit", year: "numeric" });
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${date} ${time}`;
}

/** Días enteros transcurridos desde `iso` (0 si es de hoy o no parsea). */
export function daysSince(iso: string | null | undefined, now: Date = new Date()): number {
  if (!iso) return 0;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 0;
  return Math.max(0, Math.floor((now.getTime() - d.getTime()) / 86_400_000));
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
