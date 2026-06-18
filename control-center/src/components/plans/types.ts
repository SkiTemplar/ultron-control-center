// Shared types and constants for the Plans feature module.
// Extracted from Plans.tsx as part of the cat7 split refactor.

export type PlanItem = {
  id: string;
  title: string;
  kind: string;
  status: string;
  priority: string;
  description: string | null;
  tags: string[];
  spec_path: string | null;
  created_at: string | null;
  resolved_at: string | null;
  effort_hours: number[] | null;
};

export type PlansReport = {
  items: PlanItem[];
  updated_at: string | null;
};

export type PlanFormState = {
  id: string | null;
  title: string;
  priority: string;
  kind: string;
  description: string;
  tags: string;
};

export const COLUMNS: { key: string; label: string; tint: string }[] = [
  { key: "open", label: "Open", tint: "var(--color-text-secondary)" },
  { key: "in_progress", label: "In progress", tint: "var(--color-warn)" },
  { key: "revision", label: "Revision", tint: "#a875ff" },
  { key: "blocked", label: "Blocked", tint: "var(--color-danger)" },
  { key: "resolved", label: "Resolved", tint: "var(--color-success)" },
  { key: "rejected", label: "Rejected", tint: "var(--color-text-tertiary)" },
];

// Bottom-row kanban lanes — exception / terminal states
// (revision / blocked / rejected). `merged` is intentionally NOT a column:
// merged plans shipped already, so they route to the "Archived" drawer
// (see `archivedItems`) where they stay findable without inflating the
// open/total counts on the board.
export const BOTTOM_COLUMNS = ["revision", "blocked", "rejected"];

// Terminal statuses that drop off the kanban and surface in the "Archived"
// drawer instead. `archived` is the auto-archive target for stale resolved
// plans; `merged` is a plan that already shipped via merge.
export const ARCHIVED_STATUSES = new Set(["archived", "merged"]);

export const PRIORITY_OPTIONS = ["p0", "p1", "p2", "p3", "p4"];
export const KIND_OPTIONS = ["task", "sprint", "patch", "bug", "feature", "refactor", "polish", "research", "audit"];

export const EMPTY_FORM: PlanFormState = {
  id: null,
  title: "",
  priority: "p3",
  kind: "task",
  description: "",
  tags: "",
};
