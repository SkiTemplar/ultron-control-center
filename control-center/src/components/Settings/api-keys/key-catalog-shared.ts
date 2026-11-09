// Settings/api-keys/key-catalog-shared.ts — textos compartidos por las
// entradas del catálogo que hoy solo sirven al delegador multi-motor y a las
// zonas que configure el usuario (contrato plans/2026-10-26, §5).

import type { KeyTutorial } from "./types";

/** Uso real de una key OpenAI-compatible nueva: nada la consume por defecto. */
export const DELEGATION_OPT_IN_USED_FOR =
  "Disponible para el delegador (scripts/delegate.mjs) como motor con runner opencode y keyEnv igual a esta variable, y para zonas del AI Router que configures tú. Ni la cadena de delegación por defecto ni las zonas del seed la usan.";

export const DELEGATION_OPT_IN_IF_MISSING =
  "Sin efecto con la configuración por defecto. Un motor de delegación que la declare en keyEnv se salta con motivo missing-key y la tarea pasa al siguiente de la cadena.";

interface OptInTutorialInput {
  steps: string[];
  sourceUrl: string;
  sourceLabel: string;
  usedFor?: string;
  ifMissing?: string;
}

/** Tutorial de una key que nada usa por defecto (solo opt-in). */
export function optInTutorial(input: OptInTutorialInput): KeyTutorial {
  return {
    steps: input.steps,
    usedFor: input.usedFor ?? DELEGATION_OPT_IN_USED_FOR,
    ifMissing: input.ifMissing ?? DELEGATION_OPT_IN_IF_MISSING,
    sourceUrl: input.sourceUrl,
    sourceLabel: input.sourceLabel,
  };
}
