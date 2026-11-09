// ULTRON Control Center — tipos locales del panel LiveSessionMonitor
// (preview manual de orquestación; los eventos de delegación se retiraron el
// 2026-10-17 por no tener productor).
// Extraídos de LiveSessionMonitor.tsx (cat7.4: >800 líneas) sin cambiar forma.

// Espejo de orchestrator::OrchestrationContext (modulo orchestrator/, snake_case sin rename) —
// respuesta de invoke('orchestrate_prompt') para el preview manual (F2.1).
export type OrchestrationPreview = {
  prompt: string;
  route: string;
  project_id: string | null;
  workflow: { id: string; label: string; description: string; steps: string[] } | null;
  delegate_agents: { name: string; description: string; score: number }[];
  delegate_skills: { name: string; description: string; kind: string; score: number }[];
  memories: { scope: string; title: string | null; summary: string | null }[];
  constraints: string[];
  warnings: string[];
  token_budget: number;
  cross_project: boolean;
  /** cat13: paso de mejora de prompt (encuadre + modo + clarificaciones). */
  prompt_plan?: {
    improved_prompt: string;
    suggested_mode: string;
    clarifying_questions: string[];
    success_criteria: string[];
  } | null;
  /** cat13.4: encuadre por paso cuando el workflow tiene dos o más pasos. */
  step_plans?: { agent: string; sub_intent: string; frame: string }[];
  /** Directiva de delegación que el hook emitiría en modo full. */
  delegation_directive?: {
    agent: string;
    objective: string;
    return_format: string;
    model_hint: string | null;
    reason: string;
  } | null;
  /** Tono detectado: lo ÚNICO que el modo ligero inyecta en sesión. */
  tone?: { id: string; name: string; reason: string; explicit: boolean } | null;
};
