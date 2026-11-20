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

/**
 * Subagente COMPLETADO, cosechado por el hook SubagentStop
 * (subagent-harvest.jsonl). El hook escribe al TERMINAR, así que son subagentes
 * acabados (no in-flight). `agent === "unknown"` se muestra como "subagente".
 */
export interface SubagentActivity {
  ts: string | null;
  project: string | null;
  agent: string;
  chars: number;
  preview: string;
  label: string | null;
}

/**
 * Subagente EN VUELO: arrancó (SubagentStart) y aún no reportó su SubagentStop.
 * Da el "en vivo" real que SubagentActivity (terminados) no cubre.
 */
export interface RunningSubagent {
  agent: string;
  label: string | null;
  agent_id: string;
  started_at: string | null;
}

/**
 * Feed completo de live_session_feed: subagentes terminados y en vuelo para el
 * panel global LiveSessionMonitor. `routing` (log del dispatcher desconectado)
 * se retiró el 2026-10-23, y los turnos y el modo de memory-orchestrate, el
 * 2026-11-15, con el modo full del hook.
 */
export interface LiveSessionFeed {
  subagents: SubagentActivity[];
  running_subagents: RunningSubagent[];
  generated_at: string;
}
