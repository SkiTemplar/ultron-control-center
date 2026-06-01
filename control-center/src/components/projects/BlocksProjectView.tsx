// BlocksProjectView — Spotify-style drill-down hierarchy view for Projects.
// Extracted from Projects.tsx (3594 L) as part of the P1 split refactor.

import type { ReactElement } from "react";
import type { ProjectInfo } from "../../types";
import type { BlocksProjectViewProps, FolderNode } from "./types";
import { countProjects, navigateTo } from "./utils";
import { ProjectCard } from "./ProjectCard";

export function BlocksProjectView({
  root,
  path,
  onPathChange,
  stats,
  openInWorkspace,
  cardOpenFolder,
  cardOpenIde,
  cardOpenAi,
  startEdit,
  setPendingDelete,
}: BlocksProjectViewProps): ReactElement {
  const here = navigateTo(root, path);
  const isRoot = path.length === 0;

  if (root.children.length === 0 && root.projects.length === 0) {
    return (
      <div
        className="rounded p-6 text-center text-[13px]"
        style={{
          background: "var(--color-surface-2)",
          border: "1px dashed var(--color-border-strong)",
          color: "var(--color-text-tertiary)",
        }}
      >
        No projects to display. Add one with "+ New project" above.
      </div>
    );
  }

  const breadcrumb = !isRoot && (
    <nav className="mb-4 flex flex-wrap items-center gap-1.5 text-[12px]" aria-label="Folder breadcrumb">
      <button
        type="button"
        onClick={() => onPathChange([])}
        className="rounded px-2 py-0.5 transition-colors"
        style={{
          background: "var(--color-surface-2)",
          color: "var(--color-text-secondary)",
          border: "1px solid var(--color-border)",
        }}
      >
        All
      </button>
      {path.map((seg, i) => (
        <span key={`${seg}-${i}`} className="flex items-center gap-1.5">
          <span style={{ color: "var(--color-text-faint)" }}>›</span>
          <button
            type="button"
            onClick={() => onPathChange(path.slice(0, i + 1))}
            className="rounded px-2 py-0.5 transition-colors"
            style={{
              background: i === path.length - 1 ? "var(--color-surface-3)" : "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border)",
            }}
          >
            {seg}
          </button>
        </span>
      ))}
    </nav>
  );

  const FolderTile = ({ child }: { child: FolderNode }) => {
    const count = countProjects(child);
    return (
      <button
        type="button"
        onClick={() => onPathChange([...path, child.segment])}
        className="group flex h-[140px] flex-col justify-between rounded-lg p-4 text-left transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border)",
          boxShadow: "inset 0 2px 0 var(--color-border)",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = "var(--color-border-strong)";
          e.currentTarget.style.transform = "translateY(-2px)";
          e.currentTarget.style.boxShadow =
            "inset 0 2px 0 var(--color-accent), 0 4px 14px rgba(0,0,0,0.22)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = "var(--color-border)";
          e.currentTarget.style.transform = "translateY(0)";
          e.currentTarget.style.boxShadow = "inset 0 2px 0 var(--color-border)";
        }}
        title={`${count} project${count === 1 ? "" : "s"} under ${child.fullPath || child.segment}`}
      >
        <div
          className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.06em]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Folder
        </div>
        <div>
          <div
            className="truncate text-[16px] font-semibold leading-tight"
            style={{ color: "var(--color-text)" }}
          >
            {child.segment}
          </div>
          {child.children.length > 0 && (
            <div
              className="mt-1 truncate text-[10.5px]"
              style={{ color: "var(--color-text-tertiary)", fontFamily: "var(--font-mono)" }}
            >
              {child.children.length} sub-folder{child.children.length === 1 ? "" : "s"}
            </div>
          )}
        </div>
        <div className="flex items-end justify-between gap-2">
          <span className="text-[10.5px]" style={{ color: "var(--color-text-faint)" }}>
            Click to drill in
          </span>
          <span
            className="rounded px-2 py-0.5 text-[11.5px] tabular-nums"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border)",
            }}
          >
            {count}
          </span>
        </div>
      </button>
    );
  };

  const renderProjects = (items: ProjectInfo[]) =>
    items.length === 0 ? null : (
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}
      >
        {items.map((p) => (
          <ProjectCard
            key={p.id}
            p={p}
            stats={stats[p.id] ?? null}
            onOpenWorkspace={() => openInWorkspace(p.id, p.name ?? p.id)}
            onOpenFolder={() => void cardOpenFolder(p)}
            onOpenIde={() => void cardOpenIde(p)}
            onOpenAi={() => void cardOpenAi(p)}
            onEdit={() => startEdit(p)}
            onDelete={() => setPendingDelete(p)}
          />
        ))}
      </div>
    );

  return (
    <div>
      {breadcrumb}

      {here.children.length > 0 && (
        <div className="mb-5">
          {here.projects.length > 0 && (
            <div
              className="mb-2 text-[10.5px] uppercase tracking-[0.06em]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Sub-folders
            </div>
          )}
          <div
            className="grid gap-3"
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}
          >
            {here.children.map((c) => (
              <FolderTile key={c.fullPath || c.segment} child={c} />
            ))}
          </div>
        </div>
      )}

      {here.projects.length > 0 && (
        <div>
          {here.children.length > 0 && (
            <div
              className="mb-2 text-[10.5px] uppercase tracking-[0.06em]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Projects in this folder
            </div>
          )}
          {renderProjects(here.projects)}
        </div>
      )}

      {here.children.length === 0 && here.projects.length === 0 && (
        <p className="text-[12.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          This folder is empty.
        </p>
      )}
    </div>
  );
}
