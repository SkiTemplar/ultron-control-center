// Types and constants for the Agents component.

import type { SkillOrigin } from "../../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProjectLite = { id: string; name: string };

export type ScopeFilter = "all" | SkillOrigin;

export type EnableFilter = "active" | "disabled" | "all";

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
  { id: "all", label: "Todos" },
  { id: "global", label: "Global" },
  { id: "project", label: "Proyecto" },
  { id: "plugin", label: "Plugin" },
];

export const NO_CATEGORY = "sin categoría";

// Violet accent — consistent with LibraryDetailPane "agent" kind and icons.tsx Bot=violet.
export const AGENT_ACCENT = "rgba(167, 139, 250, 0.55)";
export const AGENT_ACCENT_SOFT = "rgba(167, 139, 250, 0.16)";
