// Shared utility functions and constants for the Projects feature module.
// Extracted from Projects.tsx (3594 L) as part of the P1 split refactor.

import type { LauncherItem, LauncherItemKind, ProjectInfo, SessionProvider } from "../../types";
import type { FolderNode } from "./types";

// ---------------------------------------------------------------------------
// Launcher item classification helpers
// ---------------------------------------------------------------------------

/** Labels written by the backwards-compat synthesiser in projects.rs.
 *  When an item carries one of these, the user never picked a name —
 *  we treat it as built-in and render the icon-only chip. */
export const SYNTHETIC_LABELS = new Set<string>([
  "Open folder",
  "New Claude session",
  "Claude session",
  "Codex session",
]);

/** True when the item should render as an icon-only built-in chip. */
export function isBuiltinItem(item: LauncherItem): boolean {
  const knownKind =
    item.kind === "folder" ||
    item.kind === "claude" ||
    item.kind === "codex" ||
    item.kind === "gemini" ||
    item.kind === "session" ||
    item.kind === "ide" ||
    item.kind === "exe";
  if (!knownKind) return false;
  const label = (item.label ?? "").trim();
  if (!label) return true;
  return SYNTHETIC_LABELS.has(label);
}

/** Tooltip text for a built-in chip — full kind + target path. */
export function builtinTooltip(item: LauncherItem): string {
  switch (item.kind) {
    case "folder":
      return `Open folder: ${item.path ?? ""}`;
    case "claude":
      return `Start Claude session in ${item.cwd ?? "cwd"}`;
    case "codex":
      return `Start Codex session in ${item.cwd ?? "cwd"}`;
    case "gemini":
      return `Start Gemini session in ${item.cwd ?? "cwd"}`;
    case "session": {
      const p = (item.provider ?? "claude").toString();
      const pName = p === "codex" ? "Codex" : p === "gemini" ? "Gemini" : "Claude";
      return `Start ${pName} session in ${item.cwd ?? "cwd"}`;
    }
    case "ide":
      return `Open in preferred IDE: ${item.path ?? "(project path)"}`;
    case "exe": {
      const args =
        item.args && item.args.length > 0 ? " " + item.args.join(" ") : "";
      return `Launch: ${item.path ?? ""}${args}`;
    }
    default:
      return item.kind;
  }
}

/** Display name for custom items. */
export function customItemName(item: LauncherItem): string {
  const label = (item.label ?? "").trim();
  if (label) return label;
  const src = item.path ?? item.cwd ?? "";
  if (!src) return item.kind;
  return src.replace(/[\/\\]+$/, "").split(/[\/\\]/).pop() ?? src;
}

/** Map a default-provider value to the launcher-item `kind` it would match. */
export function providerToKind(p: SessionProvider): string {
  return p;
}

// ---------------------------------------------------------------------------
// Status styling
// ---------------------------------------------------------------------------

export function statusBadge(s: string | null): { color: string; bg: string; label: string } {
  switch (s) {
    case "active":
      return { color: "var(--color-success)", bg: "rgba(63, 185, 80, 0.08)", label: "active" };
    case "auto-detected":
      return { color: "var(--color-text-secondary)", bg: "var(--color-surface-3)", label: "auto" };
    case "manual":
      return { color: "var(--color-warn)", bg: "rgba(210, 153, 34, 0.08)", label: "manual" };
    case "archived":
      return { color: "var(--color-text-tertiary)", bg: "var(--color-surface-2)", label: "archived" };
    default:
      return { color: "var(--color-text-tertiary)", bg: "var(--color-surface-2)", label: s ?? "—" };
  }
}

/** Pretty provider name + accent for the per-card "AI" button. */
export function providerBadge(p: SessionProvider): { label: string; tint: string } {
  switch (p) {
    case "codex":
      return { label: "Codex", tint: "#10a37f" };
    case "gemini":
      return { label: "Gemini", tint: "#4285f4" };
    case "claude":
    default:
      return { label: "Claude", tint: "#cc785c" };
  }
}

// ---------------------------------------------------------------------------
// Sorting helpers
// ---------------------------------------------------------------------------

/** Launcher item kinds for the add-item modal. */
export const ITEM_KINDS: { value: LauncherItemKind; label: string; hint: string }[] = [
  { value: "folder", label: "Folder", hint: "Open the folder in Windows Explorer" },
  { value: "ide", label: "IDE", hint: "Open the project in the preferred IDE (VS Code / Cursor / Rider / CLion / etc.)" },
  { value: "session", label: "AI session", hint: "Start a new Claude / Codex / Gemini session (selector below)" },
  { value: "exe", label: "Executable (advanced)", hint: "Spawn an .exe / .lnk / .bat with optional arguments" },
];

/** Parse the `last_active` string into a sortable number. Higher = more recent. */
export function lastActiveScore(p: ProjectInfo): number {
  if (!p.last_active) return 0;
  const t = Date.parse(p.last_active);
  if (!Number.isNaN(t)) return t;
  return p.last_active.charCodeAt(0);
}

// ---------------------------------------------------------------------------
// Folder tree helpers
// ---------------------------------------------------------------------------

/** Split a path into normalised segments (handles \ and /). */
export function splitPath(p: string): string[] {
  return p
    .replace(/\\+/g, "/")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Build a folder tree from a list of projects, grouping by common ancestor path. */
export function buildFolderTree(items: ProjectInfo[]): FolderNode {
  const root: FolderNode = { segment: "", fullPath: "", children: [], projects: [] };
  for (const p of items) {
    if (!p.path) {
      let bucket = root.children.find((c) => c.segment === "(no path)");
      if (!bucket) {
        bucket = { segment: "(no path)", fullPath: "(no path)", children: [], projects: [] };
        root.children.push(bucket);
      }
      bucket.projects.push(p);
      continue;
    }
    const segments = splitPath(p.path);
    const parentSegments = segments.slice(0, Math.max(0, segments.length - 1));
    let node = root;
    let acc = "";
    for (const seg of parentSegments) {
      acc = acc ? `${acc}/${seg}` : seg;
      let child = node.children.find((c) => c.segment === seg);
      if (!child) {
        child = { segment: seg, fullPath: acc, children: [], projects: [] };
        node.children.push(child);
      }
      node = child;
    }
    node.projects.push(p);
  }
  collapseLinearChains(root);
  sortTree(root);
  return root;
}

export function collapseLinearChains(node: FolderNode) {
  for (const child of node.children) {
    while (child.children.length === 1 && child.projects.length === 0) {
      const only = child.children[0];
      child.segment = `${child.segment}/${only.segment}`;
      child.fullPath = only.fullPath;
      child.children = only.children;
      child.projects = only.projects;
    }
    collapseLinearChains(child);
  }
}

export function sortTree(node: FolderNode) {
  node.children.sort((a, b) => a.segment.localeCompare(b.segment));
  node.projects.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
  for (const c of node.children) sortTree(c);
}

export function countProjects(node: FolderNode): number {
  return node.projects.length + node.children.reduce((acc, c) => acc + countProjects(c), 0);
}

/** Walk the folder tree to the node addressed by `path` (array of segments). */
export function navigateTo(root: FolderNode, path: string[]): FolderNode {
  let node: FolderNode = root;
  for (const seg of path) {
    const child = node.children.find((c) => c.segment === seg);
    if (!child) return node;
    node = child;
  }
  return node;
}
