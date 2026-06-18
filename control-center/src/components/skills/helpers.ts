import type { SkillEntry } from "../../types";
import { categorize } from "../../lib/skill-categories";
import { NO_CATEGORY } from "./constants";

export function deriveCategory(s: SkillEntry): string {
  const norm = s.path.replace(/\\/g, "/");
  if (s.origin === "plugin") {
    const m = norm.match(/\/plugins\/cache\/[^/]+\/([^/]+)\/[^/]+\/skills\//);
    if (m && m[1]) return m[1];
  }
  const m = norm.match(/\/skills\/([^/]+)\/[^/]+\/?(?:SKILL\.md)?$/);
  if (m && m[1] && m[1] !== s.name) return m[1];
  return NO_CATEGORY;
}

export function deriveTopGroup(s: SkillEntry): string {
  if (s.origin === "global") return "Global";
  if (s.origin === "project") return "Project";
  return deriveCategory(s);
}

export function deriveSubGroup(s: SkillEntry): string | null {
  const domain = categorize(s.name, s.description);
  if (domain) return domain;
  const norm = s.path.replace(/\\/g, "/");
  if (s.origin === "plugin") {
    const m = norm.match(/\/skills\/([^/]+)\/[^/]+\/?(?:SKILL\.md)?$/);
    if (m && m[1] && m[1] !== s.name) return m[1];
    return null;
  }
  const cat = deriveCategory(s);
  if (cat === NO_CATEGORY) return null;
  return cat;
}

export function skillWorkspace(s: SkillEntry): { folder: string; file: string } {
  const file = s.path;
  const norm = file.replace(/\\/g, "/");
  if (/\/SKILL\.md$/i.test(norm)) {
    return { folder: file.replace(/[\\/]SKILL\.md$/i, ""), file };
  }
  if (!/\.md$/i.test(norm)) {
    const sep = file.includes("\\") ? "\\" : "/";
    return { folder: file, file: file + sep + "SKILL.md" };
  }
  const lastSep = Math.max(file.lastIndexOf("\\"), file.lastIndexOf("/"));
  return { folder: lastSep > 0 ? file.slice(0, lastSep) : "", file };
}
