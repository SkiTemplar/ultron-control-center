// ULTRON Control Center 2.x — Memory tab (live systems view, T1 — 2026-05-26)
//
// Layout:
//   1. MemoryStatusCards     — 4-card row with live health of every memory
//                              system USER runs (mem0, ECC graph, graphify,
//                              MEMORY.md files).
//   2. KnowledgeGraphEditor  — the existing local kg.jsonl editor.
//   3. Mem0Diagnostics       — manual sync + recent log + test endpoint.
//   4. GraphifyControls      — index current project + list known projects.
//
// Sub-panes are collapsible via a tab strip. The Mem0 + ECC + KG panes that
// already existed are kept under "Browse" so the user can still inspect raw
// memories — but the default landing view is the new status board.

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { getHomeDir, joinPath } from "../lib/paths";
import type { Mem0Memory, Mem0Status } from "../types";
import { MemoryBrain } from "./memory/MemoryBrain";
import { MemoryTree } from "./memory/MemoryTree";

// ---------------------------------------------------------------------------
// Local type mirrors of crate::memory_status::*
// ---------------------------------------------------------------------------

type Mem0CardStatus = {
  healthy: boolean;
  api_key_present: boolean;
  api_key_masked: string | null;
  memory_count: number | null;
  last_write_ts: string | null;
  last_op: string | null;
  log_path: string;
  error: string | null;
};

type EccCardStatus = {
  healthy: boolean;
  source_path: string | null;
  entity_count: number;
  relation_count: number;
  bytes: number;
  error: string | null;
};

type GraphifyCardStatus = {
  healthy: boolean;
  installed: boolean;
  version: string | null;
  project_count: number | null;
  projects: string[];
  error: string | null;
};

type MemoryFilesCardStatus = {
  healthy: boolean;
  file_count: number;
  total_bytes: number;
  root: string;
  error: string | null;
};

type SyncResult = {
  ok: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
};

type IndexResult = {
  ok: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
};

// Mirrors of crate::ecc_memory + crate::kg + crate::mem0 types.
type EccEntity = {
  name: string;
  entity_type: string;
  observations: string[];
};
type EccRelation = { from: string; to: string; relation_type: string };
type EccMemorySnapshot = {
  source_path: string | null;
  searched_paths: string[];
  entities: EccEntity[];
  relations: EccRelation[];
  generated_at: string;
};
type KgEntity = {
  name: string;
  entity_type: string;
  observations: string[];
};
type KgRelation = { from: string; to: string; relation_type: string };
type KgGraph = { entities: KgEntity[]; relations: KgRelation[] };

type Mem0LogEntry = {
  timestamp: string;
  op: string;
  ok: boolean;
  status_code: number | null;
  latency_ms: number | null;
  error: string | null;
  body_excerpt: string | null;
  query: string | null;
};
type Mem0DiagnosticsData = {
  api_key_present: boolean;
  api_key_masked: string | null;
  api_key_error: string | null;
  endpoint: string;
  log_path: string;
  last_success: Mem0LogEntry | null;
  last_error: Mem0LogEntry | null;
  recent: Mem0LogEntry[];
};

const DEBOUNCE_MS = 300;
const DEFAULT_LIMIT = 30;
const STATUS_REFRESH_MS = 30_000;

type ViewMode = "tree" | "status" | "brain" | "mem0" | "ecc" | "kg";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// MemoryStatusCards
// ---------------------------------------------------------------------------

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
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: color }}
          />
          <span style={{ color }}>
            {loading ? "checking" : healthy ? "ok" : "issue"}
          </span>
        </span>
      </div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-2 gap-y-0.5 text-xs">
        {rows.map((r) => (
          <div key={r.label} className="contents">
            <dt className="text-[var(--color-text-tertiary)]">{r.label}</dt>
            <dd className="break-all text-[var(--color-text-primary)]">
              {r.value}
            </dd>
          </div>
        ))}
      </dl>
      {error && (
        <div
          className="rounded-md border px-2 py-1 text-xs"
          style={{
            borderColor: "var(--color-danger)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

function MemoryStatusCards() {
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
            {
              label: "key",
              value: mem0?.api_key_present
                ? (mem0.api_key_masked ?? "configured")
                : "missing",
            },
            {
              label: "count",
              value:
                mem0?.memory_count == null
                  ? "—"
                  : `${mem0.memory_count} (global)`,
            },
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
            {
              label: "installed",
              value: graphify?.installed ? "yes" : "no",
            },
            { label: "version", value: graphify?.version ?? "—" },
            {
              label: "projects",
              value:
                graphify?.project_count == null
                  ? "—"
                  : String(graphify.project_count),
            },
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

// ---------------------------------------------------------------------------
// Mem0Diagnostics — sync + log + endpoint test
// ---------------------------------------------------------------------------

function Mem0Diagnostics() {
  const [diag, setDiag] = useState<Mem0DiagnosticsData | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<Mem0Status | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshDiag = useCallback(async () => {
    try {
      const d = (await invoke("mem0_diagnostics")) as Mem0DiagnosticsData;
      setDiag(d);
      setError(null);
    } catch (e) {
      setError(`diagnostics: ${String(e)}`);
    }
  }, []);

  useEffect(() => {
    void refreshDiag();
  }, [refreshDiag]);

  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const s = (await invoke("mem0_test_connection")) as Mem0Status;
      setTestResult(s);
      void refreshDiag();
    } catch (e) {
      setTestResult({
        connected: false,
        api_key_masked: null,
        latency_ms: null,
        error: String(e),
      });
    } finally {
      setTesting(false);
    }
  }, [refreshDiag]);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const r = (await invoke("memory_sync_mem0_manual")) as SyncResult;
      setSyncResult(r);
      void refreshDiag();
    } catch (e) {
      setSyncResult({
        ok: false,
        exit_code: null,
        stdout: "",
        stderr: String(e),
        duration_ms: 0,
      });
    } finally {
      setSyncing(false);
    }
  }, [refreshDiag]);

  return (
    <section className="flex flex-col gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Mem0 diagnostics</h3>
        <div className="flex gap-2">
          <button
            onClick={() => void handleSync()}
            disabled={syncing}
            className="rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-bg)] disabled:opacity-40"
          >
            {syncing ? "Syncing…" : "Sync now"}
          </button>
          <button
            onClick={() => void handleTest()}
            disabled={testing}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-xs hover:bg-[var(--color-surface-3)] disabled:opacity-40"
          >
            {testing ? "Testing…" : "Test endpoint"}
          </button>
          <button
            onClick={() => void refreshDiag()}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-xs hover:bg-[var(--color-surface-3)]"
          >
            Refresh log
          </button>
        </div>
      </div>

      {error && (
        <div
          className="rounded-md border p-2 text-xs"
          style={{
            borderColor: "var(--color-danger)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {testResult && (
        <div
          className="rounded-md border p-2 text-xs"
          style={{
            borderColor: testResult.connected
              ? "var(--color-success)"
              : "var(--color-danger)",
          }}
        >
          Test:{" "}
          {testResult.connected
            ? `OK${testResult.latency_ms != null ? ` · ${testResult.latency_ms}ms` : ""}`
            : `FAIL — ${testResult.error ?? "unknown error"}`}
        </div>
      )}

      {syncResult && (
        <div
          className="rounded-md border p-2 text-xs"
          style={{
            borderColor: syncResult.ok
              ? "var(--color-success)"
              : "var(--color-danger)",
          }}
        >
          Sync · exit {syncResult.exit_code ?? "?"} · {syncResult.duration_ms}ms
          {syncResult.stderr && (
            <pre className="mt-1 whitespace-pre-wrap text-[var(--color-text-tertiary)]">
              {syncResult.stderr.slice(0, 400)}
            </pre>
          )}
        </div>
      )}

      <div className="text-xs text-[var(--color-text-tertiary)]">
        Log: <span className="font-mono">{diag?.log_path ?? "—"}</span>
      </div>

      <div className="max-h-48 overflow-y-auto">
        {diag && diag.recent.length > 0 ? (
          <ul className="space-y-1 text-xs">
            {diag.recent.slice(-20).reverse().map((e, i) => (
              <li
                key={i}
                className="rounded-md bg-[var(--color-surface-2)] px-2 py-1"
                style={{
                  color: e.ok
                    ? "var(--color-text-primary)"
                    : "var(--color-danger)",
                }}
              >
                <div className="flex justify-between">
                  <span>
                    {e.timestamp} · {e.op}
                    {e.status_code != null ? ` · HTTP ${e.status_code}` : ""}
                    {e.latency_ms != null ? ` · ${e.latency_ms}ms` : ""}
                  </span>
                  <span>{e.ok ? "ok" : "fail"}</span>
                </div>
                {e.error && (
                  <div className="text-[var(--color-text-tertiary)]">
                    err: {e.error}
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-[var(--color-text-tertiary)]">
            No log entries yet.
          </p>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// GraphifyControls
// ---------------------------------------------------------------------------

function GraphifyControls() {
  const [status, setStatus] = useState<GraphifyCardStatus | null>(null);
  const [path, setPath] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<IndexResult | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = (await invoke("memory_status_graphify")) as GraphifyCardStatus;
      setStatus(s);
    } catch (e) {
      setStatus({
        healthy: false,
        installed: false,
        version: null,
        project_count: null,
        projects: [],
        error: String(e),
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runIndex = useCallback(async () => {
    if (!path.trim()) return;
    setRunning(true);
    setResult(null);
    try {
      const r = (await invoke("memory_graphify_index", {
        path: path.trim(),
      })) as IndexResult;
      setResult(r);
      void refresh();
    } catch (e) {
      setResult({
        ok: false,
        exit_code: null,
        stdout: "",
        stderr: String(e),
        duration_ms: 0,
      });
    } finally {
      setRunning(false);
    }
  }, [path, refresh]);

  const installed = Boolean(status?.installed);

  return (
    <section className="flex flex-col gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Graphify controls</h3>
        <span className="text-xs text-[var(--color-text-tertiary)]">
          {installed
            ? `installed${status?.version ? ` · ${status.version}` : ""}`
            : "not installed"}
        </span>
      </div>

      {!installed && (
        <p className="text-xs text-[var(--color-text-tertiary)]">
          Graphify CLI was not found in PATH. Install it (npm i -g graphify or
          equivalent) and refresh.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <input
          type="text"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="Project path to index (e.g. C:\\Users\\USER\\proyectos\\foo)"
          className="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
        />
        <button
          onClick={() => void runIndex()}
          disabled={!installed || running || !path.trim()}
          className="rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-bg)] disabled:opacity-40"
        >
          {running ? "Indexing…" : "Index project"}
        </button>
      </div>

      {result && (
        <div
          className="rounded-md border p-2 text-xs"
          style={{
            borderColor: result.ok
              ? "var(--color-success)"
              : "var(--color-danger)",
          }}
        >
          Index · exit {result.exit_code ?? "?"} · {result.duration_ms}ms
          {result.stdout && (
            <pre className="mt-1 whitespace-pre-wrap">
              {result.stdout.slice(0, 400)}
            </pre>
          )}
          {result.stderr && (
            <pre className="mt-1 whitespace-pre-wrap text-[var(--color-text-tertiary)]">
              {result.stderr.slice(0, 400)}
            </pre>
          )}
        </div>
      )}

      <div>
        <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
          Indexed projects ({status?.project_count ?? 0})
        </div>
        {status && status.projects.length > 0 ? (
          <ul className="mt-1 space-y-0.5 text-xs">
            {status.projects.map((p) => (
              <li key={p} className="rounded-md bg-[var(--color-surface-2)] px-2 py-0.5 font-mono">
                {p}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-[var(--color-text-tertiary)]">
            No graphify projects detected.
          </p>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Mem0 browse pane (preserved from previous Memory.tsx, trimmed)
// ---------------------------------------------------------------------------

function Mem0Pane() {
  const [status, setStatus] = useState<Mem0Status | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Mem0Memory[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addContent, setAddContent] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const s = (await invoke("mem0_status")) as Mem0Status;
        if (!cancelled) setStatus(s);
      } catch (e) {
        if (!cancelled) {
          setStatus({
            connected: false,
            api_key_masked: null,
            latency_ms: null,
            error: String(e),
          });
        }
      }
    };
    void tick();
    const id = setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (!status?.connected) {
      setResults([]);
      return;
    }
    if (!query.trim()) {
      setSearching(true);
      (async () => {
        try {
          const res = (await invoke("mem0_list_all", {
            projectId: null,
            limit: DEFAULT_LIMIT,
          })) as Mem0Memory[];
          setResults(res);
        } catch (e) {
          setError(String(e));
        } finally {
          setSearching(false);
        }
      })();
      return;
    }
    const h = window.setTimeout(async () => {
      setSearching(true);
      try {
        const res = (await invoke("mem0_search", {
          query: query.trim(),
          projectId: null,
          limit: DEFAULT_LIMIT,
        })) as Mem0Memory[];
        setResults(res);
      } catch (e) {
        setError(String(e));
      } finally {
        setSearching(false);
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(h);
  }, [query, status?.connected]);

  const openSettings = async () => {
    try {
      const home = await getHomeDir();
      const settingsPath = joinPath(home, ".claude", "settings.json");
      await openPath(settingsPath);
    } catch (e) {
      setError(`open settings.json: ${e}`);
    }
  };

  const handleAdd = async () => {
    if (!addContent.trim()) return;
    setAdding(true);
    try {
      await invoke("mem0_add", {
        content: addContent.trim(),
        projectId: "global",
        metadata: null,
      });
      setAddContent("");
      setAddOpen(false);
      const res = (await invoke("mem0_list_all", {
        projectId: null,
        limit: DEFAULT_LIMIT,
      })) as Mem0Memory[];
      setResults(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await invoke("mem0_delete", { id });
      setResults((p) => p.filter((m) => m.id !== id));
    } catch (e) {
      setError(String(e));
    }
  };

  if (!status?.connected) {
    return (
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm">
        <p className="mb-2 font-medium">Mem0 not configured</p>
        <p className="text-[var(--color-text-tertiary)]">
          {status?.error ?? "API key missing"}
        </p>
        <button
          onClick={openSettings}
          className="mt-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-xs hover:bg-[var(--color-surface-3)]"
        >
          Open settings.json
        </button>
      </div>
    );
  }

  return (
    <section className="flex h-full flex-col gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Mem0 · browse</h3>
        <button
          onClick={() => setAddOpen((v) => !v)}
          className="rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-bg)]"
        >
          + New memory
        </button>
      </header>

      {addOpen && (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
          <textarea
            value={addContent}
            onChange={(e) => setAddContent(e.target.value)}
            placeholder="Contenido de la memoria…"
            rows={3}
            className="w-full resize-none rounded-md border border-[var(--color-border)] bg-[var(--color-surface-3)] p-2 text-sm outline-none focus:border-[var(--color-accent)]"
          />
          <button
            onClick={() => void handleAdd()}
            disabled={adding || !addContent.trim()}
            className="mt-2 rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-bg)] disabled:opacity-40"
          >
            {adding ? "Adding…" : "Add"}
          </button>
        </div>
      )}

      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search memories…"
        className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
      />

      {error && (
        <div
          className="rounded-md border p-2 text-xs"
          style={{ borderColor: "var(--color-danger)", color: "var(--color-danger)" }}
        >
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {searching ? (
          <p className="text-xs text-[var(--color-text-tertiary)]">Buscando…</p>
        ) : results.length === 0 ? (
          <p className="text-xs text-[var(--color-text-tertiary)]">
            {query.trim() ? `Sin resultados para "${query}".` : "Sin memorias."}
          </p>
        ) : (
          <ul className="space-y-2">
            {results.map((m) => (
              <li
                key={m.id}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 text-sm"
              >
                <div className="mb-2 whitespace-pre-wrap">{m.memory}</div>
                <div className="flex items-center justify-between text-xs text-[var(--color-text-tertiary)]">
                  <span>
                    {m.created_at ?? "—"}
                    {m.user_id ? ` · ${m.user_id}` : ""}
                  </span>
                  <button
                    onClick={() => void handleDelete(m.id)}
                    className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2 py-0.5 text-xs hover:bg-[var(--color-surface-2)]"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// ECC graph pane (preserved, read-only)
// ---------------------------------------------------------------------------

function EccGraphPane() {
  const [snapshot, setSnapshot] = useState<EccMemorySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const snap = (await invoke("ecc_memory_read")) as EccMemorySnapshot;
        if (!cancelled) {
          setSnapshot(snap);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    };
    void tick();
    const id = setInterval(tick, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const filtered = useMemo(() => {
    if (!snapshot) return [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return snapshot.entities;
    return snapshot.entities.filter(
      (e) =>
        e.name.toLowerCase().includes(needle) ||
        e.entity_type.toLowerCase().includes(needle) ||
        e.observations.some((o) => o.toLowerCase().includes(needle)),
    );
  }, [snapshot, filter]);

  if (!snapshot) {
    return (
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm">
        {error ?? "Loading ECC graph…"}
      </div>
    );
  }

  if (!snapshot.source_path) {
    return (
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm">
        <p className="mb-2 font-medium">ECC memory storage not detected</p>
        <p className="text-[var(--color-text-tertiary)]">
          Run a Claude Code session that calls the memory MCP to bootstrap the
          JSONL.
        </p>
      </div>
    );
  }

  return (
    <section className="flex h-full flex-col gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">ECC graph · read-only</h3>
        <button
          onClick={() => openPath(snapshot.source_path!).catch(() => {})}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-xs hover:bg-[var(--color-surface-3)]"
        >
          Open JSONL
        </button>
      </div>
      <input
        type="text"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter entities…"
        className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
      />
      <div className="flex-1 overflow-y-auto">
        <ul className="space-y-1 text-xs">
          {filtered.map((e) => (
            <li
              key={e.name}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2"
            >
              <div className="flex items-center justify-between">
                <span className="font-medium">{e.name}</span>
                <span className="text-[var(--color-text-tertiary)]">
                  {e.entity_type} · {e.observations.length} obs
                </span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// KG editor (preserved, link to original kg.jsonl)
// ---------------------------------------------------------------------------

function KgEditorPane() {
  const [graph, setGraph] = useState<KgGraph>({ entities: [], relations: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [entName, setEntName] = useState("");
  const [entType, setEntType] = useState("");
  const [entObs, setEntObs] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const g = (await invoke("kg_read_graph")) as KgGraph;
      setGraph(g);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const createEntity = async () => {
    const name = entName.trim();
    if (!name) return;
    try {
      const g = (await invoke("kg_create_entities", {
        entities: [
          {
            name,
            entity_type: entType.trim() || "entity",
            observations: entObs
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
          },
        ],
      })) as KgGraph;
      setGraph(g);
      setEntName("");
      setEntType("");
      setEntObs("");
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <section className="flex h-full flex-col gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Local knowledge graph</h3>
        <span className="text-xs text-[var(--color-text-tertiary)]">
          {loading
            ? "loading…"
            : `${graph.entities.length} entities · ${graph.relations.length} relations`}
        </span>
      </div>

      {error && (
        <div
          className="rounded-md border p-2 text-xs"
          style={{ borderColor: "var(--color-danger)", color: "var(--color-danger)" }}
        >
          {error}
        </div>
      )}

      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
        <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
          New entity
        </div>
        <input
          type="text"
          value={entName}
          onChange={(e) => setEntName(e.target.value)}
          placeholder="name"
          className="mb-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
        />
        <input
          type="text"
          value={entType}
          onChange={(e) => setEntType(e.target.value)}
          placeholder="entityType"
          className="mb-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
        />
        <textarea
          value={entObs}
          onChange={(e) => setEntObs(e.target.value)}
          placeholder="observations (one per line)"
          rows={2}
          className="w-full resize-none rounded-md border border-[var(--color-border)] bg-[var(--color-surface-3)] p-2 text-xs outline-none focus:border-[var(--color-accent)]"
        />
        <button
          onClick={() => void createEntity()}
          disabled={!entName.trim()}
          className="mt-1 rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-bg)] disabled:opacity-40"
        >
          Create entity
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <ul className="space-y-1 text-xs">
          {graph.entities.map((e) => (
            <li
              key={e.name}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2"
            >
              <div className="flex items-center justify-between">
                <span className="font-medium">{e.name}</span>
                <span className="text-[var(--color-text-tertiary)]">
                  {e.entity_type}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export function Memory() {
  const [mode, setMode] = useState<ViewMode>("tree");

  const tabBtn = (target: ViewMode, label: string) => {
    const active = mode === target;
    return (
      <button
        key={target}
        onClick={() => setMode(target)}
        className={
          active
            ? "rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-bg)]"
            : "rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)]"
        }
      >
        {label}
      </button>
    );
  };

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Memory</h2>
        <div className="flex flex-wrap gap-2">
          {tabBtn("tree", "Knowledge tree")}
          {tabBtn("status", "Live status")}
          {tabBtn("brain", "Brain")}
          {tabBtn("kg", "KG editor")}
          {tabBtn("mem0", "Mem0 browse")}
          {tabBtn("ecc", "ECC graph")}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        {mode === "tree" && <MemoryTree />}
        {mode === "status" && (
          <div className="h-full overflow-y-auto">
            <div className="flex flex-col gap-4 p-1">
              <MemoryStatusCards />
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Mem0Diagnostics />
                <GraphifyControls />
              </div>
            </div>
          </div>
        )}
        {mode === "brain" && <MemoryBrain />}
        {mode === "mem0" && <Mem0Pane />}
        {mode === "ecc" && <EccGraphPane />}
        {mode === "kg" && <KgEditorPane />}
      </div>
    </div>
  );
}

export default Memory;
