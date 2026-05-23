// P5 — Agent/Skill library client. Wraps the Tauri `library_*` commands
// with a small de-duplication guard for in-flight searches.

import { invoke } from "@tauri-apps/api/core";
import type {
  AgentCreateInput,
  InstallInput,
  LibraryKind,
  PinnedAgents,
  RemoteItem,
  SkillCreateInput,
} from "../types";

let searchInflight: Promise<RemoteItem[]> | null = null;

export async function librarySearchGitHub(
  query: string,
  kind: LibraryKind,
  limit = 30,
): Promise<RemoteItem[]> {
  if (!query.trim()) return [];
  if (searchInflight) {
    try {
      await searchInflight;
    } catch {
      /* prev failed, continue */
    }
  }
  searchInflight = invoke<RemoteItem[]>("library_search_github", {
    query,
    kind,
    limit,
  });
  try {
    return await searchInflight;
  } finally {
    searchInflight = null;
  }
}

export function libraryInstallFromGitHub(args: InstallInput): Promise<string> {
  return invoke<string>("library_install_from_github", { args });
}

export function agentCreate(args: AgentCreateInput): Promise<string> {
  return invoke<string>("agent_create", { args });
}

export function skillCreate(args: SkillCreateInput): Promise<string> {
  return invoke<string>("skill_create", { args });
}

export function libraryPinAgent(
  projectId: string,
  agentSlug: string,
): Promise<PinnedAgents> {
  return invoke<PinnedAgents>("library_pin_agent", { projectId, agentSlug });
}

export function libraryUnpinAgent(
  projectId: string,
  agentSlug: string,
): Promise<PinnedAgents> {
  return invoke<PinnedAgents>("library_unpin_agent", { projectId, agentSlug });
}

export function libraryListPinned(projectId: string): Promise<PinnedAgents> {
  return invoke<PinnedAgents>("library_list_pinned", { projectId });
}
