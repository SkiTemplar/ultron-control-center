// ColumnActions — per-column action bar for the Plans kanban.
// Each lane owns 0..N buttons that only make sense for items in that column.
// Extracted from Plans.tsx as part of the cat7 split refactor.

import { type CSSProperties, type ReactElement } from "react";
import { useRoutingTitle } from "../../lib/button-prompts";

// v2.x slim: per-tab stats strip removed. The Plans tab is intentionally
// minimal — the user asked for the kanban board only, no rolled-up counts.
// The per-status counts that the UI still needs (resolvedCount for the
// archive button) are computed inline in <Plans />.

// Per-column action bar. Each kanban column owns 0..N buttons that only
// make sense for items in that lane. Centralising the switch here keeps
// the column-rendering JSX in <Plans /> readable.
export function ColumnActions(props: {
  column: string;
  onNew: () => void;
  onSprintAi: () => void;
  sprintAiBusy: boolean;
  onExecute: () => void;
  onReview: () => void;
  onResolveBlock: () => void;
  onArchiveSelected: () => void;
  archiveDisabled: boolean;
  archiveCount: number;
}) {
  const baseBtn =
    "rounded px-2 py-1 text-[10.5px] font-medium transition-colors disabled:opacity-40";
  const accent: CSSProperties = {
    background: "var(--color-accent)",
    color: "var(--color-accent-text)",
  };
  const subtle: CSSProperties = {
    background: "var(--color-surface-3)",
    color: "var(--color-text-secondary)",
    border: "1px solid var(--color-border)",
  };

  // Routing destination per AI button — each catalog key resolves through
  // the AI Router so the user can see provider/model before clicking.
  const sprintTitle = useRoutingTitle(
    "plans.sprint_ai",
    "Generate an actionable sprint proposal from the current open plans and rewrite/improve the ones added by hand.",
  );
  const executeTitle = useRoutingTitle(
    "plans.execute",
    "Launch an AI session to execute the open plans in priority order.",
  );
  const reviewTitle = useRoutingTitle(
    "plans.review",
    "Launch an AI session for an adversarial review of the plans in revision.",
  );
  const resolveBlockTitle = useRoutingTitle(
    "plans.resolve_in_progress",
    "Launch an AI session to unblock the plan: reads description + spec, proposes an unstuck path.",
  );

  let buttons: ReactElement[] = [];
  switch (props.column) {
    case "open":
      buttons = [
        <button
          key="new"
          type="button"
          onClick={props.onNew}
          className={baseBtn}
          style={subtle}
          title="Create an empty plan manually (modal with title / priority / kind / tags / description)."
        >
          New Plan
        </button>,
        <button
          key="sprint"
          type="button"
          onClick={props.onSprintAi}
          disabled={props.sprintAiBusy}
          className={baseBtn}
          style={accent}
          title={sprintTitle}
        >
          {props.sprintAiBusy ? "Opening..." : "Sprint AI"}
        </button>,
      ];
      break;
    case "in_progress":
      buttons = [
        <button
          key="exec"
          type="button"
          onClick={props.onExecute}
          className={baseBtn}
          style={accent}
          title={executeTitle}
        >
          Execute
        </button>,
      ];
      break;
    case "revision":
      buttons = [
        <button
          key="review"
          type="button"
          onClick={props.onReview}
          className={baseBtn}
          style={accent}
          title={reviewTitle}
        >
          AI Review
        </button>,
      ];
      break;
    case "blocked":
      buttons = [
        <button
          key="resolve"
          type="button"
          onClick={props.onResolveBlock}
          className={baseBtn}
          style={subtle}
          title={resolveBlockTitle}
        >
          Resolve block
        </button>,
      ];
      break;
    case "resolved":
      buttons = [
        <button
          key="archive"
          type="button"
          onClick={props.onArchiveSelected}
          disabled={props.archiveDisabled}
          className={baseBtn}
          style={subtle}
          title="Move all resolved plans to plans/_archive/resolved-YYYY-MM.json (atomic, non-destructive)."
        >
          Archive selected ({props.archiveCount})
        </button>,
      ];
      break;
  }

  if (buttons.length === 0) return null;
  return (
    <div
      className="flex flex-wrap gap-1 border-b px-2 py-1.5"
      style={{ borderColor: "var(--color-border)" }}
    >
      {buttons}
    </div>
  );
}
