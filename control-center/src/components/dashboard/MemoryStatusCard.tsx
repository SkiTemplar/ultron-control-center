// Dashboard — Memory system status card (fullize 2026-06-01).
//
// Replaces the old ECC PluginStatusCard on the main dashboard. Surfaces the
// health of ULTRON's backend memory stores (Qdrant / SQLite / ECC / KG / Mem0)
// plus the embeddings_real flag, from the memory_health() Tauri command.

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

const STORE_LABELS: Record<string, string> = {
  qdrant: "Qdrant (semántico)",
  sqlite: "SQLite (FTS5)",
  ecc: "ECC",
  kg: "Knowledge Graph",
  mem0: "Mem0 (cloud)",
};

const STORE_ORDER = ["qdrant", "sqlite", "ecc", "kg", "mem0"];

interface MemoryStatusCardProps {
  onOpenSystem?: () => void;
}

export function MemoryStatusCard({ onOpenSystem }: MemoryStatusCardProps) {
  const [data, setData] = useState<MemoryHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = (await invoke("memory_health")) as MemoryHealth;
      setData(r);
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

  const stores = data?.stores ?? {};
  const healthyCount = Object.values(stores).filter((s) => s.healthy).length;
  const totalCount = Object.keys(stores).length;
  const allHealthy = totalCount > 0 && healthyCount === totalCount;
  const accent = error ? "danger" : allHealthy ? "ok" : healthyCount > 0 ? "warn" : "danger";

  return (
    <Card
      title="Sistema de memoria"
      subtitle={
        loading
          ? undefined
          : totalCount > 0
            ? `${healthyCount}/${totalCount} stores activos`
            : undefined
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
        {/* Embeddings flag */}
        <div
          className="flex items-center justify-between rounded px-2.5 py-1.5 text-[12px]"
          style={{ background: "var(--color-surface-1)", border: "1px solid var(--color-border)" }}
        >
          <span style={{ color: "var(--color-text-secondary)" }}>Embeddings</span>
          <span
            className="rounded px-1.5 py-px text-[10.5px] font-semibold"
            style={{
              background: data?.embeddings_real ? "rgba(63,185,80,0.12)" : "rgba(210,153,34,0.12)",
              color: data?.embeddings_real ? "var(--color-success)" : "var(--color-warn)",
              border: `1px solid ${data?.embeddings_real ? "rgba(63,185,80,0.3)" : "rgba(210,153,34,0.3)"}`,
            }}
          >
            {data?.embeddings_real ? "reales (fastembed)" : "stub / cero"}
          </span>
        </div>

        {/* Per-store dots */}
        <ul className="space-y-1">
          {STORE_ORDER.filter((id) => stores[id]).map((id) => {
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
                  {s.healthy
                    ? s.latency_ms != null
                      ? `${s.latency_ms} ms`
                      : "ok"
                    : "—"}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </Card>
  );
}
