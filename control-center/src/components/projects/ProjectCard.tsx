// ProjectCard — home-grid card for a single project.
// Extracted from Projects.tsx (3594 L) as part of the P1 split refactor.

import type { ProjectInfo, SessionProvider } from "../../types";
import type { CardStats } from "./types";
import { statusBadge, providerBadge } from "./utils";
import { ProjectQuickActions } from "./ProjectQuickActions";

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
  onEdit: () => void;
  onDelete: () => void;
}

export function ProjectCard({
  p,
  stats,
  onOpenWorkspace,
  onOpenFolder: _onOpenFolder,
  onOpenIde: _onOpenIde,
  onOpenAi: _onOpenAi,
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
          {/* El "+" de crear proyecto ya no vive en cada tarjeta: se crea desde
              las session cards (esquina) o el CTA global del header. */}
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

      {/* Acciones rápidas — fuente única ProjectQuickActions */}
      <div className="mt-auto" onClick={(e) => e.stopPropagation()}>
        <ProjectQuickActions project={p} density="compact" showBatch={false} />
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
