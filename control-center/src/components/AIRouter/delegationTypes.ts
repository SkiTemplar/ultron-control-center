// ULTRON Control Center — AI Router: tipos del delegador multi-motor.
//
// Espejo del contrato docs/delegacion-contrato.md:
//   §1 cockpit/ai-router/delegation.json  -> DelegationConfig
//   §2 cockpit/delegations.jsonl          -> LedgerEntry
//   §3 delegate.mjs status --json         -> DelegationStatus
// Los nombres de campo van en camelCase porque así los define el contrato.

export const DELEGATION_TIERS = ["complex", "standard", "trivial"] as const;
export type DelegationTier = (typeof DELEGATION_TIERS)[number];

export const TIER_LABELS: Record<DelegationTier, string> = {
  complex: "Compleja",
  standard: "Estándar",
  trivial: "Trivial",
};

export const DELEGATION_RUNNERS = ["codex", "agy", "opencode", "claude"] as const;
export type DelegationRunner = (typeof DELEGATION_RUNNERS)[number];

export interface DelegationEngine {
  runner: DelegationRunner;
  /** Modelo en el formato del runner (OpenCode: `proveedor/modelo`). */
  model: string;
  /** Modelo por nivel; un nivel ausente usa `model`. */
  tierModels?: Partial<Record<DelegationTier, string>>;
  /** Variable con la key; si está vacía el motor se salta (missing-key). */
  keyEnv?: string;
  /** Tope de gasto por intento (`--max-budget-usd`); solo runner `claude`. */
  maxBudgetUsd?: number;
  enabled: boolean;
}

export interface DelegationConfig {
  version: number;
  /** Orden de relevo; da la vuelta hasta probar todos. */
  chain: string[];
  tiers: Record<DelegationTier, { start: string }>;
  relayOnCheckFail: boolean;
  engines: Record<string, DelegationEngine>;
}

export interface EngineQuota {
  usedPct: number;
  window: string;
}

export interface EngineBalance {
  currency: string;
  total: string;
  available: boolean;
}

export interface EngineStatus {
  id: string;
  runner: DelegationRunner | string;
  model: string;
  enabled: boolean;
  installed: boolean;
  /** null = el motor no usa key (CLI con suscripción). */
  keyPresent: boolean | null;
  quota: EngineQuota | null;
  balance: EngineBalance | null;
  available: boolean;
  reason: string | null;
}

export interface DelegationStatus {
  chain: string[];
  engines: EngineStatus[];
  configSource: "file" | "default";
}

export type LedgerOutcome =
  | "ok"
  | "check-fail"
  | "engine-fail"
  | "no-changes"
  | "timeout"
  | "skipped";

/**
 * Una línea del ledger. Las de intento llevan `attempt`/`engine`/`outcome`;
 * las de desenlace solo `ts`, `id` y `final`. Un único tipo con opcionales
 * porque el backend devuelve ambas en el mismo vector.
 */
export interface LedgerEntry {
  ts: string;
  id: string;
  attempt?: number;
  engine?: string;
  runner?: string;
  model?: string;
  tier?: DelegationTier | string;
  outcome?: LedgerOutcome | string;
  skipReason?: string | null;
  durationS?: number | null;
  checkOk?: boolean | null;
  filesChanged?: number | null;
  /** Coste del intento en USD (runner claude: `total_cost_usd`); null si no aplica. */
  costUsd?: number | null;
  branch?: string | null;
  title?: string | null;
  repo?: string | null;
  /** Motivo del desenlace (`scope`, `check`, `tree-changed`, `isolation`, `isolation-suspect`, `auth`…). */
  reason?: string | null;
  /** Entradas del checkout principal que cambiaron sin poder atribuirlas al motor. */
  isolationSuspect?: number | null;
  final?: "merged" | "discarded" | string;
}
