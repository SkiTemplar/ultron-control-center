import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  BrainResult,
  MemoryActionKey,
  MemoryActionResult,
  MemoryStatusInfo,
} from "../types";
import { MemoryGraphForce } from "./MemoryGraphForce";
import { MemoryHighlights } from "./MemoryHighlights";

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
// Vault quick stats — right-side fallback in List mode when nothing is
// selected. Avoids the "giant empty right column" the user complained
// about by surfacing density + top categories + recent activity.
// ---------------------------------------------------------------------------

function VaultQuickStats({
  data,
  recent,
}: {
  data: MemoryStatusInfo | null;
  recent: RecentNote[];
}) {
  // Derive top categories from `recent` only (cheap, no extra IPC).
  // Category := first path segment under the vault root.
  const catCounts = new Map<string, number>();
  for (const n of recent) {
    const seg = (n.relative || "").split(/[\\/]/)[0] || "(root)";
    catCounts.set(seg, (catCounts.get(seg) ?? 0) + 1);
  }
  const topCats = [...catCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  const avgSize =
    recent.length > 0
      ? Math.round(
          recent.reduce((acc, n) => acc + n.size_bytes, 0) / recent.length,
        )
      : 0;
  const lastTouch = recent[0]?.last_modified ?? null;

  return (
    <div className="flex h-full flex-col overflow-auto px-5 py-5">
      <div
        className="mb-3 text-[10px] font-medium uppercase tracking-[0.06em]"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Vault quick stats
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div
          className="rounded p-3"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
          }}
        >
          <div
            className="text-[10px] uppercase tracking-wide"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Notes
          </div>
          <div className="mt-1 text-[16px] font-semibold tabular-nums">
            {data?.vault.note_count.toLocaleString() ?? "—"}
          </div>
        </div>
        <div
          className="rounded p-3"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
          }}
        >
          <div
            className="text-[10px] uppercase tracking-wide"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Avg size (recent)
          </div>
          <div className="mt-1 text-[16px] font-semibold tabular-nums">
            {avgSize > 0 ? `${(avgSize / 1024).toFixed(1)} KB` : "—"}
          </div>
        </div>
        <div
          className="rounded p-3"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
          }}
        >
          <div
            className="text-[10px] uppercase tracking-wide"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Last touch
          </div>
          <div className="mt-1 text-[13px] font-medium">
            {relTime(lastTouch)}
          </div>
        </div>
        <div
          className="rounded p-3"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
          }}
        >
          <div
            className="text-[10px] uppercase tracking-wide"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Qdrant points
          </div>
          <div className="mt-1 text-[16px] font-semibold tabular-nums">
            {data?.qdrant.up
              ? data.qdrant.collections
                  .reduce((a, c) => a + (c.points_count ?? 0), 0)
                  .toLocaleString()
              : "—"}
          </div>
        </div>
      </div>

      <div
        className="mb-2 mt-5 text-[10px] font-medium uppercase tracking-[0.06em]"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Top folders (in recent)
      </div>
      <div
        className="rounded"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border)",
        }}
      >
        {topCats.length === 0 ? (
          <div
            className="p-3 text-[11.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            No recent activity to summarise.
          </div>
        ) : (
          topCats.map(([k, v], i) => (
            <div
              key={k}
              className="flex items-baseline justify-between px-3 py-1.5"
              style={{
                borderTop: i === 0 ? "none" : "1px solid var(--color-border)",
              }}
            >
              <span
                className="truncate text-[12px]"
                style={{ color: "var(--color-text)" }}
              >
                {k}
              </span>
              <span
                className="ml-3 shrink-0 text-[11px] tabular-nums"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {v}
              </span>
            </div>
          ))
        )}
      </div>

      <p
        className="mt-4 text-[11px] leading-relaxed"
        style={{ color: "var(--color-text-faint)" }}
      >
        Select a note on the left to preview it here, or run a search above
        to filter across the 3 memory layers.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

type ActionDef = {
  key: MemoryActionKey;
  label: string;
  hint: string;
  destructive?: boolean;
};

const ACTIONS: ActionDef[] = [
  {
    key: "vault-sync",
    label: "Sync vault",
    hint: "Git stage + commit + push de ~/.ultron-vault. Lo que el Stop hook hace al cerrar Claude.",
  },
  {
    key: "brain-update",
    label: "Update brain",
    hint: "FTS5 incremental: indexa cambios sin tocar lo ya indexado.",
  },
  {
    key: "qdrant-reembed",
    label: "Re-embed Qdrant",
    hint: "Vuelve a calcular embeddings del vault y los empuja a la colección ultron_vault.",
  },
  {
    key: "skills-reembed",
    label: "Re-embed skills",
    hint: "Re-genera embeddings de las skills (active + plugin + vault).",
  },
];

type RecentNote = {
  path: string;
  relative: string;
  title: string | null;
  size_bytes: number;
  last_modified: string | null;
};

function relTime(iso: string | null): string {
  if (!iso) return "-";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return iso;
  const m = Math.floor((Date.now() - t) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function Memory() {
  const [data, setData] = useState<MemoryStatusInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<BrainResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const [runningAction, setRunningAction] = useState<MemoryActionKey | null>(null);
  const [actionOutput, setActionOutput] = useState<MemoryActionResult | null>(null);

  const [recent, setRecent] = useState<RecentNote[]>([]);
  const [recentLoading, setRecentLoading] = useState(true);

  // View modes: List (default, original UX) | Highlights (curated
  // "interesting zone" — most-linked / recent / by-topic / orphans /
  // long-form) | Graph (Obsidian-style force-directed wikilink graph
  // with tag-similarity fallback). The old "2D Map" hash scatter is
  // gone — see MemoryGraph.tsx shim notes.
  const [viewMode, setViewMode] = useState<"list" | "highlights" | "graph">(
    "list",
  );

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

  async function runAction(key: MemoryActionKey) {
    setRunningAction(key);
    setActionOutput(null);
    try {
      const r = (await invoke("memory_action", { action: key })) as MemoryActionResult;
      setActionOutput(r);
      // Refresh status afterwards — sync/index actions likely changed something.
      load();
    } catch (e) {
      setActionOutput({
        success: false,
        stdout: "",
        stderr: String(e),
        exit_code: null,
        action: key,
      });
    } finally {
      setRunningAction(null);
    }
  }

  async function loadRecent() {
    setRecentLoading(true);
    try {
      const r = (await invoke("list_recent_vault_notes", { limit: 20 })) as RecentNote[];
      setRecent(r);
    } catch {
      setRecent([]);
    } finally {
      setRecentLoading(false);
    }
  }

  useEffect(() => {
    load();
    loadRecent();
    const t = setInterval(() => {
      load();
      loadRecent();
    }, 30_000);
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
          <div className="flex items-center gap-2">
            {/* List | Highlights | Graph toggle — same pattern as News.tsx Inline/Summary */}
            <div
              className="flex items-center gap-1 rounded p-0.5"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border)",
              }}
            >
              {(
                [
                  {
                    key: "list" as const,
                    label: "List",
                    title: "List + search view (default)",
                  },
                  {
                    key: "highlights" as const,
                    label: "Highlights",
                    title:
                      "Curated zone: most-linked notes, recently active, orphans, long-form. Click to switch view.",
                  },
                  {
                    key: "graph" as const,
                    label: "Graph",
                    title:
                      "Force-directed wikilink graph (tag-similarity fallback if no wikilinks)",
                  },
                ]
              ).map((opt) => {
                const active = viewMode === opt.key;
                return (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setViewMode(opt.key)}
                    className="rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors"
                    style={{
                      background: active
                        ? "var(--color-surface-3)"
                        : "transparent",
                      color: active
                        ? "var(--color-text)"
                        : "var(--color-text-tertiary)",
                      border: `1px solid ${active ? "var(--color-border-strong)" : "transparent"}`,
                    }}
                    title={opt.title}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={async () => {
                try {
                  const instr = (await invoke("instruction_path", {
                    kind: "memory",
                  })) as string;
                  await invoke("spawn_session", {
                    provider: "claude",
                    prompt:
                      "Vamos a escribir una nueva nota para el vault Obsidian (~/.ultron-vault). Lee el GUIDE.md de esta carpeta para conocer la estructura PARA (10_KNOWLEDGE, 20_PROJECTS...), frontmatter requerido y convenciones. Pregúntame el tema, propon ubicación y título, escribe la nota y luego corre brain_index.py update + embed_vault.py index.",
                    cwd: instr,
                    flags: { dangerouslySkipPermissions: false },
                  });
                } catch (e) {
                  console.error("create memory with AI failed", e);
                }
              }}
              className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
              }}
              title="Sesión Claude con cwd=instructions/memory/ y GUIDE.md auto-cargado"
            >
              New note with AI
            </button>
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
          </div>
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

        {/* List-mode body (actions + search + recent). Hidden in Highlights /
            Graph modes so those views get full vertical real estate. */}
        {viewMode === "list" && (
        <>

        {/* Actions */}
        <div className="mt-5">
          <div
            className="mb-2 text-[10px] font-medium uppercase tracking-[0.06em]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Maintenance actions
          </div>
          <div className="grid grid-cols-4 gap-2">
            {ACTIONS.map((a) => {
              const busy = runningAction === a.key;
              const anyBusy = runningAction !== null;
              return (
                <button
                  key={a.key}
                  type="button"
                  onClick={() => runAction(a.key)}
                  disabled={anyBusy}
                  className="rounded p-3 text-left transition-colors disabled:opacity-50"
                  style={{
                    background: "var(--color-surface-2)",
                    border: "1px solid var(--color-border)",
                  }}
                  onMouseEnter={(e) => {
                    if (!anyBusy)
                      (e.currentTarget as HTMLButtonElement).style.background =
                        "var(--color-surface-3)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background =
                      "var(--color-surface-2)";
                  }}
                  title={a.hint}
                >
                  <div className="text-[12px] font-medium" style={{ color: "var(--color-text)" }}>
                    {busy ? `${a.label}…` : a.label}
                  </div>
                  <div
                    className="mt-1 text-[10.5px] leading-snug"
                    style={{
                      color: "var(--color-text-tertiary)",
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {a.hint}
                  </div>
                </button>
              );
            })}
          </div>

          {actionOutput && (
            <pre
              className="mt-3 max-h-60 overflow-auto rounded p-3 text-[11px] leading-relaxed"
              style={{
                background: "var(--color-surface-1)",
                border: `1px solid ${actionOutput.success ? "var(--color-border)" : "rgba(248, 81, 73, 0.22)"}`,
                fontFamily: "var(--font-mono)",
                color: actionOutput.success
                  ? "var(--color-text-secondary)"
                  : "var(--color-danger)",
                whiteSpace: "pre-wrap",
              }}
            >
              <div
                className="mb-2 text-[10px] uppercase tracking-wide"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {actionOutput.action}
                {actionOutput.exit_code !== null && (
                  <span className="ml-2">exit {actionOutput.exit_code}</span>
                )}
              </div>
              {actionOutput.stdout || actionOutput.stderr || "(no output)"}
            </pre>
          )}
        </div>

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

        </>
        )}
      </div>

      {/* Bottom split — list mode only.
          When a search returned rows: left = results, right = preview.
          When no search active: left = "Recent vault notes", right =
          preview of the selected note (or vault stats fallback).
          This kills the giant right-side hole the user complained about. */}
      {viewMode === "list" && (
        <div
          className="flex flex-1 overflow-hidden border-t"
          style={{ borderColor: "var(--color-border)" }}
        >
          <div
            className="w-[44%] min-w-[420px] overflow-auto border-r px-3 py-3"
            style={{ borderColor: "var(--color-border)" }}
          >
            {results.length > 0 || searching ? (
              <>
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
              </>
            ) : (
              <>
                <div
                  className="mb-2 flex items-baseline justify-between px-2"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  <span className="text-[10px] font-medium uppercase tracking-[0.06em]">
                    Recent vault notes
                  </span>
                  <button
                    type="button"
                    onClick={loadRecent}
                    disabled={recentLoading}
                    className="text-[10.5px] transition-colors disabled:opacity-50"
                    style={{ color: "var(--color-text-faint)" }}
                  >
                    {recentLoading ? "Loading..." : "Refresh"}
                  </button>
                </div>
                {recent.length === 0 && !recentLoading && (
                  <div
                    className="rounded p-4 text-[12px]"
                    style={{
                      background: "var(--color-surface-2)",
                      border: "1px solid var(--color-border)",
                      color: "var(--color-text-tertiary)",
                    }}
                  >
                    Vault vacío o no encontrado.
                  </div>
                )}
                <div
                  className="rounded"
                  style={{
                    background: "var(--color-surface-2)",
                    border: "1px solid var(--color-border)",
                  }}
                >
                  {recent.map((n, i) => (
                    <button
                      key={n.path}
                      type="button"
                      onClick={() => setSelectedPath(n.path)}
                      className="block w-full px-3 py-2 text-left transition-colors"
                      style={{
                        borderTop:
                          i === 0 ? "none" : "1px solid var(--color-border)",
                        background:
                          selectedPath === n.path
                            ? "var(--color-surface-3)"
                            : "transparent",
                      }}
                    >
                      <div className="flex items-baseline gap-2">
                        <span
                          className="truncate text-[12px] font-medium"
                          style={{ color: "var(--color-text)" }}
                        >
                          {n.title ?? n.relative}
                        </span>
                        <span
                          className="ml-auto shrink-0 text-[10px] tabular-nums"
                          style={{ color: "var(--color-text-faint)" }}
                        >
                          {relTime(n.last_modified)}
                        </span>
                      </div>
                      <div
                        className="mt-0.5 truncate text-[10.5px]"
                        style={{
                          fontFamily: "var(--font-mono)",
                          color: "var(--color-text-tertiary)",
                        }}
                      >
                        {n.relative}
                      </div>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <div className="flex-1 overflow-hidden">
            {selectedPath ? (
              <NotePreview path={selectedPath} />
            ) : (
              <VaultQuickStats data={data} recent={recent} />
            )}
          </div>
        </div>
      )}

      {/* Highlights mode — curated interesting zone */}
      {viewMode === "highlights" && (
        <div
          className="flex flex-1 overflow-hidden border-t"
          style={{ borderColor: "var(--color-border)" }}
        >
          <MemoryHighlights />
        </div>
      )}

      {/* Graph mode — Obsidian-style force-directed wikilink graph */}
      {viewMode === "graph" && (
        <div
          className="flex flex-1 overflow-hidden border-t"
          style={{ borderColor: "var(--color-border)" }}
        >
          <MemoryGraphForce />
        </div>
      )}
    </div>
  );
}
