// Delegación de `scripts/delegate.mjs` vista desde una sesión (§ sesiones_delegations de CONTRATO.md).

/** Un intento de una delegación de `delegate.mjs`. */
export interface DelegationAttempt {
  attempt: number;
  engine: string;
  model: string | null;
  /** `ok`, `check-fail`, `engine-fail`, `skipped`…, tal cual lo escribe el script. */
  outcome: string;
  reason: string | null;
}

/** Delegación de `delegate.mjs` lanzada por una sesión (`sesiones_delegations`). */
export interface DelegationRun {
  id: string;
  title: string;
  tier: string;
  /** `stale`: sin resultado y sin escrituras más allá del plazo del intento. */
  status: "running" | "done" | "error" | "stale";
  /** Del intento en curso; terminada, del que pasó el check o del último ejecutado. */
  engine: string | null;
  model: string | null;
  attempt: number;
  startedAt: string;
  attempts: DelegationAttempt[];
}
