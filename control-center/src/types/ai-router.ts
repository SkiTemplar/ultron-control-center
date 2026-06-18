// ---------------------------------------------------------------------------
// AI Router usage summary (v2.9.3)
// Mirrors `ai_router::ProviderUsageRow` and `ai_router::UsageSummary` in Rust.
// ---------------------------------------------------------------------------

/** How a provider authenticates. CLI providers use "cli-installed" or
 *  "cli-missing" instead of the API-key sources "env" / "none" / "local". */
export type ProviderKeySource =
  | "env"
  | "local"
  | "none"
  | "cli-installed"
  | "cli-missing";

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
  /** Requests routed to this provider today (UTC). */
  free_tier_used_today: number;
  /** % of the daily free tier consumed today. null when no known limit. */
  free_tier_pct: number | null;
};

export type RouterUsageSummary = {
  providers: ProviderUsageRow[];
  /** Global EMA fallback rate across all routes (0.0–1.0). */
  fallback_rate: number;
  /** Per-zone chain: zone_id → [primary_id, fallback1_id, ...] */
  zone_chains: Record<string, string[]>;
};
