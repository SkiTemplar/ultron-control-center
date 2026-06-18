// Types and constants for the Agents component.

import type { SkillOrigin } from "../../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProjectLite = { id: string; name: string };

export type ScopeFilter = "all" | SkillOrigin;

export type EnableFilter = "active" | "disabled" | "all";

export type DelegationLogEntry = {
  id: string;
  agent: string;
  task_preview: string;
  cwd: string | null;
  used_cheap_model: boolean;
  started_at: string;
  status: string;
  session_id: string | null;
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
