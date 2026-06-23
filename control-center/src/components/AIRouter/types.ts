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

/**
 * @deprecated No longer used by the UI. ZoneEditor and AIRouterIndex now
 * derive model lists from the `models` field of each Provider returned by
 * `ai_router_list_providers`. Kept here only as a static fallback reference;
 * do NOT import this in new code.
 */
export const PROVIDER_MODELS: Record<
  string,
  { id: string; label: string; task_class: ProviderClass }[]
> = {
  anthropic: [
    { id: "claude-opus-4-7", label: "Opus 4.7 · best quality", task_class: "heavy" },
    { id: "claude-sonnet-4-6", label: "Sonnet 4.6 · balanced", task_class: "medium" },
    { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5 · fast", task_class: "trivial" },
  ],
  codex: [
    { id: "gpt-5.5", label: "GPT-5.5", task_class: "heavy" },
    { id: "gpt-5.5-thinking", label: "GPT-5.5 Thinking", task_class: "heavy" },
    { id: "gpt-4.1-mini", label: "GPT-4.1 Mini", task_class: "light" },
  ],
  gemini: [
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", task_class: "heavy" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", task_class: "light" },
    { id: "gemini-2.5-flash-lite", label: "Flash Lite", task_class: "trivial" },
  ],
  groq: [
    { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", task_class: "light" },
    { id: "llama-3.3-8b-instant", label: "Llama 3.3 8B", task_class: "trivial" },
  ],
  ollama: [
    { id: "qwen2.5-coder:7b", label: "Qwen2.5-Coder 7B", task_class: "light" },
    { id: "qwen2.5-coder:32b", label: "Qwen2.5-Coder 32B", task_class: "medium" },
    { id: "deepseek-coder-v2:16b", label: "DeepSeek-Coder V2 16B", task_class: "medium" },
  ],
  cerebras: [
    { id: "llama-4-scout-17b-16e", label: "Llama 4 Scout 17B", task_class: "trivial" },
    { id: "llama-3.3-70b", label: "Llama 3.3 70B", task_class: "light" },
  ],
};

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

export interface RouterMetrics {
  /** Tokens de salida acumulados del proveedor fallback barato (no = ahorro de contexto). */
  fallback_output_tokens: number;
  cost_saved_usd: number;
  by_class: Record<string, ClassMetrics>;
  /**
   * @deprecated Nombre legacy — puede seguir presente en versiones antiguas del backend.
   * Usar real_fallback_rate para la métrica honesta o attempt_failure_rate para EMA de intentos.
   */
  fallback_rate?: number;
  /** EMA de fallo por intento (nombre correcto del backend). */
  attempt_failure_rate?: number;
  /** Fracción de rutas que cayeron a secundario (0.0..=1.0). */
  real_fallback_rate?: number;
  /** Contador absoluto de rutas con fallback ganador. */
  real_fallback_count?: number;
  /** Total de invocaciones de route() completadas. */
  routes_total?: number;
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

// ---------------------------------------------------------------------------
// Default zone catalog (shown when the backend command is unavailable)
// ---------------------------------------------------------------------------

export const DEFAULT_ZONES: Zone[] = [
  {
    id: "usage.refresh_with_claude",
    label: "Refresh Usage Stats",
    category: "usage",

    primary: { provider_id: "anthropic", model: "claude-sonnet-4-6", max_tokens: 0 },
    fallbacks: [{ provider_id: "gemini", model: "gemini-2.5-flash", max_tokens: 0 }],
  },
  {
    id: "usage.analyse",
    label: "Analyse Usage Patterns",
    category: "usage",

    primary: { provider_id: "anthropic", model: "claude-sonnet-4-6", max_tokens: 0 },
    fallbacks: [{ provider_id: "codex", model: "gpt-5.5", max_tokens: 0 }],
  },
  {
    id: "news.generate_with_ai",
    label: "Generate News Summary",
    category: "news",

    primary: { provider_id: "gemini", model: "gemini-2.5-flash", max_tokens: 0 },
    fallbacks: [{ provider_id: "anthropic", model: "claude-haiku-4-5-20251001", max_tokens: 0 }],
  },
  {
    id: "memory.consolidate",
    label: "Consolidate Memory",
    category: "memory",

    primary: { provider_id: "anthropic", model: "claude-sonnet-4-6", max_tokens: 0 },
    fallbacks: [],
  },
  {
    id: "memory.kg_extract",
    label: "Extract Knowledge Graph",
    category: "memory",

    primary: { provider_id: "anthropic", model: "claude-sonnet-4-6", max_tokens: 0 },
    fallbacks: [{ provider_id: "ollama", model: "qwen2.5-coder:32b", max_tokens: 0 }],
  },
  {
    id: "notifications.fix_one",
    label: "Fix Single Alert",
    category: "notifications",

    primary: { provider_id: "anthropic", model: "claude-sonnet-4-6", max_tokens: 0 },
    fallbacks: [{ provider_id: "codex", model: "gpt-5.5", max_tokens: 0 }],
  },
  {
    id: "notifications.fix_all",
    label: "Bulk Fix Alerts",
    category: "notifications",

    primary: { provider_id: "anthropic", model: "claude-opus-4-7", max_tokens: 0 },
    fallbacks: [{ provider_id: "codex", model: "gpt-5.5", max_tokens: 0 }],
  },
  {
    id: "plans.sprint_ai",
    label: "AI Sprint Planning",
    category: "plans",

    primary: { provider_id: "anthropic", model: "claude-opus-4-7", max_tokens: 0 },
    fallbacks: [{ provider_id: "gemini", model: "gemini-2.5-pro", max_tokens: 0 }],
  },
  {
    id: "mcps.add_with_ai",
    label: "Register MCP with AI",
    category: "mcps",

    primary: { provider_id: "anthropic", model: "claude-sonnet-4-6", max_tokens: 0 },
    fallbacks: [],
  },
  {
    id: "code.explain",
    label: "Explain Code",
    category: "code",

    primary: { provider_id: "groq", model: "llama-3.3-70b-versatile", max_tokens: 0 },
    fallbacks: [{ provider_id: "anthropic", model: "claude-haiku-4-5-20251001", max_tokens: 0 }],
  },
  {
    id: "code.review",
    label: "Review Code",
    category: "code",

    primary: { provider_id: "anthropic", model: "claude-sonnet-4-6", max_tokens: 0 },
    fallbacks: [{ provider_id: "codex", model: "gpt-5.5", max_tokens: 0 }],
  },
  {
    id: "system.diagnose",
    label: "Diagnose System",
    category: "system",

    primary: { provider_id: "anthropic", model: "claude-opus-4-7", max_tokens: 0 },
    fallbacks: [{ provider_id: "codex", model: "gpt-5.5", max_tokens: 0 }],
  },
];
