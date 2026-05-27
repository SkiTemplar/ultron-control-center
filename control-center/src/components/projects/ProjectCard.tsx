// ProjectCard — home-grid card for a single project.
// Extracted from Projects.tsx (3594 L) as part of the P1 split refactor.

import type { ReactElement } from "react";
import type { ProjectInfo, SessionProvider } from "../../types";
import type { CardStats } from "./types";
import { statusBadge, providerBadge } from "./utils";
import {
  CardIconFolder,
  CardIconIde,
  CardIconSpark,
  CardIconTerminal,
} from "./LauncherIcons";

// ---------------------------------------------------------------------------
// Internal ActionButton
// ---------------------------------------------------------------------------

function ActionButton({
  onClick,
  title,
  label,
  Icon,
  accent,
  disabled,
}: {
  onClick: () => void;
  title: string;
  label: string;
  Icon: () => ReactElement;
  accent?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onClick();
      }}
      title={title}
      className="group/btn flex h-9 flex-1 items-center justify-center gap-1.5 rounded text-[11.5px] font-medium transition-colors disabled:opacity-40"
      style={{
        background: "var(--color-surface-1)",
        color: accent ?? "var(--color-text)",
        border: "1px solid var(--color-border-strong)",
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = "var(--color-surface-3)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "var(--color-surface-1)";
      }}
    >
      <Icon />
      <span className="hidden md:inline">{label}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// ProjectCard
// ---------------------------------------------------------------------------

export interface ProjectCardProps {
  p: ProjectInfo;
  stats: CardStats | null;
  onOpenWorkspace: () => void;
  onOpenFolder: () => void;
  onOpenIde: () => void;
  onOpenAi: () => void;
  onOpenTerminal: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export function ProjectCard({
  p,
  stats,
  onOpenWorkspace,
  onOpenFolder,
  onOpenIde,
  onOpenAi,
  onOpenTerminal,
  onEdit,
  onDelete,
}: ProjectCardProps) {
  const b = statusBadge(p.status);
  const provider: SessionProvider =
    (p.default_provider as SessionProvider | null | undefined) ?? "claude";
  const badge = providerBadge(provider);

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpenWorkspace}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpenWorkspace();
        }
      }}
      className="proj-card group relative flex cursor-pointer flex-col gap-3 rounded-lg p-4 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
        minHeight: 168,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "var(--color-border-strong)";
        e.currentTarget.style.transform = "translateY(-1px)";
        e.currentTarget.style.boxShadow = "0 4px 12px rgba(0,0,0,0.18)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--color-border)";
        e.currentTarget.style.transform = "translateY(0)";
        e.currentTarget.style.boxShadow = "none";
      }}
    >
      {/* Header row: status pill + name + edit/delete */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className="rounded px-1.5 py-px text-[9.5px] font-medium uppercase tracking-wide"
              style={{ background: b.bg, color: b.color }}
            >
              {b.label}
            </span>
            {p.language && (
              <span className="text-[10.5px]" style={{ color: "var(--color-text-faint)" }}>
                {p.language}
              </span>
            )}
            <span
              className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-px text-[9.5px] font-medium"
              style={{
                background: "var(--color-surface-1)",
                color: badge.tint,
                border: `1px solid ${badge.tint}33`,
              }}
              title={`Default AI provider: ${badge.label}`}
            >
              <span
                aria-hidden
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: badge.tint }}
              />
              {badge.label}
            </span>
          </div>
          <div
            className="mt-2 truncate text-[14px] font-semibold leading-tight"
            style={{ color: "var(--color-text)" }}
            title={p.name ?? p.id}
          >
            {p.name ?? p.id}
          </div>
          {p.path && (
            <div
              className="mt-0.5 truncate text-[10.5px]"
              style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-tertiary)" }}
              title={p.path}
            >
              {p.path}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1" onClick={stop}>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
            className="rounded px-1.5 py-0.5 text-[10px] transition-colors"
            style={{
              background: "transparent",
              color: "var(--color-text-tertiary)",
              border: "1px solid var(--color-border)",
            }}
            title="Edit project metadata"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="rounded px-1.5 py-0.5 text-[10px] transition-colors"
            style={{
              background: "transparent",
              color: "var(--color-danger)",
              border: "1px solid rgba(248, 81, 73, 0.32)",
            }}
            title="Remove from registry (no files touched)"
          >
            ×
          </button>
        </div>
      </div>

      {/* Tag chips */}
      {p.tags.length > 0 && (
        <div className="flex flex-wrap gap-1" onClick={stop}>
          {p.tags.slice(0, 6).map((t) => (
            <span
              key={t}
              className="rounded px-1.5 py-px text-[9.5px]"
              style={{
                background: "var(--color-surface-1)",
                color: "var(--color-text-tertiary)",
                border: "1px solid var(--color-border)",
              }}
            >
              {t}
            </span>
          ))}
          {p.tags.length > 6 && (
            <span className="text-[9.5px]" style={{ color: "var(--color-text-faint)" }}>
              +{p.tags.length - 6}
            </span>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className="mt-auto flex items-center gap-1.5">
        <ActionButton
          onClick={onOpenFolder}
          disabled={!p.path}
          title={p.path ? `Open ${p.path} in Explorer` : "No path configured"}
          label="Folder"
          Icon={CardIconFolder}
        />
        <ActionButton
          onClick={onOpenIde}
          disabled={!p.path}
          title={p.path ? `Open in ${p.ide ?? "preferred IDE"}` : "No path configured"}
          label="IDE"
          Icon={CardIconIde}
        />
        <ActionButton
          onClick={onOpenAi}
          title={`Spawn ${badge.label} session in CC terminal`}
          label={badge.label}
          accent={badge.tint}
          Icon={CardIconSpark}
        />
        <ActionButton
          onClick={onOpenTerminal}
          title="Open project workspace on the Terminal tab"
          label="Terminal"
          Icon={CardIconTerminal}
        />
      </div>

      {/* Status row */}
      <div
        className="flex items-center justify-between border-t pt-2 text-[10.5px]"
        style={{ borderColor: "var(--color-border)", color: "var(--color-text-tertiary)" }}
      >
        <div className="flex items-center gap-3">
          <span title="Pending kanban cards (everything outside Done / Complete)">
            <span className="tabular-nums" style={{ color: "var(--color-text-secondary)" }}>
              {stats?.pending ?? "—"}
            </span>{" "}
            pending
          </span>
          <span title="Active terminals running for this project right now">
            <span
              className="tabular-nums"
              style={{
                color:
                  stats && stats.sessions && stats.sessions > 0
                    ? "var(--color-success)"
                    : "var(--color-text-secondary)",
              }}
            >
              {stats?.sessions ?? "—"}
            </span>{" "}
            live
          </span>
        </div>
        {p.last_active && (
          <span className="tabular-nums" style={{ color: "var(--color-text-faint)" }}>
            {p.last_active}
          </span>
        )}
      </div>
    </div>
  );
}
