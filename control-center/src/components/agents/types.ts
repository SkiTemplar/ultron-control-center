// Types and constants for the Agents component.

import type { SkillOrigin } from "../../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProjectLite = { id: string; name: string };

export type ScopeFilter = "all" | SkillOrigin;

export type EnableFilter = "active" | "disabled" | "all";

/**
 * ÚNICO espejo TS de `agent_orchestration::DelegationLogEntry` (types.rs).
 * Serde serializa `cheap_model_requested`; el alias legacy del campo solo
 * cubre la DEserialización del JSONL histórico — nunca llega al frontend.
 */
export type DelegationLogEntry = {
  id: string;
  agent: string;
  task_preview: string;
  cwd: string | null;
  cheap_model_requested: boolean;
  started_at: string;
  status: string; // "running" | "done" | "failed" | "stale" | legacy: "timeout" | "launched"
  session_id: string | null;
  error?: string | null;
};

export type LabelCount = {
  label: string;
  n: number;
};

export type AgentUsage = {
  agent: string;
  count: number;
  chars: number;
  /** ISO 8601 timestamp of the last invocation (empty string if never). */
  lastTs: string;
  topLabels: LabelCount[];
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SCOPES: { id: ScopeFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "global", label: "Global" },
  { id: "project", label: "Project" },
  { id: "plugin", label: "Plugin" },
];

export const NO_CATEGORY = "uncategorized";

// Violet accent — consistent with LibraryDetailPane "agent" kind and icons.tsx Bot=violet.
export const AGENT_ACCENT = "rgba(167, 139, 250, 0.55)";
export const AGENT_ACCENT_SOFT = "rgba(167, 139, 250, 0.16)";
