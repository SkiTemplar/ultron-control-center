import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { BrainResult, MemoryStatusInfo } from "../types";

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Status cards (compact row)
// ---------------------------------------------------------------------------

function StatusRow({
  vault,
  brain,
  qdrant,
}: {
  vault: MemoryStatusInfo["vault"];
  brain: MemoryStatusInfo["brain"];
  qdrant: MemoryStatusInfo["qdrant"];
}) {
  const brainStatus =
    !brain.exists
      ? { dot: "var(--color-danger)", label: "missing" }
      : brain.age_hours !== null && brain.age_hours > 24
        ? { dot: "var(--color-warn)", label: `stale ${Math.floor(brain.age_hours)}h` }
        : { dot: "var(--color-success)", label: brain.age_hours !== null ? `fresh ${Math.floor(brain.age_hours)}h` : "fresh" };

  const cardCls = "rounded p-4";
  const cardStyle: React.CSSProperties = {
    background: "var(--color-surface-2)",
    border: "1px solid var(--color-border)",
  };
  const labelCls = "text-[10px] font-medium uppercase tracking-[0.06em]";

  return (
    <div className="grid grid-cols-3 gap-3">
      {/* Vault */}
      <div className={cardCls} style={cardStyle}>
        <div className="flex items-baseline gap-2">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: vault.exists ? "var(--color-success)" : "var(--color-danger)" }}
          />
          <div className={labelCls} style={{ color: "var(--color-text-tertiary)" }}>
            Vault (L2)
          </div>
        </div>
        <div className="mt-2 text-[18px] font-semibold tabular-nums leading-tight">
          {vault.note_count.toLocaleString()}
          <span className="ml-1 text-[12px] font-normal" style={{ color: "var(--color-text-tertiary)" }}>
            notes
          </span>
        </div>
        <div className="mt-1 text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          {formatBytes(vault.size_bytes)} · {formatRelativeIso(vault.last_modified)}
        </div>
      </div>

      {/* Brain */}
      <div className={cardCls} style={cardStyle}>
        <div className="flex items-baseline gap-2">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: brainStatus.dot }}
          />
          <div className={labelCls} style={{ color: "var(--color-text-tertiary)" }}>
            Brain index (L1)
          </div>
        </div>
        <div className="mt-2 text-[18px] font-semibold tabular-nums leading-tight">
          {formatBytes(brain.size_bytes)}
        </div>
        <div className="mt-1 text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          SQLite FTS5 · {brainStatus.label}
        </div>
      </div>

      {/* Qdrant */}
      <div className={cardCls} style={cardStyle}>
        <div className="flex items-baseline gap-2">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: qdrant.up ? "var(--color-success)" : "var(--color-danger)" }}
          />
          <div className={labelCls} style={{ color: "var(--color-text-tertiary)" }}>
            Qdrant (semantic)
          </div>
        </div>
        {qdrant.up ? (
          <>
            <div className="mt-2 text-[18px] font-semibold tabular-nums leading-tight">
              {qdrant.collections.reduce((acc, c) => acc + (c.points_count ?? 0), 0).toLocaleString()}
              <span className="ml-1 text-[12px] font-normal" style={{ color: "var(--color-text-tertiary)" }}>
                points
              </span>
            </div>
            <div className="mt-1 text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
              {qdrant.collections.length} collections
            </div>
          </>
        ) : (
          <div className="mt-2 text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
            {qdrant.error ?? "down"}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search (FTS5 via brain_index.py query)
// ---------------------------------------------------------------------------

function layerBadge(layer: string): { color: string; label: string } {
  if (layer.startsWith("L2")) return { color: "var(--color-success)", label: "vault" };
  if (layer.includes("session")) return { color: "var(--color-warn)", label: "session" };
  if (layer.startsWith("L1")) return { color: "var(--color-text-secondary)", label: "L1" };
  return { color: "var(--color-text-tertiary)", label: layer };
}

function ResultRow({
  r,
  selected,
  onClick,
}: {
  r: BrainResult;
  selected: boolean;
  onClick: () => void;
}) {
  const b = layerBadge(r.layer);
  return (
    <button
      type="button"
      onClick={onClick}
      className="block w-full rounded px-3 py-2 text-left transition-colors"
      style={{
        background: selected ? "var(--color-surface-3)" : "transparent",
        border: `1px solid ${selected ? "var(--color-border-strong)" : "transparent"}`,
      }}
      onMouseEnter={(e) => {
        if (!selected)
          (e.currentTarget as HTMLButtonElement).style.background = "var(--color-surface-2)";
      }}
      onMouseLeave={(e) => {
        if (!selected) (e.currentTarget as HTMLButtonElement).style.background = "transparent";
      }}
    >
      <div className="flex items-baseline gap-2">
        <span
          className="rounded px-1.5 py-px text-[9px] font-medium uppercase tracking-wide"
          style={{
            color: b.color,
            background: "var(--color-surface-3)",
          }}
        >
          {b.label}
        </span>
        <span
          className="truncate text-[12.5px] font-medium"
          style={{ color: "var(--color-text)" }}
        >
          {r.title || r.path.split(/[\\/]/).pop()}
        </span>
        {r.category && (
          <span
            className="ml-auto shrink-0 text-[10px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {r.category}
          </span>
        )}
      </div>
      {r.snippet && (
        <div
          className="mt-1 truncate text-[11.5px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {r.snippet}
        </div>
      )}
    </button>
  );
}

function NotePreview({ path }: { path: string }) {
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setContent("");
    setError(null);
    invoke<string>("read_vault_note", { path })
      .then((c) => {
        if (!cancelled) setContent(c);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header
        className="border-b px-4 py-3"
        style={{ borderColor: "var(--color-border)" }}
      >
        <div
          className="truncate text-[10.5px]"
          style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-faint)" }}
          title={path}
        >
          {path}
        </div>
      </header>
      <div className="flex-1 overflow-auto px-4 py-3">
        {loading && (
          <div className="text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
            Loading…
          </div>
        )}
        {error && (
          <div
            className="rounded p-3 text-[11.5px]"
            style={{
              background: "rgba(248, 81, 73, 0.06)",
              border: "1px solid rgba(248, 81, 73, 0.22)",
              color: "var(--color-danger)",
            }}
          >
            {error}
          </div>
        )}
        {!loading && !error && (
          <pre
            className="whitespace-pre-wrap text-[11.5px] leading-relaxed"
            style={{
              fontFamily: "var(--font-mono)",
              color: "var(--color-text-secondary)",
            }}
          >
            {content}
          </pre>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function Memory() {
  const [data, setData] = useState<MemoryStatusInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<BrainResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  async function load() {
    setRefreshing(true);
    try {
      const r = (await invoke("memory_status")) as MemoryStatusInfo;
      setData(r);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setRefreshing(false);
    }
  }

  async function runSearch() {
    if (!query.trim()) {
      setResults([]);
      setSelectedPath(null);
      return;
    }
    setSearching(true);
    setSearchError(null);
    try {
      const r = (await invoke("brain_query", { query, limit: 30 })) as BrainResult[];
      setResults(r);
      setSelectedPath(r[0]?.path ?? null);
    } catch (e) {
      setSearchError(String(e));
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 px-10 py-6">
        <header className="mb-5 flex items-baseline justify-between gap-4">
          <div>
            <h1 className="text-[20px] font-semibold leading-tight">Memory</h1>
            <p className="mt-1 text-[13px]" style={{ color: "var(--color-text-secondary)" }}>
              Vault · Brain index · Qdrant · live search across the 3 layers
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
            {refreshing ? "Refreshing…" : "Refresh status"}
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

        {data && (
          <StatusRow vault={data.vault} brain={data.brain} qdrant={data.qdrant} />
        )}

        {/* Search */}
        <div className="mt-5 flex items-center gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") runSearch();
            }}
            placeholder="Search vault + sessions + projects…  (Enter)"
            className="flex-1 rounded px-3 py-2 text-[12.5px]"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
              outline: "none",
            }}
          />
          <button
            type="button"
            onClick={runSearch}
            disabled={searching || !query.trim()}
            className="rounded px-3 py-2 text-[12px] font-medium transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            {searching ? "Searching…" : "Search"}
          </button>
        </div>
        {searchError && (
          <p className="mt-2 text-[11.5px]" style={{ color: "var(--color-danger)" }}>
            {searchError}
          </p>
        )}
      </div>

      {/* Results split */}
      {(results.length > 0 || (searching && !error)) && (
        <div className="flex flex-1 overflow-hidden border-t" style={{ borderColor: "var(--color-border)" }}>
          <div
            className="w-[44%] min-w-[420px] overflow-auto border-r px-3 py-3"
            style={{ borderColor: "var(--color-border)" }}
          >
            <div
              className="mb-2 flex items-baseline justify-between px-2"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              <span className="text-[10px] font-medium uppercase tracking-[0.06em]">
                {results.length} results
              </span>
            </div>
            <div className="space-y-px">
              {results.map((r) => (
                <ResultRow
                  key={r.id}
                  r={r}
                  selected={selectedPath === r.path}
                  onClick={() => setSelectedPath(r.path)}
                />
              ))}
            </div>
          </div>
          <div className="flex-1 overflow-hidden">
            {selectedPath ? (
              <NotePreview path={selectedPath} />
            ) : (
              <div
                className="flex h-full items-center justify-center text-[12.5px]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                Select a result to preview the note
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
