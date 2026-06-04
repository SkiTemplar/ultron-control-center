// Dashboard — Memory system status card.
//
// Reflects the *current* memory system: the MemoryService (SQLite FTS5 + Qdrant
// semantic) with the candidate inbox. The old ECC / Knowledge-Graph / Mem0
// stores were dropped from the SoT, so they are no longer surfaced here.
//
// Data sources:
//   memory_stats()  → active items + pending candidates in the inbox.
//   memory_health() → per-store health + embeddings_real flag (we only render
//                     qdrant + sqlite; other keys are ignored on purpose).

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Card, SmallButton } from "./Card";

interface StoreHealth {
  healthy: boolean;
  message: string | null;
  latency_ms: number | null;
}

interface MemoryHealth {
  stores: Record<string, StoreHealth>;
  embeddings_real: boolean;
}

interface MemoryStats {
  active: number;
  pending: number;
  rejected: number;
  deprecated: number;
  stale: number;
  candidates_pending: number;
}

// The new memory system is SQLite (lexical) + Qdrant (semantic). Anything else
// the health probe still reports (ecc/kg/mem0) is legacy and intentionally hidden.
const STORE_LABELS: Record<string, string> = {
  qdrant: "Qdrant (semántico)",
  sqlite: "SQLite (FTS5)",
};
const STORE_ORDER = ["sqlite", "qdrant"];

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
      const [h, s] = await Promise.all([
        invoke("memory_health") as Promise<MemoryHealth>,
        invoke("memory_stats") as Promise<MemoryStats>,
      ]);
      setHealth(h);
      setStats(s);
      setError(null);
    } catch (e) {
      setError(String(e));
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
  const accent = error ? "danger" : allHealthy ? "ok" : healthyCount > 0 ? "warn" : "danger";
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
        <SmallButton onClick={onOpenSystem} size="md" title="Abrir System">
          System
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
            title="Candidatos en el inbox a la espera de aprobación"
          >
            <div className="text-[10px] uppercase tracking-[0.06em]" style={{ color: "var(--color-text-tertiary)" }}>
              Inbox pendiente
            </div>
            <div
              className="tabular-nums text-[16px] font-semibold"
              style={{ color: pending > 0 ? "var(--color-warn)" : "var(--color-text)" }}
            >
              {stats ? pending.toLocaleString() : "—"}
            </div>
          </div>
        </div>

        {/* Embeddings flag */}
        <div
          className="flex items-center justify-between rounded px-2.5 py-1.5 text-[12px]"
          style={{ background: "var(--color-surface-1)", border: "1px solid var(--color-border)" }}
        >
          <span style={{ color: "var(--color-text-secondary)" }}>Embeddings</span>
          <span
            className="rounded px-1.5 py-px text-[10.5px] font-semibold"
            style={{
              background: health?.embeddings_real ? "rgba(63,185,80,0.12)" : "rgba(210,153,34,0.12)",
              color: health?.embeddings_real ? "var(--color-success)" : "var(--color-warn)",
              border: `1px solid ${health?.embeddings_real ? "rgba(63,185,80,0.3)" : "rgba(210,153,34,0.3)"}`,
            }}
          >
            {health?.embeddings_real ? "reales (fastembed)" : "stub / cero"}
          </span>
        </div>

        {/* Per-store dots — only the two stores that make up the live system. */}
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
