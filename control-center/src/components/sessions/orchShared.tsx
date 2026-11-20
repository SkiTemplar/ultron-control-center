// ULTRON Control Center — helpers compartidos del dominio "orquestación".
//
// Formato y etiquetas compartidos por los paneles del monitor en vivo
// (LiveSessionMonitor y ./live-session/*), SIN duplicar.

import type { ReactNode } from "react";

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
