import type { SkillOrigin } from "../../types";

// Registry-sourced metadata (priority / usage_count / tags) the origin-aware
// SkillEntry shape does not carry. Keyed by skill name so the ranked search
// can weight by these signals when they are available.
export type SkillMeta = { priority?: number; usageCount?: number; tags?: string[] };

export type ProjectLite = { id: string; name: string };

export type ScopeFilter = "all" | SkillOrigin;

export type EnableFilter = "active" | "disabled" | "all";
