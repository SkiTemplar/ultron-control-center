// ---------------------------------------------------------------------------
// Control Center 2.0 (P2): origin-aware Skills/Agents + Rules viewer.
// ---------------------------------------------------------------------------

export type SkillState = "active" | "plugin" | "vaulted" | "quarantined" | string;

export type SkillOrigin = "global" | "project" | "plugin";

export type SkillEntry = {
  name: string;
  path: string;
  description: string;
  origin: SkillOrigin;
  enabled: boolean;
};

export type AgentEntry = {
  name: string;
  path: string;
  description: string;
  origin: SkillOrigin;
  /** `false` when the agent file is `<name>.md.disabled` instead of
   * `<name>.md`. Only meaningful for global agents — plugin/project agents
   * always read as enabled here. */
  enabled: boolean;
};

export type RuleFile = {
  name: string;
  path: string;
  relative: string;
  preview: string;
};

export type SecurityDecision = "allow" | "warn" | "quarantine" | "block";

export type SecurityInfo = {
  decision: SecurityDecision | string;
  findings_count?: number;
  high_severity_rules?: string[];
  sha1?: string | null;
  scanned_at?: string | null;
};

export type SkillFinding = {
  rule_id: string;
  severity: string;
  pattern_name: string;
  excerpt: string;
  line_number: number | null;
  waived: boolean;
};

export type SkillSecurityReport = {
  name: string;
  decision: string;
  sha1: string | null;
  findings: SkillFinding[];
  stderr: string;
};

export type AllowSkillResult = {
  success: boolean;
  name: string;
  sha1: string;
  waiver_path: string;
};

export type AgentInfo = {
  name: string;
  description: string | null;
  model: string | null;
  tools: string[];
  path: string | null;
  size_bytes: number;
  last_modified: number | null;
  /** Optional security verdict — populated when an agent registry / scan
   *  pre-computed this. The Agents tab also fetches a fresh report on
   *  demand via `get_agent_findings`, so this field is best-effort and
   *  may be absent even when findings exist. */
  security?: SecurityInfo | null;
};

export type AgentMutationResult = {
  success: boolean;
  name: string;
  path: string;
  backup_path: string | null;
};

/** Symmetric with SkillFinding — agents go through the same scanner. */
export type AgentFinding = {
  rule_id: string;
  severity: string;
  pattern_name: string;
  excerpt: string;
  line_number: number | null;
  waived: boolean;
};

export type AgentSecurityReport = {
  name: string;
  decision: string;
  sha1: string | null;
  findings: AgentFinding[];
  stderr: string;
};

export type AllowAgentResult = {
  success: boolean;
  name: string;
  sha1: string;
  waiver_path: string;
};

export type SkillInfo = {
  name: string;
  state: SkillState;
  source: string | null;
  description: string | null;
  tags: string[];
  path: string | null;
  usage_count: number;
  security?: SecurityInfo | null;
};

export type SkillCreateResult = {
  success: boolean;
  name: string;
  path: string;
  layer: string;
};

export type SkillUpdateResult = {
  success: boolean;
  name: string;
  path: string;
  backup_path: string;
};

export type SkillDeleteResult = {
  success: boolean;
  name: string;
  from_path: string;
  to_path: string;
  soft: boolean;
};

// ---------------------------------------------------------------------------
// Slash command registry (v2.3 — Library → Commands sub-tab).
// ---------------------------------------------------------------------------

export type SlashCommand = {
  /** Bare command name (file stem). */
  name: string;
  /** Plugin slug — `ecc`, `superpowers`, `commit-commands`, …
   *  Special value `user` for `~/.claude/commands/*`. */
  plugin: string;
  /** Marketplace folder — `ecc`, `claude-plugins-official`,
   *  `superpowers-marketplace`, `openai-codex`, …
   *  Special value `user` for the user-local namespace. */
  marketplace: string;
  /** Summary — frontmatter `description:` when present, else first prose paragraph. */
  description: string;
  /** Optional `argument-hint:` from frontmatter. */
  argument_hint: string | null;
  /** Optional `model:` override from frontmatter. */
  model: string | null;
  /** Absolute on-disk path to the .md source. */
  path: string;
};
