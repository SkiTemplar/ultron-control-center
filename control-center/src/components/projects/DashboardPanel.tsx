// DashboardPanel — generic collapsible panel for the project dashboard v2
// (card-ux-projects-dashboard-minimalista). Pure wrapper: title bar with a
// collapse chevron + an optional right-aligned actions slot (where contextual
// buttons like "Run Batch" / "Open IDE" live, card-ux-projects-move-buttons) +
// a body that fills the remaining space and owns its own scroll.
//
// min-w-0 + overflow-hidden throughout so a panel's content never drives the
// layout width (lesson from card-ux-workdays-responsive).

import type { ReactNode } from "react";

interface DashboardPanelProps {
  title: string;
  /** Right-aligned contextual actions (buttons, badges). */
  actions?: ReactNode;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  children: ReactNode;
  /** When true, the body scrolls; when false it clips (e.g. terminal owns it). */
  scrollBody?: boolean;
}

export function DashboardPanel({
  title,
  actions,
  collapsed,
  onToggleCollapsed,
  children,
  scrollBody = true,
}: DashboardPanelProps) {
  return (
    <section
      className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <header
        className="flex items-center justify-between gap-2 border-b px-3 py-1.5"
        style={{ borderColor: "var(--color-border)" }}
      >
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="flex min-w-0 items-center gap-1.5 text-left"
          title={collapsed ? "Expandir" : "Colapsar"}
          aria-expanded={!collapsed}
        >
          <span
            className="inline-block w-3 shrink-0 text-[10px] transition-transform"
            style={{
              color: "var(--color-text-tertiary)",
              transform: collapsed ? "rotate(-90deg)" : "none",
            }}
          >
            ▾
          </span>
          <span
            className="truncate text-[12px] font-semibold"
            style={{ color: "var(--color-text)" }}
          >
            {title}
          </span>
        </button>
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </header>
      {!collapsed && (
        <div
          className={`min-h-0 min-w-0 flex-1 ${scrollBody ? "overflow-auto" : "overflow-hidden"}`}
        >
          {children}
        </div>
      )}
    </section>
  );
}
