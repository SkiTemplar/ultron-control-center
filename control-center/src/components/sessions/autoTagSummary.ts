// Resumen del resultado de «Etiquetar todo» (sessions_bulk_auto_tag).
//
// El backend devuelve un resultado por sesión: etiquetada, saltada (sin primer
// mensaje) o fallida con su causa. Aquí se cuenta cada caso para que la UI diga
// cuántas fallaron y por qué, en lugar de un «Etiquetadas 0 de N» mudo.

export type AutoTagStatus = "tagged" | "skipped" | "failed";

export interface AutoTagOutcome {
  session_id: string;
  status: AutoTagStatus;
  tags: string[];
  error?: string;
}

export interface AutoTagSummary {
  /** Texto para el aviso. */
  message: string;
  /** Hay al menos una fallida: la UI debe mostrarlo como error. */
  hasFailures: boolean;
}

export function summarizeAutoTag(outcomes: readonly AutoTagOutcome[]): AutoTagSummary {
  const count = (s: AutoTagStatus) => outcomes.filter((o) => o.status === s).length;
  const tagged = count("tagged");
  const skipped = count("skipped");
  const failed = outcomes.filter((o) => o.status === "failed");
  const parts = [`Etiquetadas ${tagged} de ${outcomes.length} sesiones`];
  if (skipped > 0) parts.push(`${skipped} sin primer mensaje`);
  if (failed.length > 0) {
    const cause = failed[0].error ?? "sin causa";
    parts.push(`${failed.length} fallidas (la primera: ${cause})`);
  }
  return { message: parts.join("; "), hasFailures: failed.length > 0 };
}
