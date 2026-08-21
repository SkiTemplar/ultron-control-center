// Tipos para el monitor de sesiones activas (list_active_sessions).
// Separados de types.ts (launcher) para evitar colisiones.

import type { DelegationLogEntry } from "../agents/types";

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

/**
 * Último turno orquestado de una sesión (route → workflow → agentes → skills → memoria).
 * Espejo de OrchestrateLogEntry (backend: commands/sessions_sub/live_session.rs).
 * `project`/`warnings` los usa el panel GLOBAL (LiveSessionMonitor); las tarjetas
 * por sesión los ignoran.
 */
export interface SessionOrchestration {
  ts: string | null;
  session_id: string | null;
  project: string | null;
  prompt: string | null;
  route: string | null;
  workflow: { id: string | null; label: string | null } | null;
  agents: OrchAgent[];
  skills: OrchSkill[];
  memories: OrchMemory[];
  cross_project: boolean;
  warnings: string[];
}

/** Decisión del dispatcher de routing (timeline del panel global). */
export interface RoutingLogEntry {
  ts: string | null;
  level: string | null;
  msg: string | null;
  top: string | null;
  score: number | null;
  confidence: number | null;
}

/**
 * Delegación de agente registrada (delegations.jsonl). Espejo único en
 * agents/types.ts — aquí solo se re-exporta para los consumidores del monitor.
 */
export type { DelegationLogEntry };

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
 * Feed completo de live_session_feed. Un único fetch sirve a la vez:
 *   - orchestrations → correlación por session_id (tarjetas) + último turno global
 *   - routing/delegations/subagents/running_subagents → panel global de orquestación
 */
export interface LiveSessionFeed {
  orchestrations: SessionOrchestration[];
  routing: RoutingLogEntry[];
  delegations: DelegationLogEntry[];
  subagents: SubagentActivity[];
  running_subagents: RunningSubagent[];
  generated_at: string;
}
