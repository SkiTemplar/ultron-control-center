// FolderTreeView — recursive tree hierarchy renderer for the Projects grid.
// Extracted from Projects.tsx (3594 L) as part of the P1 split refactor.

import type { ReactElement } from "react";
import type { ProjectInfo } from "../../types";
import type { FolderTreeViewProps } from "./types";
import { countProjects } from "./utils";
import { ProjectCard } from "./ProjectCard";
import { ProjectRow } from "./ProjectRow";

export function FolderTreeView(props: FolderTreeViewProps): ReactElement {
  const { node, depth, viewMode, collapsed, onToggleFolder, stats } = props;

  const isRoot = depth === 0;
  const isCollapsed = !isRoot && collapsed.has(node.fullPath);
  const totalUnderHere = countProjects(node);

  const renderProjects = (items: ProjectInfo[]) =>
    viewMode === "cards" ? (
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}
      >
        {items.map((p) => (
          <ProjectCard
            key={p.id}
            p={p}
            stats={stats[p.id] ?? null}
            onOpenWorkspace={() => props.openInWorkspace(p.id, p.name ?? p.id)}
            onOpenFolder={() => void props.cardOpenFolder(p)}
            onOpenIde={() => void props.cardOpenIde(p)}
            onOpenAi={() => void props.cardOpenAi(p)}
            onEdit={() => props.startEdit(p)}
            onDelete={() => props.setPendingDelete(p)}
          />
        ))}
      </div>
    ) : (
      <div className="space-y-2">
        {items.map((p) => (
          <ProjectRow
            key={p.id}
            p={p}
            selected={props.selected === p.id}
            onClick={() => props.setSelected(p.id)}
            onOpen={() => void props.openLegacy(p.id)}
            opening={props.opening === p.id}
            onEdit={() => props.startEdit(p)}
            onDelete={() => props.setPendingDelete(p)}
            onLaunchAll={() => void props.launchAll(p.id)}
            onLaunchItem={(i) => void props.launchItem(p.id, i)}
            onAddItem={() => props.openAddItem(p)}
            onRemoveItem={(i) => void props.removeItem(p.id, i)}
            onSetDefaultProvider={(prov) => void props.setDefaultProvider(p.id, prov)}
            busyItem={props.busyItem[p.id] ?? null}
            launchingAll={!!props.launchingAll[p.id]}
          />
        ))}
      </div>
    );

  return (
    <div
      className={isRoot ? "space-y-4" : "space-y-2"}
      style={isRoot ? {} : { marginLeft: depth === 1 ? 0 : 12 }}
    >
      {!isRoot && (
        <button
          type="button"
          onClick={() => onToggleFolder(node.fullPath)}
          className="flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-[var(--color-surface-2)]"
          title={node.fullPath}
        >
          <span
            aria-hidden
            className="inline-block w-3 text-center font-mono text-[10px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {isCollapsed ? "▶" : "▼"}
          </span>
          <span
            className="font-mono text-[11.5px] font-semibold uppercase tracking-[0.04em]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            {node.segment}
          </span>
          <span className="text-[10px] tabular-nums" style={{ color: "var(--color-text-tertiary)" }}>
            {totalUnderHere}
          </span>
          <span className="h-px flex-1" style={{ background: "var(--color-border)" }} />
        </button>
      )}
      {!isCollapsed && (
        <div className="space-y-4">
          {node.projects.length > 0 && renderProjects(node.projects)}
          {node.children.map((child) => (
            <FolderTreeView
              key={child.fullPath || child.segment}
              {...props}
              node={child}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}
