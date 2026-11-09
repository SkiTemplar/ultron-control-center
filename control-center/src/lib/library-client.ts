// P5 — Agent/Skill library client. Thin wrappers over the Tauri library,
// agent and skill creation commands. `libraryInstallFromGitHub` se retiró el
// 2026-10-17 (su modal no tenía entrada en la UI).

import { invoke } from "@tauri-apps/api/core";
import type {
  AgentCreateInput,
  AnalyzeRepoResult,
  SkillCreateInput,
} from "../types";

/**
 * Scan a LOCAL repo on disk for skills/agents and run the same post-install
 * integration (sync-registry catalog refresh + governed memory candidate) as a
 * GitHub install. Read-only: copies nothing. Returns the assets it found plus
 * the integration report (registry synced, newly detected, memory candidate id).
 */
export function analyzeLocalRepo(path: string): Promise<AnalyzeRepoResult> {
  return invoke<AnalyzeRepoResult>("analyze_local_repo", { path });
}

export function agentCreate(args: AgentCreateInput): Promise<string> {
  return invoke<string>("agent_create", { args });
}

export function skillCreate(args: SkillCreateInput): Promise<string> {
  return invoke<string>("skill_create", { args });
}
