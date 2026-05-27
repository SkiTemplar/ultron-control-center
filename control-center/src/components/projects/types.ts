// Shared types for the Projects feature module.
// Extracted from Projects.tsx (3594 L) as part of the P1 split refactor.

import type { ProjectInfo, ProjectSubTab, SessionProvider } from "../../types";

export type CardStats = {
  pending: number | null;
  sessions: number | null;
};

export type SortBy = "recent" | "alpha" | "type";

/** Hierarchy mode for the project grid. */
export type HierarchyMode = "flat" | "tree" | "blocks";

export type ViewMode = "cards" | "list";

/** Internal tree node used by the Tree-mode render. */
export type FolderNode = {
  segment: string;
  fullPath: string;
  children: FolderNode[];
  projects: ProjectInfo[];
};

export type ProjectsProps = {
  onOpenProject?: (project: { id: string; name: string }) => void;
};

export type FolderTreeViewProps = {
  node: FolderNode;
  depth: number;
  viewMode: ViewMode;
  collapsed: Set<string>;
  onToggleFolder: (fullPath: string) => void;
  stats: Record<string, CardStats>;
  openInWorkspace: (id: string, name: string, subTab?: ProjectSubTab) => void;
  cardOpenFolder: (p: ProjectInfo) => void | Promise<void>;
  cardOpenIde: (p: ProjectInfo) => void | Promise<void>;
  cardOpenAi: (p: ProjectInfo) => void | Promise<void>;
  cardOpenTerminal: (p: ProjectInfo) => void;
  startEdit: (p: ProjectInfo) => void;
  setPendingDelete: (p: ProjectInfo) => void;
  selected: string | null;
  setSelected: (id: string) => void;
  opening: string | null;
  openLegacy: (id: string) => void | Promise<void>;
  launchAll: (id: string) => void | Promise<void>;
  launchItem: (id: string, i: number) => void | Promise<void>;
  openAddItem: (p: ProjectInfo) => void;
  removeItem: (id: string, i: number) => void | Promise<void>;
  setDefaultProvider: (id: string, prov: SessionProvider) => void | Promise<void>;
  busyItem: Record<string, number | null>;
  launchingAll: Record<string, boolean>;
};

export type BlocksProjectViewProps = {
  root: FolderNode;
  path: string[];
  onPathChange: (next: string[]) => void;
  stats: Record<string, CardStats>;
  openInWorkspace: (id: string, name: string, subTab?: ProjectSubTab) => void;
  cardOpenFolder: (p: ProjectInfo) => void | Promise<void>;
  cardOpenIde: (p: ProjectInfo) => void | Promise<void>;
  cardOpenAi: (p: ProjectInfo) => void | Promise<void>;
  cardOpenTerminal: (p: ProjectInfo) => void;
  startEdit: (p: ProjectInfo) => void;
  setPendingDelete: (p: ProjectInfo) => void;
};
