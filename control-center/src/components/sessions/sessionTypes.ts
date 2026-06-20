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
