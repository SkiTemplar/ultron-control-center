// ---- P4: Kanban + tabs ----

export type RunStatus =
  | { kind: "running" }
  | { kind: "completed" }
  | { kind: "killed" }
  | { kind: "failed" };

export type CardRun = {
  session_id: string;
  started_at: string;
  ended_at: string | null;
  status: RunStatus;
  exit_code: number | null;
};

export type Card = {
  id: string;
  column_id: string;
  title: string;
  description: string;
  agent: string | null;
  prompt_template: string | null;
  cwd: string | null;
  tags: string[];
  order: number;
  created_at: string;
  updated_at: string;
  runs: CardRun[];
};

export type ColumnRole = "todo" | "doing" | "blocked" | "done" | "other";

export type Column = {
  id: string;
  name: string;
  order: number;
  role: ColumnRole;
};

export type KanbanBoard = {
  project_id: string;
  columns: Column[];
  cards: Card[];
  default_agent: string | null;
  default_prompt_template: string | null;
  schema_version: number;
};

export type CardPartial = {
  title: string;
  description?: string;
  agent?: string | null;
  prompt_template?: string | null;
  cwd?: string | null;
  tags?: string[];
};

export type CardPatch = {
  title?: string;
  description?: string;
  agent?: string | null;
  prompt_template?: string | null;
  cwd?: string | null;
  tags?: string[];
};

export type OpenTab = {
  id: string;        // "home" | project_id
  kind: "home" | "project";
  title: string;
  order: number;
};

// V1 redesign: the per-project workspace is a flat button row + Kanban board.
// The sub-tab union collapsed to the single remaining view.
export type ProjectSubTab = "board";
