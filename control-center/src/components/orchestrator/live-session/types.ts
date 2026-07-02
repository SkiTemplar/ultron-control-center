// ULTRON Control Center — tipos locales del panel LiveSessionMonitor
// (eventos en vivo de delegación + preview manual de orquestación).
// Extraídos de LiveSessionMonitor.tsx (cat7.4: >800 líneas) sin cambiar forma.

// Eventos en vivo emitidos por el backend al delegar/terminar un agente.
export type DelegatingPayload = {
  agent: string;
  task_preview?: string;
  provider?: string;
  started_at?: string;
};
export type DelegatedPayload = {
  agent: string;
  status?: string;
  task_preview?: string;
  duration_ms?: number;
};

export type LiveEvent = {
  seq: number; // id estable para la key de React (la lista usa prepend)
  agent: string;
  status: string; // delegating | done | timeout | launched | failed
  preview: string;
  provider?: string;
  at: string; // ISO
};

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
};

export const MAX_LIVE_EVENTS = 8;
