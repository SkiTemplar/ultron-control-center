// Datos de la línea de estado (E3): opciones de modelo, effort y socrático, y
// formatos. El ritmo del plan sale del puente (inspector/uso-state.ts). Puro.

import type { Effort, EngineTask, EnginesPlanUsage, PermissionMode, RelayState, SessionId, SocraticMode } from "../../types";
import type { DropdownOption } from "../Dropdown";

/** Familia 5.5 y Fable 5.2 (contrato v2, `sesiones_set_model`). */
export const MODEL_OPTIONS: DropdownOption[] = [
  { value: "claude-opus-5-5", label: "Opus 5.5", description: "Código, revisión, depuración y diseño" },
  { value: "claude-opus-5-5[1m]", label: "Opus 5.5 · 1M", description: "Ventana de contexto de un millón de tokens" },
  { value: "claude-sonnet-5-5", label: "Sonnet 5.5", description: "Más barato: specs, tests, contenido y lectura" },
  { value: "claude-haiku-5-5", label: "Haiku 5.5", description: "El más barato y rápido: consultas y tareas sencillas" },
  { value: "claude-fable-5-2", label: "Fable 5.2", description: "El más capaz y el más caro: el doble que Opus 5.5" },
  { value: "claude-fable-5-2[1m]", label: "Fable 5.2 · 1M", description: "Fable 5.2 con la ventana de un millón de tokens" },
];

export const EFFORT_OPTIONS: DropdownOption<Effort>[] = [
  { value: "low", label: "low", description: "Respuestas rápidas, poco razonamiento" },
  { value: "medium", label: "medium", description: "Equilibrio entre coste y profundidad" },
  { value: "high", label: "high", description: "Razona más antes de actuar" },
  { value: "xhigh", label: "xhigh", description: "Para depuración y diseño difíciles" },
  { value: "max", label: "max", description: "Sin tope de razonamiento: el más caro" },
];

export const SOCRATIC_OPTIONS: DropdownOption<SocraticMode>[] = [
  { value: "strict", label: "strict", description: "Razonas tú las decisiones no triviales antes de que escriba" },
  { value: "light", label: "light", description: "Solo pregunta en las decisiones grandes" },
  { value: "uni", label: "uni", description: "Asignaturas: el texto evaluable no se redacta; código con defensa oral" },
  { value: "off", label: "off", description: "Sin protocolo socrático" },
];

export function pctTone(pct: number): "" | "warn" | "err" {
  if (pct >= 85) return "err";
  return pct >= 70 ? "warn" : "";
}

export function formatUsd(v: number | null | undefined): string {
  if (typeof v !== "number" || Number.isNaN(v)) return "—";
  return `${v.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
}

export const PERMISSION_LABEL: Record<string, string> = {
  default: "pregunta",
  auto: "auto",
  acceptEdits: "acepta ediciones",
  plan: "plan",
  bypassPermissions: "sin confirmar",
  skip: "sin confirmar",
};

export function permissionLabel(mode: string | null | undefined): string {
  if (!mode) return "—";
  return PERMISSION_LABEL[mode] ?? mode;
}

export function isRiskyPermission(mode: string | null | undefined): boolean {
  return mode === "skip" || mode === "bypassPermissions";
}

/** Modos que se pueden pedir desde el HUD (§2.5). */
export const PERMISSION_OPTIONS: DropdownOption<PermissionMode>[] = [
  { value: "default", label: "pregunta", description: "Pide permiso antes de editar o ejecutar" },
  { value: "acceptEdits", label: "acepta ediciones", description: "Edita sin preguntar; los comandos sí preguntan" },
  { value: "plan", label: "plan", description: "Planifica sin tocar nada hasta que apruebes" },
  { value: "auto", label: "auto", description: "El clasificador decide qué necesita permiso" },
  { value: "bypassPermissions", label: "sin confirmar", description: "Nada pide confirmación: solo en proyectos de confianza" },
];

/** El backend responde «fuera del ciclo» si Shift+Tab no llega a ese modo (§2.5). */
export function isOutOfCycle(error: string | null | undefined): boolean {
  return Boolean(error && /fuera del ciclo|out of cycle|not in (the )?cycle/i.test(error));
}

// ---------------------------------------------------------------------------
// Relevo activo (Claude → Codex → Gemini): segmento del motor que sigue el trabajo.
// ---------------------------------------------------------------------------

/** Id del motor en `sesiones_engines_usage`: Gemini va por agy. */
export function relayPlanId(engine: RelayState["activeEngine"]): string {
  return engine === "gemini" ? "agy" : "codex";
}

/** Tareas del relevo de la sesión: las de `taskIds` y las de tipo `relay` de esa sesión. */
export function relayTasks(tasks: readonly EngineTask[], relay: RelayState | null, sessionId: SessionId): EngineTask[] {
  const ids = new Set(relay?.taskIds ?? []);
  return tasks.filter((t) => ids.has(t.id) || (t.kind === "relay" && t.sessionId === sessionId));
}

/** Tokens del turno del relevo (entrada + salida) o null si el motor no los da. */
export function relayTurnTokens(tasks: readonly EngineTask[]): number | null {
  const withUsage = tasks.filter((t) => t.usage);
  if (withUsage.length === 0) return null;
  return withUsage.reduce((sum, t) => sum + (t.usage?.inputTokens ?? 0) + (t.usage?.outputTokens ?? 0), 0);
}

/**
 * Cuota de la ventana más corta del motor activo (`5h 12 %`). Sin dato se dice
 * por qué: el segmento nunca queda vacío.
 */
export function relayQuotaText(data: EnginesPlanUsage | null, error: string | null, engine: RelayState["activeEngine"]): string {
  // La API de Anthropic gasta créditos del plan: no tiene ventana de cuota.
  if (engine === "opencode") return "créditos API";
  if (error && !data) return "uso no disponible";
  if (!data) return "consultando uso…";
  const e = data.engines.find((x) => x.id === relayPlanId(engine));
  if (!e || e.status !== "ok") return "sin datos de uso";
  const w = e.windows.find((x) => !x.expired && x.usedPct !== null);
  if (!w || w.usedPct === null) return e.activity ? "sin límite conocido" : "sin datos de uso";
  const label = w.kind === "five_hour" ? "5h" : w.kind === "seven_day" ? "sem" : w.kind;
  return `${label} ${Math.round(w.usedPct)} %`;
}
