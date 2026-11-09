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
  /** Motivo cuando el run acabó en failed/killed; ausente en runs antiguos. */
  error?: string | null;
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

export type OpenTab = {
  id: string;        // "home" | project_id
  kind: "home" | "project";
  title: string;
  order: number;
};
