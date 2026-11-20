// ---------------------------------------------------------------------------
// Library (P5): agent/skill creation in-app.
// ---------------------------------------------------------------------------

export type TargetScope = "global" | "project";

export type AgentCreateInput = {
  name: string;
  description: string;
  tools: string[];
  /** Exact 5.5 ID; the backend rejects any other value (aliases are normalised). */
  model: string | null;
  body: string;
  /** Turn cap written to the frontmatter; the backend accepts 1..=500. */
  maxTurns: number;
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
// Returned by `analyze_local_repo` so the UI can show the memory candidate.
export type PostInstallReport = {
  /** Memory inbox candidate id awaiting approval, if any. */
  memory_candidate_id: string | null;
  /** Non-fatal notes (DB closed, …). */
  warnings: string[];
};

// Result of scanning a local repo — mirrors
// `crate::commands::library::post_install::AnalyzeRepoResult`.
export type AnalyzeRepoResult = {
  /** Absolute path that was scanned. */
  repo_path: string;
  /** Skill/agent slugs discovered on disk. */
  assets: string[];
  /** Memory-capture outcome. */
  integration: PostInstallReport;
};
