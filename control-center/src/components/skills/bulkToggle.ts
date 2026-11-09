// Resultado de `skills_bulk_toggle` / `agents_bulk_toggle`.
//
// El backend devuelve un desglose por elemento, pero la UI lo descartaba:
// un bulk con fallos parciales se veía igual que uno limpio (se vaciaba la
// selección y no salía ningún aviso). Este módulo lo traduce a un mensaje y
// a la selección que conviene conservar para reintentar.

export interface BulkToggleOutcome {
  name: string;
  ok: boolean;
  error?: string;
}

export interface BulkToggleResult {
  requested: number;
  succeeded: number;
  failed: number;
  outcomes: BulkToggleOutcome[];
}

export interface BulkToggleReport {
  /** `null` si todo fue bien. */
  message: string | null;
  /** Nombres que fallaron: se dejan marcados para reintentar. */
  failedNames: string[];
}

const MAX_LISTED = 3;

// Nombre visible de cada tipo (el plural se forma con «s»).
const NOUN_LABEL: Record<"skill" | "agent", string> = { skill: "skill", agent: "agente" };

export function bulkToggleReport(
  result: BulkToggleResult | null | undefined,
  targetEnabled: boolean,
  noun: "skill" | "agent",
): BulkToggleReport {
  const failures = (result?.outcomes ?? []).filter((o) => !o.ok);
  if (!result || (result.failed === 0 && failures.length === 0)) {
    return { message: null, failedNames: [] };
  }
  const verb = targetEnabled ? "activado" : "desactivado";
  const failedCount = Math.max(result.failed, failures.length);
  const listed = failures
    .slice(0, MAX_LISTED)
    .map((o) => (o.error ? `${o.name} (${o.error})` : o.name))
    .join("; ");
  const more = failures.length > MAX_LISTED ? `; +${failures.length - MAX_LISTED} más` : "";
  const plural = result.requested === 1 ? NOUN_LABEL[noun] : `${NOUN_LABEL[noun]}s`;
  return {
    message: `Se han ${verb} ${result.succeeded} de ${result.requested} ${plural}; ${failedCount} con error: ${listed}${more}. Los elementos con error siguen seleccionados.`,
    failedNames: failures.map((o) => o.name),
  };
}
