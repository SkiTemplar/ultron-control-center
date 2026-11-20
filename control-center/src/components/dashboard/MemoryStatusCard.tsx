// Dashboard — Memory system status card.
//
// Reflects the *current* memory system: the MemoryService over SQLite FTS5
// (brain.db) with the candidate inbox. Recall is sparse FTS5 only: the dense
// route was removed on 2026-11-14, so there is no second store to show.
//
// Data sources:
//   memory_stats()  → active items + pending candidates in the inbox.
//   memory_health() → per-store health (only `sqlite`; any other key is
//                     ignored on purpose). The sqlite store carries the FTS5
//                     index state in `details` (rows, items, integrity) and is
//                     unhealthy when the index diverges from memory_items: the
//                     card then turns red and shows both counts.

import { useCallback, useEffect, useState } from "react";
import { invokeWithTimeout } from "../../lib/invoke-timeout";
import { errMsg } from "../../lib/errors";
import { Card, SmallButton } from "./Card";

/** Estado del índice FTS5 de brain.db (mismo criterio que `ultron-memory doctor`). */
export interface FtsDetails {
  fts_rows: number;
  item_rows: number;
  integrity_ok: boolean;
  in_sync: boolean;
  error: string | null;
}

interface StoreHealth {
  healthy: boolean;
  message: string | null;
  latency_ms: number | null;
  details?: FtsDetails | null;
}

interface MemoryHealth {
  stores: Record<string, StoreHealth>;
}

interface MemoryStats {
  active: number;
  pending: number;
  rejected: number;
  deprecated: number;
  stale: number;
  candidates_pending: number;
}

// SQLite (FTS5) is the only store. Any other key the health probe may report
// is legacy and intentionally hidden.
const STORE_LABELS: Record<string, string> = {
  sqlite: "SQLite (FTS5)",
};
const STORE_ORDER = ["sqlite"];

/** Plazo de cada consulta (las dos tardan menos de 1,5 s medidas en release). */
const MEMORY_TIMEOUT_MS = 20_000;

/** Fila del índice FTS5: filas indexadas y si cuadran con memory_items. */
function FtsIndexRow({ fts }: { fts: FtsDetails }) {
  const ok = fts.in_sync;
  const label = ok
    ? `${fts.fts_rows.toLocaleString()} filas · en sync`
    : `desincronizado · ${fts.fts_rows.toLocaleString()} filas frente a ${fts.item_rows.toLocaleString()} items`;
  const title = ok
    ? "El índice FTS5 tiene una fila por item de brain.db"
    : `El recall sparse devuelve basura. Reparación: ultron-memory fts-rebuild${fts.error ? ` (${fts.error})` : ""}`;
  return (
    <div
      className="flex items-center justify-between rounded px-2.5 py-1.5 text-[12px]"
      style={{
        background: ok ? "var(--color-surface-1)" : "rgba(248,81,73,0.10)",
        border: `1px solid ${ok ? "var(--color-border)" : "rgba(248,81,73,0.35)"}`,
      }}
      title={title}
      data-testid="memory-fts-row"
    >
      <span style={{ color: "var(--color-text-secondary)" }}>Índice FTS5</span>
      <span
        className="tabular-nums text-[10.5px] font-semibold"
        style={{ color: ok ? "var(--color-success)" : "var(--color-danger)" }}
      >
        {label}
      </span>
    </div>
  );
}

interface MemoryStatusCardProps {
  onOpenSystem?: () => void;
}

export function MemoryStatusCard({ onOpenSystem }: MemoryStatusCardProps) {
  const [health, setHealth] = useState<MemoryHealth | null>(null);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Both are independent — fetch in parallel. stats is the headline data;
      // health is best-effort (a store being down must not blank the card).
      // Con plazo: sin respuesta, la tarjeta enseña el error en vez de quedarse
      // en «Cargando…» para siempre (auditoría 2026-10-18).
      const [h, s] = await Promise.all([
        invokeWithTimeout<MemoryHealth>("memory_health", undefined, MEMORY_TIMEOUT_MS),
        invokeWithTimeout<MemoryStats>("memory_stats", undefined, MEMORY_TIMEOUT_MS),
      ]);
      setHealth(h);
      setStats(s);
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  const stores = health?.stores ?? {};
  const relevant = STORE_ORDER.filter((id) => stores[id]);
  const healthyCount = relevant.filter((id) => stores[id]?.healthy).length;
  const totalCount = relevant.length;
  const allHealthy = totalCount > 0 && healthyCount === totalCount;
  // An out-of-sync FTS5 index means sparse recall returns garbage: red,
  // whatever the other stores say.
  const fts = stores.sqlite?.details ?? null;
  const ftsBroken = fts !== null && !fts.in_sync;
  const accent =
    error || ftsBroken ? "danger" : allHealthy ? "ok" : healthyCount > 0 ? "warn" : "danger";
  const pending = stats?.candidates_pending ?? 0;

  return (
    <Card
      title="Sistema de memoria"
      subtitle={
        loading || !stats
          ? undefined
          : `${stats.active.toLocaleString()} memorias activas`
      }
      accent={accent}
      loading={loading}
      error={error}
      action={
        <SmallButton onClick={onOpenSystem} size="md" title="Abrir Sistema">
          Sistema
        </SmallButton>
      }
    >
      <div className="space-y-2">
        {/* Headline counters: active items + pending candidates in the inbox. */}
        <div className="grid grid-cols-2 gap-2">
          <div
            className="rounded px-2.5 py-1.5"
            style={{ background: "var(--color-surface-1)", border: "1px solid var(--color-border)" }}
          >
            <div className="text-[10px] uppercase tracking-[0.06em]" style={{ color: "var(--color-text-tertiary)" }}>
              Memorias
            </div>
            <div className="tabular-nums text-[16px] font-semibold" style={{ color: "var(--color-text)" }}>
              {stats ? stats.active.toLocaleString() : "—"}
            </div>
          </div>
          <div
            className="rounded px-2.5 py-1.5"
            style={{
              background: pending > 0 ? "rgba(210,153,34,0.10)" : "var(--color-surface-1)",
              border: `1px solid ${pending > 0 ? "rgba(210,153,34,0.30)" : "var(--color-border)"}`,
            }}
            title="Candidatas de la bandeja pendientes de aprobar"
          >
            <div className="text-[10px] uppercase tracking-[0.06em]" style={{ color: "var(--color-text-tertiary)" }}>
              Bandeja pendiente
            </div>
            <div
              className="tabular-nums text-[16px] font-semibold"
              style={{ color: pending > 0 ? "var(--color-warn)" : "var(--color-text)" }}
            >
              {stats ? pending.toLocaleString() : "—"}
            </div>
          </div>
        </div>

        {fts && <FtsIndexRow fts={fts} />}

        {/* Per-store dots — only the store that makes up the live system. */}
        <ul className="space-y-1">
          {relevant.map((id) => {
            const s = stores[id];
            return (
              <li key={id} className="flex items-center gap-2 text-[12px]">
                <span
                  className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: s.healthy ? "var(--color-success)" : "var(--color-text-faint)" }}
                  title={s.message ?? (s.healthy ? "OK" : "no disponible")}
                />
                <span className="flex-1 truncate" style={{ color: "var(--color-text)" }}>
                  {STORE_LABELS[id] ?? id}
                </span>
                <span className="tabular-nums text-[10.5px]" style={{ color: "var(--color-text-faint)" }}>
                  {s.healthy ? (s.latency_ms != null ? `${s.latency_ms} ms` : "ok") : "—"}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </Card>
  );
}
