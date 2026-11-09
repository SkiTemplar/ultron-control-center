// ULTRON Control Center — AI Router shared TypeScript types
//
// These mirror the Rust structs in the src-tauri/src/ai_router/ module.
// Keep this file in sync with the backend whenever types evolve.

// ---------------------------------------------------------------------------
// Provider class taxonomy
// ---------------------------------------------------------------------------

/**
 * Computational weight class of an AI task.
 *
 *  trivial  — grep/format/simple lookup         -> Haiku 4.5 / Groq Llama
 *  light    — summarise, short generation        -> Sonnet 4.6 / Gemini Flash
 *  medium   — multi-file edit, agent planning    -> Sonnet 4.6 / Codex CLI
 *  heavy    — complex reasoning, full refactor   -> Opus 4.7 / Gemini Pro
 */
export type ProviderClass = "trivial" | "light" | "medium" | "heavy";

// ---------------------------------------------------------------------------
// Provider catalog
// ---------------------------------------------------------------------------

export interface Provider {
  /** Stable identifier used in zone assignments (e.g. "anthropic", "codex"). */
  id: string;
  /** Human-readable name shown in the UI. */
  name: string;
  /** Approximate cost in USD per million output tokens (for display only). */
  cost_per_mtok: number;
  /** Which task classes this provider can handle. */
  supports: ProviderClass[];
  /** Whether the API key has been configured for this provider. */
  api_key_status: "configured" | "missing" | "placeholder";
  /** Optional override for the health-check endpoint URL. */
  health_endpoint?: string;
  /**
   * Model identifiers available under this provider.
   * Present when the record comes from the backend (ai_router_list_providers).
   * Absent in the static fallback catalog.
   */
  models?: string[];
}

/**
 * Static fallback catalog. Used only when `ai_router_list_providers` is
 * unavailable (backend not yet compiled or command missing). Live data
 * comes from the backend — do NOT rely on these values for real api_key_status
 * or cost figures.
 */
export const PROVIDER_CATALOG: Provider[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    cost_per_mtok: 15.0,
    supports: ["trivial", "light", "medium", "heavy"],
    api_key_status: "configured",
  },
  {
    id: "codex",
    name: "OpenAI Codex CLI",
    cost_per_mtok: 10.0,
    supports: ["light", "medium", "heavy"],
    api_key_status: "configured",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    cost_per_mtok: 3.5,
    supports: ["trivial", "light", "medium", "heavy"],
    api_key_status: "configured",
  },
  {
    id: "groq",
    name: "Groq Llama 3.3",
    cost_per_mtok: 0.59,
    supports: ["trivial", "light"],
    api_key_status: "missing",
  },
  {
    id: "ollama",
    name: "Ollama (local)",
    cost_per_mtok: 0.0,
    supports: ["trivial", "light", "medium"],
    api_key_status: "configured",
  },
  {
    id: "cerebras",
    name: "Cerebras",
    cost_per_mtok: 0.6,
    supports: ["trivial", "light"],
    api_key_status: "missing",
  },
];

// ---------------------------------------------------------------------------
// Zone assignment
// ---------------------------------------------------------------------------

export interface ZoneAssignment {
  provider_id: string;
  model: string;
  /** Maximum tokens the provider should generate (0 = provider default). */
  max_tokens: number;
}

export interface Zone {
  /** Stable dot-namespaced key, e.g. "usage.refresh_with_claude". */
  id: string;
  /** Human-readable label for the UI. */
  label: string;
  /** Top-level category derived from the id prefix. */
  category: string;
  /** Primary provider/model assignment. */
  primary: ZoneAssignment;
  /**
   * Ordered fallback chain (tried in sequence when the primary fails).
   * Up to 3 entries recommended.
   */
  fallbacks: ZoneAssignment[];
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface ClassMetrics {
  count: number;
  tokens: number;
  latency_p95_ms: number;
  /** Successful calls (outcome.is_ok()). */
  success_count?: number;
  /** ISO date (YYYY-MM-DD, UTC) these counters belong to — entries reset daily. */
  date?: string;
}

/** Per-model metrics — key del mapa = "provider_id::model". */
export interface ModelMetrics {
  provider_id: string;
  model: string;
  count: number;
  success_count: number;
  output_tokens: number;
  latency_ms_avg: number;
  /** p50 (median) latency in ms, derived from the backend histogram. */
  latency_p50_ms?: number;
  /** p95 latency in ms, derived from the backend histogram. */
  latency_p95_ms?: number;
}

export type RouteOutcome = "primary" | "fallback" | "failed";

export interface RouterMetrics {
  /** Tokens de salida acumulados del proveedor fallback barato (no = ahorro de contexto). */
  fallback_output_tokens: number;
  cost_saved_usd: number;
  by_class: Record<string, ClassMetrics>;
  /** EMA de fallo por INTENTO (nombre histórico en metrics.json); no es una tasa por ruta. */
  fallback_rate?: number;
  /** Contador absoluto de rutas con fallback ganador. */
  real_fallback_count?: number;
  /** Rutas con la cadena agotada (sin respuesta). */
  routes_failed?: number;
  /** Total de llamadas a route(), fallidas incluidas. */
  routes_total?: number;
  /** Desenlace de las últimas rutas (ventana RECENT_FALLBACK_WINDOW del backend). */
  recent_outcomes?: RouteOutcome[];
  /** Intentos fallidos por motivo (rate_limit, overloaded, timeout, error). */
  fail_reasons?: Record<string, number>;
  /** Métricas reales por modelo concreto (rediseño funcional 2026-05-30). */
  by_model?: Record<string, ModelMetrics>;
}

// ---------------------------------------------------------------------------
// Test result
// ---------------------------------------------------------------------------

export interface TestResult {
  ok: boolean;
  provider_id: string;
  model: string;
  latency_ms: number;
  response_excerpt: string;
  error?: string;
}
