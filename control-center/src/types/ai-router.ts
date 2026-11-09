// ---------------------------------------------------------------------------
// AI Router usage summary (v2.9.3)
// Mirrors `ai_router::ProviderUsageRow` and `ai_router::UsageSummary` in Rust.
// ---------------------------------------------------------------------------

export type ProviderUsageRow = {
  provider_id: string;
  provider_label: string;
  key_env_var: string;
  key_present: boolean;
  key_masked: string | null;
  call_count: number;
  /** Successful calls — para el success-rate del rediseno. */
  success_count: number;
  /** Output tokens acumulados servidos por este proveedor. */
  total_tokens: number;
  latency_ms_avg: number;
  primary_for_zones: string[];
  fallback_for_zones: string[];
  /** Published free-tier daily request limit (RPD). null = no free tier. */
  free_tier_limit: number | null;
  /** Requests sent today (UTC) to this provider's most used model bucket (the quota is per model). */
  free_tier_used_today: number;
  /** % of the daily free tier consumed today. null when no known limit. */
  free_tier_pct: number | null;
};

export type RouterUsageSummary = {
  providers: ProviderUsageRow[];
  /** EMA of per-attempt failures (0.0–1.0); context, not a route-level rate. */
  attempt_failure_rate: number;
  /** Routes the primary did not serve (fallback or failed chain), cumulative. */
  real_fallback_rate: number;
  real_fallback_count: number;
  /** Routes whose whole chain failed (no answer). */
  routes_failed: number;
  route_failure_rate: number;
  routes_total: number;
  /** real_fallback_rate over the last `recent_window` routes: the actionable signal. */
  real_fallback_rate_recent: number;
  route_failure_rate_recent: number;
  recent_window: number;
  /** Per-zone chain: zone_id → [primary_id, fallback1_id, ...] */
  zone_chains: Record<string, string[]>;
};
