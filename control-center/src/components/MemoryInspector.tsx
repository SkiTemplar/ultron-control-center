// Control Center — Retrieval Inspector (MEMORY KERNEL, wiring 2026-08-10).
//
// "Why this memory?" — la ventana a la memoria. Runs the FULL hybrid recall
// (dense E5 + sparse FTS5 + RRF + cross-encoder) for a query and shows the
// complete per-turn trace: per-source ranks, fused scores, what got injected
// (with reason) and what got discarded (with reason). Wires `recall_inspect`
// and `memory_reindex` — built 2026-06, registered 2026-08-10 (audit 08-09 #34).
//
// Backend (control-center/src-tauri/src/commands/memory/recall_unified/mod.rs):
//   - recall_inspect({ query, limit?, projectId?, crossProject? }) -> RecallTrace
//   - memory_reindex() -> { indexed, errors, collection }
//
// Design contract (matches MemoryInbox / MemoryBrowser):
//   - Black, minimal, hard-edge. Colours 100% from var(--color-*); no hex.
//   - No emojis. Monochrome with neutral/warn/danger accents only.

import { useCallback, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Card, SmallButton } from "./dashboard/Card";

// ---------------------------------------------------------------------------
// Types (mirror the Rust serde shapes — snake_case keys)
// ---------------------------------------------------------------------------

interface RecallEntry {
  canonical_id: string;
  title: string | null;
  summary: string | null;
  scope: string;
  project_id: string | null;
  score: number;
  dense_rank: number | null;
  sparse_rank: number | null;
  dense_score: number | null;
  reason: string;
  token_estimate: number;
}

interface FusedHit {
  canonical_id: string;
  rrf_score: number;
  dense_rank: number | null;
  sparse_rank: number | null;
  dense_score: number | null;
}

interface DiscardedHit {
  canonical_id: string;
  reason: string;
}

interface RecallTrace {
  query: string;
  project_filter: string | null;
  token_budget: number;
  dense_ids: string[];
  sparse_ids: string[];
  fused: FusedHit[];
  injected: RecallEntry[];
  discarded: DiscardedHit[];
  total_tokens: number;
  lazy_load_ids: string[];
  warnings: string[];
}

interface ReindexResult {
  indexed: number;
  errors: number;
  collection: string;
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Unexpected error";
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

// ---------------------------------------------------------------------------
// Small presentational bits
// ---------------------------------------------------------------------------

function RankBadge({ label, tone = "neutral" }: { label: string; tone?: "neutral" | "accent" }) {
  return (
    <span
      className="px-1.5 py-0.5 text-[10px] font-medium tabular-nums"
      style={{
        background: "var(--color-surface-3)",
        border: "1px solid var(--color-border)",
        color: tone === "accent" ? "var(--color-accent)" : "var(--color-text-secondary)",
      }}
    >
      {label}
    </span>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      className="text-[10px] font-medium uppercase tracking-[0.06em]"
      style={{ color: "var(--color-text-tertiary)" }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MemoryInspector — the Inspector sub-tab body.
// ---------------------------------------------------------------------------

export function MemoryInspector() {
  const [query, setQuery] = useState("");
  const [projectId, setProjectId] = useState("");
  const [crossProject, setCrossProject] = useState(false);
  const [trace, setTrace] = useState<RecallTrace | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showFused, setShowFused] = useState(false);

  // Reindex: two-phase confirm (window.confirm is ACL-blocked) + result line.
  const [confirmReindex, setConfirmReindex] = useState(false);
  const [reindexBusy, setReindexBusy] = useState(false);
  const [reindexMsg, setReindexMsg] = useState<string | null>(null);

  const runInspect = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setError(null);
    try {
      const t = (await invoke("recall_inspect", {
        query: q,
        projectId: projectId.trim() || null,
        crossProject,
      })) as RecallTrace;
      setTrace(t);
    } catch (e) {
      setError(errMsg(e));
      setTrace(null);
    } finally {
      setLoading(false);
    }
  }, [query, projectId, crossProject]);

  const onReindex = useCallback(async () => {
    if (!confirmReindex) {
      setConfirmReindex(true);
      window.setTimeout(() => setConfirmReindex(false), 4000);
      return;
    }
    setConfirmReindex(false);
    setReindexBusy(true);
    setReindexMsg(null);
    try {
      const r = (await invoke("memory_reindex")) as ReindexResult;
      setReindexMsg(
        `Reindexed ${r.indexed} items into '${r.collection}'${
          r.errors > 0 ? ` (${r.errors} errors)` : ""
        }.`,
      );
    } catch (e) {
      setReindexMsg(`Reindex failed: ${errMsg(e)}`);
    } finally {
      setReindexBusy(false);
    }
  }, [confirmReindex]);

  const inputStyle = {
    background: "var(--color-surface-3)",
    color: "var(--color-text)",
    border: "1px solid var(--color-border-strong)",
  } as const;

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-5">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold" style={{ color: "var(--color-text)" }}>
            Retrieval Inspector
          </h1>
          <p className="text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
            Run the full hybrid recall for a query and see why each memory was injected or
            discarded (dense E5 + sparse FTS5 + RRF + re-ranker).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SmallButton
            variant={confirmReindex ? "accent" : "neutral"}
            onClick={() => void onReindex()}
            disabled={reindexBusy}
            title="Rebuild the dense index (ultron_memory) from all ACTIVE items"
          >
            {reindexBusy
              ? "Reindexing..."
              : confirmReindex
                ? "Confirm: rebuild dense index?"
                : "Reindex dense"}
          </SmallButton>
        </div>
      </div>

      {reindexMsg && (
        <div
          className="px-3 py-2 text-[11.5px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-secondary)",
          }}
        >
          {reindexMsg}
        </div>
      )}

      {/* Query bar */}
      <div
        className="flex flex-wrap items-end gap-3 px-3 py-3"
        style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
      >
        <label className="flex min-w-[240px] flex-1 flex-col gap-1">
          <SectionLabel>Query</SectionLabel>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void runInspect();
            }}
            placeholder="what would the hook ask? e.g. 'qdrant recall decision'"
            className="min-w-0 flex-1 px-2 py-1 text-[12px] outline-none"
            style={inputStyle}
          />
        </label>

        <label className="flex flex-col gap-1">
          <SectionLabel>Project (optional)</SectionLabel>
          <input
            type="text"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            placeholder="ultron"
            className="w-[120px] px-2 py-1 text-[12px] outline-none"
            style={inputStyle}
          />
        </label>

        <label className="flex items-center gap-1.5 pb-1.5">
          <input
            type="checkbox"
            checked={crossProject}
            onChange={(e) => setCrossProject(e.target.checked)}
          />
          <span className="text-[12px]" style={{ color: "var(--color-text-secondary)" }}>
            Cross-project
          </span>
        </label>

        <SmallButton onClick={() => void runInspect()} disabled={loading || !query.trim()}>
          {loading ? "Tracing... (re-ranker ~2s)" : "Inspect"}
        </SmallButton>
      </div>

      {error && (
        <div
          className="px-3 py-2 text-[11.5px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-danger)",
            color: "var(--color-text-secondary)",
          }}
        >
          {error}
        </div>
      )}

      {trace && (
        <>
          {/* Warnings from the engine (degraded dense, abstention, ...) */}
          {trace.warnings.length > 0 && (
            <div
              className="flex flex-col gap-1 px-3 py-2"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-warn)",
              }}
            >
              {trace.warnings.map((w, i) => (
                <span key={i} className="text-[11.5px]" style={{ color: "var(--color-text-secondary)" }}>
                  {w}
                </span>
              ))}
            </div>
          )}

          {/* Stats strip */}
          <div className="flex flex-wrap items-center gap-2">
            <RankBadge label={`dense ${trace.dense_ids.length}`} />
            <RankBadge label={`sparse ${trace.sparse_ids.length}`} />
            <RankBadge label={`fused ${trace.fused.length}`} />
            <RankBadge label={`injected ${trace.injected.length}`} tone="accent" />
            <RankBadge label={`discarded ${trace.discarded.length}`} />
            <RankBadge label={`tokens ${trace.total_tokens}/${trace.token_budget}`} />
            {trace.project_filter && <RankBadge label={`project ${trace.project_filter}`} />}
          </div>

          {/* Injected — the pack the model would actually see */}
          <Card
            title="Injected"
            subtitle="What the context pack would contain, best-first, with the reason per entry"
            loading={false}
            error={null}
            empty={
              trace.injected.length === 0
                ? "Nothing injected — the abstention gate held (no confident signal) or nothing matched."
                : null
            }
          >
            <div className="flex flex-col gap-2">
              {trace.injected.map((e, idx) => (
                <div
                  key={e.canonical_id}
                  className="flex flex-col gap-1 px-3 py-2"
                  style={{
                    background: "var(--color-surface-2)",
                    border: "1px solid var(--color-border)",
                  }}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className="text-[11px] font-semibold tabular-nums"
                      style={{ color: "var(--color-accent)" }}
                    >
                      #{idx + 1}
                    </span>
                    <span
                      className="text-[12.5px] font-medium"
                      style={{ color: "var(--color-text)" }}
                    >
                      {e.title || e.summary?.slice(0, 80) || shortId(e.canonical_id)}
                    </span>
                    <span className="ml-auto flex items-center gap-1.5">
                      {e.dense_rank !== null && <RankBadge label={`dense#${e.dense_rank + 1}`} />}
                      {e.sparse_rank !== null && (
                        <RankBadge label={`sparse#${e.sparse_rank + 1}`} />
                      )}
                      {e.dense_score !== null && (
                        <RankBadge label={`cos ${e.dense_score.toFixed(3)}`} />
                      )}
                      <RankBadge label={`rrf ${e.score.toFixed(4)}`} />
                      <RankBadge label={`~${e.token_estimate}t`} />
                    </span>
                  </div>
                  {e.title && e.summary && (
                    <p
                      className="text-[11.5px] leading-snug"
                      style={{ color: "var(--color-text-secondary)" }}
                    >
                      {e.summary}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[10.5px]" style={{ color: "var(--color-text-tertiary)" }}>
                      {e.reason} · {e.scope}
                      {e.project_id ? ` · ${e.project_id}` : ""} · {shortId(e.canonical_id)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          {/* Discarded — retrieved but not injected, with reason */}
          <Card
            title="Discarded"
            subtitle="Retrieved but NOT injected — token cap, governance, rank, dedupe"
            loading={false}
            error={null}
            empty={trace.discarded.length === 0 ? "Nothing was discarded." : null}
          >
            <div className="flex flex-col gap-1">
              {trace.discarded.map((d) => (
                <div
                  key={d.canonical_id}
                  className="flex items-center gap-2 px-3 py-1.5"
                  style={{
                    background: "var(--color-surface-2)",
                    border: "1px solid var(--color-border)",
                  }}
                >
                  <span
                    className="text-[10.5px] tabular-nums"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    {shortId(d.canonical_id)}
                  </span>
                  <span className="text-[11.5px]" style={{ color: "var(--color-text-secondary)" }}>
                    {d.reason}
                  </span>
                </div>
              ))}
            </div>
          </Card>

          {/* Fused ranking (collapsible — diagnostic depth) */}
          <div>
            <SmallButton onClick={() => setShowFused((v) => !v)}>
              {showFused ? "Hide fused ranking" : `Show fused ranking (${trace.fused.length})`}
            </SmallButton>
          </div>
          {showFused && (
            <Card
              title="Fused (RRF)"
              subtitle="Every candidate after Reciprocal Rank Fusion, with per-source ranks"
              loading={false}
              error={null}
              empty={trace.fused.length === 0 ? "No fused candidates." : null}
            >
              <div className="flex flex-col gap-1">
                {trace.fused.map((f, idx) => (
                  <div
                    key={f.canonical_id}
                    className="flex items-center gap-2 px-3 py-1"
                    style={{
                      background: "var(--color-surface-2)",
                      border: "1px solid var(--color-border)",
                    }}
                  >
                    <span
                      className="w-8 text-[10.5px] tabular-nums"
                      style={{ color: "var(--color-text-tertiary)" }}
                    >
                      #{idx + 1}
                    </span>
                    <span
                      className="text-[10.5px] tabular-nums"
                      style={{ color: "var(--color-text-secondary)" }}
                    >
                      {shortId(f.canonical_id)}
                    </span>
                    <span className="ml-auto flex items-center gap-1.5">
                      {f.dense_rank !== null && <RankBadge label={`d#${f.dense_rank + 1}`} />}
                      {f.sparse_rank !== null && <RankBadge label={`s#${f.sparse_rank + 1}`} />}
                      {f.dense_score !== null && (
                        <RankBadge label={f.dense_score.toFixed(3)} />
                      )}
                      <RankBadge label={`rrf ${f.rrf_score.toFixed(4)}`} />
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </>
      )}

      {!trace && !error && !loading && (
        <div
          className="px-3 py-6 text-center text-[12px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Type a query and hit Inspect to trace the recall pipeline.
        </div>
      )}
    </div>
  );
}
