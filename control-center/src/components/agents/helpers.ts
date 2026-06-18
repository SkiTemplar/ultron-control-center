// Pure helper functions for the Agents component.

import type { AgentEntry } from "../../types";
import { NO_CATEGORY } from "./types";

/// Derive a category from the on-disk path. Examples:
///   ~/.claude/agents/sec/reviewer.md → "sec"
///   ~/.claude/agents/reviewer.md     → "uncategorized"
///   .../plugins/cache/<id>/<plugin>/<ver>/agents/foo.md → "<plugin>"
export function deriveCategory(a: AgentEntry): string {
  const norm = a.path.replace(/\\/g, "/");
  if (a.origin === "plugin") {
    const m = norm.match(/\/plugins\/cache\/[^/]+\/([^/]+)\/[^/]+\/agents\//);
    if (m && m[1]) return m[1];
  }
  const m = norm.match(/\/agents\/([^/]+)\/[^/]+\.md/);
  if (m && m[1]) return m[1];
  return NO_CATEGORY;
}

export function deriveTopGroup(a: AgentEntry): string {
  if (a.origin === "global") return "Global";
  if (a.origin === "project") return "Project";
  return deriveCategory(a);
}

export function deriveSubGroup(a: AgentEntry): string | null {
  const norm = a.path.replace(/\\/g, "/");
  if (a.origin === "plugin") {
    const m = norm.match(/\/agents\/([^/]+)\/[^/]+\.md/);
    if (m && m[1]) return m[1];
    return null;
  }
  const cat = deriveCategory(a);
  if (cat === NO_CATEGORY) return null;
  return cat;
}

/// Workspace folder + primary file for the detail pane. For agents there is
/// no multi-file "workspace" concept (unlike SKILL.md folders) so we simply
/// open the parent directory alongside the .md file.
export function agentWorkspace(a: AgentEntry): { folder: string; file: string } {
  const file = a.path;
  const lastSep = Math.max(file.lastIndexOf("\\"), file.lastIndexOf("/"));
  return {
    folder: lastSep > 0 ? file.slice(0, lastSep) : "",
    file,
  };
}

export function diceBearUrl(slug: string): string {
  const seed = encodeURIComponent(slug || "agent");
  return `https://api.dicebear.com/7.x/bottts/svg?seed=${seed}&backgroundColor=1a1a2e,222238`;
}

export function ageFromEpochField(s: string): string {
  const m = /^epoch:(\d+)$/.exec(s);
  if (!m) return s;
  const secs = parseInt(m[1], 10);
  if (!Number.isFinite(secs)) return s;
  const diff = Math.max(0, Date.now() / 1000 - secs);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function statusChip(status: string): { bg: string; fg: string; label: string } {
  if (status === "launched") {
    return { bg: "rgba(63, 185, 80, 0.14)", fg: "rgb(63, 185, 80)", label: "Launched" };
  }
  if (status === "failed") {
    return { bg: "rgba(248, 81, 73, 0.14)", fg: "rgb(248, 81, 73)", label: "Failed" };
  }
  return { bg: "rgba(125, 133, 144, 0.14)", fg: "rgb(125, 133, 144)", label: status };
}
