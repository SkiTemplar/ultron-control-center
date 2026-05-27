// MemoryStatusCards — 4-card live health row for the Memory tab.
// Extracted from Memory.tsx (1151 L) as part of the P1 split refactor.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  EccCardStatus,
  GraphifyCardStatus,
  Mem0CardStatus,
  MemoryFilesCardStatus,
} from "./memoryTypes";
import { STATUS_REFRESH_MS } from "./memoryTypes";

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtRelative(ts: string | null): string {
  if (!ts) return "never";
  const d = Date.parse(ts);
  if (Number.isNaN(d)) return ts;
  const diff = Date.now() - d;
  if (diff < 0) return new Date(d).toLocaleString();
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return new Date(d).toLocaleDateString();
}

type CardProps = {
  title: string;
  healthy: boolean;
  loading: boolean;
  rows: { label: string; value: string }[];
  error?: string | null;
};

function StatusCard({ title, healthy, loading, rows, error }: CardProps) {
  const color = loading
    ? "var(--color-text-tertiary)"
    : healthy
      ? "var(--color-success)"
      : "var(--color-warn)";
  return (
    <div className="flex flex-col gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
          {title}
        </span>
        <span className="inline-flex items-center gap-1 text-xs">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />
          <span style={{ color }}>
            {loading ? "checking" : healthy ? "ok" : "issue"}
          </span>
        </span>
      </div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-2 gap-y-0.5 text-xs">
        {rows.map((r) => (
          <div key={r.label} className="contents">
            <dt className="text-[var(--color-text-tertiary)]">{r.label}</dt>
            <dd className="break-all text-[var(--color-text-primary)]">{r.value}</dd>
          </div>
        ))}
      </dl>
      {error && (
        <div
          className="rounded-md border px-2 py-1 text-xs"
          style={{ borderColor: "var(--color-danger)", color: "var(--color-danger)" }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

export function MemoryStatusCards() {
  const [mem0, setMem0] = useState<Mem0CardStatus | null>(null);
  const [ecc, setEcc] = useState<EccCardStatus | null>(null);
  const [graphify, setGraphify] = useState<GraphifyCardStatus | null>(null);
  const [files, setFiles] = useState<MemoryFilesCardStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    const [m, e, g, f] = await Promise.allSettled([
      invoke<Mem0CardStatus>("memory_status_mem0"),
      invoke<EccCardStatus>("memory_status_ecc"),
      invoke<GraphifyCardStatus>("memory_status_graphify"),
      invoke<MemoryFilesCardStatus>("memory_status_files"),
    ]);
    if (m.status === "fulfilled") setMem0(m.value);
    if (e.status === "fulfilled") setEcc(e.value);
    if (g.status === "fulfilled") setGraphify(g.value);
    if (f.status === "fulfilled") setFiles(f.value);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), STATUS_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Live status</h3>
        <button
          onClick={() => void refresh()}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-xs hover:bg-[var(--color-surface-3)]"
        >
          Refresh
        </button>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatusCard
          title="mem0 cloud"
          healthy={Boolean(mem0?.healthy)}
          loading={loading && !mem0}
          rows={[
            { label: "key", value: mem0?.api_key_present ? (mem0.api_key_masked ?? "configured") : "missing" },
            { label: "count", value: mem0?.memory_count == null ? "—" : `${mem0.memory_count} (global)` },
            { label: "last write", value: fmtRelative(mem0?.last_write_ts ?? null) },
            { label: "last op", value: mem0?.last_op ?? "—" },
          ]}
          error={mem0?.error ?? null}
        />
        <StatusCard
          title="ECC memory"
          healthy={Boolean(ecc?.healthy)}
          loading={loading && !ecc}
          rows={[
            { label: "entities", value: String(ecc?.entity_count ?? 0) },
            { label: "relations", value: String(ecc?.relation_count ?? 0) },
            { label: "size", value: fmtBytes(ecc?.bytes ?? 0) },
            { label: "path", value: ecc?.source_path ?? "not detected" },
          ]}
          error={ecc?.error ?? null}
        />
        <StatusCard
          title="Graphify"
          healthy={Boolean(graphify?.healthy)}
          loading={loading && !graphify}
          rows={[
            { label: "installed", value: graphify?.installed ? "yes" : "no" },
            { label: "version", value: graphify?.version ?? "—" },
            { label: "projects", value: graphify?.project_count == null ? "—" : String(graphify.project_count) },
          ]}
          error={graphify?.error ?? null}
        />
        <StatusCard
          title="MEMORY.md files"
          healthy={Boolean(files?.healthy)}
          loading={loading && !files}
          rows={[
            { label: "files", value: String(files?.file_count ?? 0) },
            { label: "total", value: fmtBytes(files?.total_bytes ?? 0) },
            { label: "root", value: files?.root ?? "—" },
          ]}
          error={files?.error ?? null}
        />
      </div>
    </section>
  );
}
