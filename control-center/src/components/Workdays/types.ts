// Workdays - tipos compartidos entre todos los sub-componentes.
// Shapes alineadas con el backend (src-tauri/src/workdays.rs, v2.8 automatic).
//
// Notas:
//   - WorkdayStatus y GoalStatus usan rename_all = "snake_case" en Rust.
//   - Timestamps son strings ("epoch:1234567890"), NO numbers.
//   - GoalStatus tiene un enum (pending/done/skipped) en lugar de boolean.
//   - El nuevo modelo es AUTOMATICO: sessions / kanban moves crean y
//     alimentan el workday sin intervencion manual.

export type WorkdayStatus =
  | "planned"
  | "in_progress"
  | "paused"
  | "completed"
  | "archived";

export type GoalStatus = "pending" | "done" | "skipped";

export interface WorkdayGoal {
  id: string;
  text: string;
  status: GoalStatus;
}

export interface WorkdayContextEntry {
  id: string;
  kind: string;
  text: string;
  source?: string;
  created_at: string;
}

export interface WorkdayContext {
  notes: WorkdayContextEntry[];
  decisions: WorkdayContextEntry[];
  file_changes: WorkdayContextEntry[];
  agent_messages: WorkdayContextEntry[];
}

export interface Workday {
  id: string;
  template_id?: string;
  workflow_template?: string;
  project_id?: string;
  project_cwd?: string;
  title: string;
  status: WorkdayStatus;
  planned_date: string;
  start_ts?: string;
  end_ts?: string;
  focus_seconds: number;
  break_seconds: number;
  energy_before?: number;
  energy_after?: number;
  mood_note?: string;
  retro_good?: string;
  retro_bad?: string;
  retro_learned?: string;
  summary_md?: string;
  goals: WorkdayGoal[];
  linked_sessions: string[];
  linked_tasks: string[];
  context: WorkdayContext;
  created_at: string;
}

export interface WorkdayTemplate {
  id: string;
  name: string;
  default_title?: string;
  default_goals: string[];
  notes?: string;
  created_at: string;
  updated_at: string;
}

export interface WorkdayMetrics {
  id: string;
  title: string;
  status: WorkdayStatus;
  planned_date: string;
  focus_minutes: number;
  break_minutes: number;
  total_goals: number;
  completed_goals: number;
  linked_sessions: number;
  linked_tasks: number;
}

export interface WorkdayTodayView {
  date: string;
  active: Workday | null;
  other_today: Workday[];
}

// Workflow templates -- 7 hardcoded orchestrator presets that drive the
// automatic workday surface. Each template ships an agent sequence and a
// prompt skeleton seeded into the workday's shared context.
export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  agent_slugs: string[];
  prompt_skeleton: string;
}
