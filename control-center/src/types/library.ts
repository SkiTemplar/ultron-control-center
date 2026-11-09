// ---------------------------------------------------------------------------
// Library (P5): agent/skill creation in-app.
// ---------------------------------------------------------------------------

export type TargetScope = "global" | "project";

export type AgentCreateInput = {
  name: string;
  description: string;
  tools: string[];
  model: string | null;
  body: string;
  target_scope: TargetScope;
  target_project_id: string | null;
};

export type SkillCreateInput = {
  name: string;
  description: string;
  body: string;
  target_scope: TargetScope;
  target_project_id: string | null;
};

// Post-install integration outcome — mirrors
// `crate::commands::library::post_install::PostInstallReport`.
// Returned by `analyze_local_repo` (and produced internally on every install)
// so the UI can show "catalog synced + N detected + memory proposed".
export type PostInstallReport = {
  /** True when sync-registry.js ran and exited 0. */
  registry_synced: boolean;
  /** Raw JSON summary line from sync-registry, when available. */
  registry_summary: string | null;
  /** New skills/agents discovered on disk and added to the registry. */
  newly_detected: number;
  /** Memory inbox candidate id awaiting approval, if any. */
  memory_candidate_id: string | null;
  /** Non-fatal notes (missing node, dispatcher error, DB closed, …). */
  warnings: string[];
};

// Result of scanning a local repo — mirrors
// `crate::commands::library::post_install::AnalyzeRepoResult`.
export type AnalyzeRepoResult = {
  /** Absolute path that was scanned. */
  repo_path: string;
  /** Skill/agent slugs discovered on disk. */
  assets: string[];
  /** Catalog-sync + memory-capture outcome. */
  integration: PostInstallReport;
};
