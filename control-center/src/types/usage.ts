// Usage (Claude Code stats-cache.json) types.

export type WindowStats = {
  days: number;
  messages: number;
  sessions: number;
  tool_calls: number;
  tokens_total: number;
  tokens_by_model: Record<string, number>;
};

export type ModelStat = {
  name: string;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_create: number;
  total: number;
};

export type DailyPoint = {
  date: string;
  messages: number;
  sessions: number;
  tool_calls: number;
  tokens: number;
};

export type UsageReport = {
  last_computed_date: string | null;
  cache_age_days: number | null;
  first_session_date: string | null;
  total_sessions: number;
  total_messages: number;
  today: WindowStats;
  last_7_days: WindowStats;
  last_30_days: WindowStats;
  model_totals: ModelStat[];
  daily_recent: DailyPoint[];
  hour_counts: number[];
};

// ---------------------------------------------------------------------------
// Plan limits (Anthropic OAuth usage endpoint — see src-tauri/src/plan_limits.rs)
// ---------------------------------------------------------------------------

export type PlanWindow = {
  utilization: number;
  resets_at: string | null;
};

export type PlanScopedLimit = {
  kind: string;
  group: string;
  percent: number;
  severity: string;
  resets_at: string | null;
  scope_label: string | null;
  is_active: boolean;
};

export type BreakdownRow = {
  key: string;
  display_name: string;
  percent: number;
};

export type PlanLimits = {
  subscription_type: string | null;
  five_hour: PlanWindow | null;
  seven_day: PlanWindow | null;
  limits: PlanScopedLimit[];
  breakdown: BreakdownRow[];
  breakdown_as_of: string | null;
  extra_usage_enabled: boolean;
  fetched_at: number;
  stale: boolean;
};
