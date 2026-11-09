// ULTRON Control Center — AI Router: lógica pura del historial de
// delegaciones (ledger §2 del contrato). Une cada intento con el desenlace
// de su delegación y resume por motor. Sin invoke ni JSX.

import type { LedgerEntry } from "./delegationTypes";

export interface LedgerRow {
  key: string;
  ts: string;
  delegationId: string;
  title: string;
  tier: string;
  engine: string;
  model: string;
  outcome: string;
  skipReason: string | null;
  /** Motivo del desenlace: el resultado solo no distingue un test rojo de un alcance roto. */
  reason: string | null;
  /** Entradas del checkout principal cambiadas durante el intento sin atribuir al motor. */
  isolationSuspect: number;
  durationS: number | null;
  costUsd: number | null;
  final: string | null;
}

export interface EngineSummary {
  engine: string;
  /** Intentos ejecutados (sin contar los saltados). */
  attempts: number;
  ok: number;
  skipped: number;
  /** Porcentaje entero de éxito sobre `attempts`; null si no hubo intentos. */
  successPct: number | null;
  /** Suma de `costUsd`; null si ningún intento del motor informó coste. */
  costUsd: number | null;
}

function isAttempt(entry: LedgerEntry): boolean {
  return typeof entry.engine === "string" && entry.engine !== "";
}

/** Filas de la tabla: una por intento, con el desenlace de su delegación. */
export function buildLedgerRows(entries: readonly LedgerEntry[]): LedgerRow[] {
  const finals = new Map<string, string>();
  const titles = new Map<string, string>();
  for (const e of entries) {
    if (e.final && !finals.has(e.id)) finals.set(e.id, e.final);
    if (e.title && !titles.has(e.id)) titles.set(e.id, e.title);
  }
  return entries.filter(isAttempt).map((e, i) => ({
    key: `${e.id}-${e.attempt ?? "x"}-${e.engine}-${i}`,
    ts: e.ts,
    delegationId: e.id,
    title: e.title || titles.get(e.id) || "(sin título)",
    tier: e.tier ?? "—",
    engine: e.engine ?? "—",
    model: e.model ?? "",
    outcome: e.outcome ?? "—",
    skipReason: e.skipReason ?? null,
    reason: e.reason ?? null,
    isolationSuspect: e.isolationSuspect ?? 0,
    durationS: typeof e.durationS === "number" ? e.durationS : null,
    costUsd: typeof e.costUsd === "number" ? e.costUsd : null,
    final: finals.get(e.id) ?? null,
  }));
}

/** Resumen por motor, en orden de primera aparición. */
export function summarizeLedger(entries: readonly LedgerEntry[]): EngineSummary[] {
  const byEngine = new Map<string, EngineSummary>();
  for (const e of entries) {
    if (!isAttempt(e)) continue;
    const engine = e.engine as string;
    const prev = byEngine.get(engine) ?? {
      engine,
      attempts: 0,
      ok: 0,
      skipped: 0,
      successPct: null,
      costUsd: null,
    };
    const skipped = e.outcome === "skipped";
    const cost = typeof e.costUsd === "number" ? e.costUsd : null;
    byEngine.set(engine, {
      ...prev,
      attempts: prev.attempts + (skipped ? 0 : 1),
      ok: prev.ok + (e.outcome === "ok" ? 1 : 0),
      skipped: prev.skipped + (skipped ? 1 : 0),
      costUsd: cost === null ? prev.costUsd : (prev.costUsd ?? 0) + cost,
    });
  }
  return [...byEngine.values()].map((s) => ({
    ...s,
    successPct: s.attempts > 0 ? Math.round((s.ok / s.attempts) * 100) : null,
  }));
}

/** `0.0015` → `$0.0015`; `1.5` → `$1.50`; null → `—`. */
export function formatUsd(value: number | null): string {
  if (value === null) return "—";
  if (value === 0) return "$0";
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

/** `42` → `42 s`; `125` → `2 min 5 s`; null → `—`. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}
