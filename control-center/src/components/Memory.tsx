import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { MemoryStatusInfo } from "../types";

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatRelativeIso(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function Section({
  title,
  status,
  detail,
  children,
}: {
  title: string;
  status: "ok" | "warn" | "down" | "neutral";
  detail?: string;
  children?: React.ReactNode;
}) {
  const dotColor =
    status === "ok"
      ? "var(--color-success)"
      : status === "warn"
        ? "var(--color-warn)"
        : status === "down"
          ? "var(--color-danger)"
          : "var(--color-text-tertiary)";
  return (
    <section
      className="rounded p-5"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <header className="flex items-baseline justify-between">
        <div className="flex items-baseline gap-2">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: dotColor }}
          />
          <h2 className="text-[14px] font-semibold">{title}</h2>
        </div>
        {detail && (
          <span className="text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
            {detail}
          </span>
        )}
      </header>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between py-1 text-[12px]">
      <span style={{ color: "var(--color-text-tertiary)" }}>{label}</span>
      <span
        className="tabular-nums"
        style={{ color: "var(--color-text)", maxWidth: "60%", textAlign: "right" }}
      >
        {value}
      </span>
    </div>
  );
}

export function Memory() {
  const [data, setData] = useState<MemoryStatusInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    setRefreshing(true);
    try {
      const r = (await invoke("memory_status")) as MemoryStatusInfo;
      setData(r);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  const vaultStatus = !data
    ? "neutral"
    : data.vault.exists
      ? "ok"
      : "down";
  const brainStatus = !data
    ? "neutral"
    : !data.brain.exists
      ? "down"
      : data.brain.age_hours !== null && data.brain.age_hours > 24
        ? "warn"
        : "ok";
  const qdrantStatus = !data
    ? "neutral"
    : data.qdrant.up
      ? "ok"
      : "down";

  return (
    <div className="px-10 py-8">
      <header className="mb-6 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-semibold leading-tight">Memory</h1>
          <p className="mt-1 text-[13px]" style={{ color: "var(--color-text-secondary)" }}>
            Vault · Brain index FTS5 · Qdrant collections
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={refreshing}
          className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      {error && (
        <div
          className="mb-4 rounded p-3 text-[12.5px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="text-[12.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          Loading…
        </div>
      )}

      {data && (
        <div className="grid grid-cols-2 gap-4">
          {/* Vault */}
          <Section
            title="Vault (L2)"
            status={vaultStatus}
            detail={data.vault.exists ? "filesystem" : "not found"}
          >
            <Field label="Notes" value={data.vault.note_count.toLocaleString()} />
            <Field label="Size" value={formatBytes(data.vault.size_bytes)} />
            <Field label="Last write" value={formatRelativeIso(data.vault.last_modified)} />
            {data.vault.path && (
              <div
                className="mt-2 truncate text-[10.5px]"
                style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-faint)" }}
                title={data.vault.path}
              >
                {data.vault.path}
              </div>
            )}
          </Section>

          {/* Brain */}
          <Section
            title="Brain index (L1)"
            status={brainStatus}
            detail={
              data.brain.age_hours !== null
                ? data.brain.age_hours > 24
                  ? `stale ${Math.floor(data.brain.age_hours)}h`
                  : `fresh ${Math.floor(data.brain.age_hours)}h`
                : "—"
            }
          >
            <Field label="Size" value={formatBytes(data.brain.size_bytes)} />
            <Field label="Last update" value={formatRelativeIso(data.brain.last_modified)} />
            <Field
              label="Engine"
              value={<span style={{ fontFamily: "var(--font-mono)" }}>SQLite FTS5</span>}
            />
            {data.brain.path && (
              <div
                className="mt-2 truncate text-[10.5px]"
                style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-faint)" }}
                title={data.brain.path}
              >
                {data.brain.path}
              </div>
            )}
          </Section>

          {/* Qdrant */}
          <Section
            title="Qdrant (semantic)"
            status={qdrantStatus}
            detail={data.qdrant.up ? "localhost:6333" : data.qdrant.error ?? "down"}
          >
            {data.qdrant.up && data.qdrant.collections.length === 0 && (
              <div className="text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
                No collections yet.
              </div>
            )}
            {data.qdrant.collections.map((c) => (
              <div
                key={c.name}
                className="flex items-baseline justify-between py-1 text-[12px]"
              >
                <span style={{ color: "var(--color-text)" }}>{c.name}</span>
                <span
                  className="tabular-nums"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  {c.points_count !== null ? c.points_count.toLocaleString() : "—"} points
                  {c.status && (
                    <span
                      className="ml-2 rounded px-1 py-px text-[10px] uppercase"
                      style={{
                        background: "var(--color-surface-3)",
                        color: "var(--color-text-secondary)",
                      }}
                    >
                      {c.status}
                    </span>
                  )}
                </span>
              </div>
            ))}
            {data.qdrant.error && !data.qdrant.up && (
              <div className="mt-2 text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
                {data.qdrant.error}
              </div>
            )}
          </Section>

          {/* Actions placeholder */}
          <Section
            title="Actions"
            status="neutral"
            detail="phase 8"
          >
            <p
              className="text-[12px] leading-relaxed"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Sync vault · push memory · brain query · recall — controles unificados llegan en la pestaña Settings (Fase 8) para tener edición de scripts y configs en un solo sitio.
            </p>
          </Section>
        </div>
      )}
    </div>
  );
}
