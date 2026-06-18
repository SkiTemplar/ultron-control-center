import type { ScopeFilter } from "./types";

export const SCOPES: { id: ScopeFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "global", label: "Global" },
  { id: "project", label: "Project" },
  { id: "plugin", label: "Plugin" },
];

export const NO_CATEGORY = "uncategorized";

// Cyan accent — distinguishes skill cards from agents (violet) and rules (lime).
export const SKILL_ACCENT = "rgba(56, 189, 248, 0.55)";
export const SKILL_ACCENT_SOFT = "rgba(56, 189, 248, 0.16)";
