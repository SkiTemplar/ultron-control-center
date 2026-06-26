// Tipos para el monitor de sesiones activas (list_active_sessions).
// Separados de types.ts (launcher) para evitar colisiones.

export type SessionStatus = "working" | "waiting" | "idle" | "dead";

export interface SessionInfo {
  session_id: string;
  project_path: string;
  project_name: string;
  matched_project_id: string | null;
  git_branch: string | null;
  model: string | null;
  context_tokens: number;
  context_limit: number;      // ventana inferida: 200000 o 1000000
  context_pct: number;        // 0-100
  cache_read_tokens: number;
  output_tokens: number;
  status: SessionStatus;
  last_activity: string;      // ISO
  age_seconds: number;
  last_prompt: string | null;
  last_activity_summary: string | null;
  is_subagent: boolean;
}

/** Sesiones agrupadas por proyecto para la presentación. */
export interface ProjectGroup {
  project_name: string;
  project_path: string;
  /** Sesiones principales (is_subagent = false). */
  sessions: SessionInfo[];
  /** Subagentes ligados al mismo proyecto. */
  subagents: SessionInfo[];
}

// ---------------------------------------------------------------------------
// Orquestación por sesión.
//
// Espejo parcial de OrchestrateLogEntry (backend: commands/sessions_sub/
// live_session.rs). El hook UserPromptSubmit escribe cada turno en
// ~/.claude/logs/orchestrate.jsonl con el session_id de la sesión PRINCIPAL,
// que es el mismo UUID que nombra el transcript → se correlaciona 1:1 con
// SessionInfo.session_id. Los subagentes (is_subagent) no tienen turno propio
// en este log, así que simplemente no traen orquestación.
// ---------------------------------------------------------------------------

export interface OrchAgent {
  name: string;
  score: number;
}

export interface OrchSkill {
  name: string;
  kind: string;
  score: number;
}

export interface OrchMemory {
  scope: string;
  summary: string;
}

/** Último turno orquestado de una sesión (route → workflow → agentes → skills → memoria). */
export interface SessionOrchestration {
  ts: string | null;
  session_id: string | null;
  prompt: string | null;
  route: string | null;
  workflow: { id: string | null; label: string | null } | null;
  agents: OrchAgent[];
  skills: OrchSkill[];
  memories: OrchMemory[];
  cross_project: boolean;
}

/** Forma mínima de live_session_feed que consume el Monitor (solo orquestaciones). */
export interface LiveFeedLite {
  orchestrations: SessionOrchestration[];
}
