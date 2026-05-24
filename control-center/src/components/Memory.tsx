// ULTRON Control Center 2.3 — Memory tab (Mem0 cloud + ECC local graph)
//
// Two-pane view of USER's memory surfaces:
//   - Mem0 cloud (left)  — searchable, mutable. Status pill at top.
//   - ECC graph (right)  — local JSONL written by the @modelcontextprotocol
//                          /server-memory MCP. Read-only display grouped by
//                          entityType, with a search/filter input.
//
// A tab strip at the very top lets the user collapse to either side or keep
// both. The default is "both"; on narrow viewports the layout stacks.
//
// Why read-only for ECC?  The MCP server speaks stdio and is owned by the
// Claude Code agent process. Driving it from Tauri would require spawning
// a parallel stdio session — fragile and duplicative. Reading the JSONL on
// disk gives us the same data with zero IPC.

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { getHomeDir, joinPath } from "../lib/paths";
import type { Mem0Memory, Mem0Status } from "../types";

// Local mirrors of the Rust `EccEntity` / `EccRelation` / `EccMemorySnapshot`
// types defined in `src-tauri/src/ecc_memory.rs`. Once the shared `types.ts`
// is updated (see report), these can be removed and re-imported from there.
type EccEntity = {
  name: string;
  entity_type: string;
  observations: string[];
};
type EccRelation = {
  from: string;
  to: string;
  relation_type: string;
};
type EccMemorySnapshot = {
  source_path: string | null;
  searched_paths: string[];
  entities: EccEntity[];
  relations: EccRelation[];
  generated_at: string;
};

// Mirrors of `crate::kg::{KgEntity, KgRelation, KgGraph}` (v2.6 fb-047).
type KgEntity = {
  name: string;
  entity_type: string;
  observations: string[];
};
type KgRelation = {
  from: string;
  to: string;
  relation_type: string;
};
type KgGraph = {
  entities: KgEntity[];
  relations: KgRelation[];
};

// Mirrors of `crate::mem0::{Mem0LogEntry, Mem0Diagnostics}` (v27-f16).
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
const ECC_REFRESH_MS = 60_000;

type PaneMode = "both" | "mem0" | "ecc" | "kg";

function StatusPill({ status }: { status: Mem0Status | null }) {
  if (!status) {
    return (
      <span className="text-xs text-[var(--color-text-muted)]">checking…</span>
    );
  }
  const color = status.connected ? "var(--color-success)" : "var(--color-warn)";
  const label = status.connected
    ? `connected${status.latency_ms ? ` · ${status.latency_ms}ms` : ""}`
    : "disconnected";
  return (
    <span className="inline-flex items-center gap-2 text-xs">
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ background: color }}
      />
      <span>{label}</span>
      {status.api_key_masked ? (
        <span className="text-[var(--color-text-tertiary)]">
          · key {status.api_key_masked}
        </span>
      ) : null}
    </span>
  );
}

function EccStatusPill({ snapshot }: { snapshot: EccMemorySnapshot | null }) {
  if (!snapshot) {
    return (
      <span className="text-xs text-[var(--color-text-muted)]">loading…</span>
    );
  }
  const connected = Boolean(snapshot.source_path);
  const color = connected ? "var(--color-success)" : "var(--color-warn)";
  const label = connected
    ? `loaded · ${snapshot.entities.length} entities · ${snapshot.relations.length} relations`
    : "storage not detected";
  return (
    <span className="inline-flex items-center gap-2 text-xs">
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ background: color }}
      />
      <span>{label}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Mem0 cloud pane
// ---------------------------------------------------------------------------

// v2.6 (card v27-f16): diagnostics panel. Renders the full state surface a
// user needs to debug "memorias no aparecen" — API key, endpoint, last
// success/error timestamps with body excerpts, and a test button that hits
// `/v1/ping/` synchronously.
type Mem0DiagnosticsPanelProps = {
  diag: Mem0DiagnosticsData | null;
  testing: boolean;
  testResult: Mem0Status | null;
  onTest: () => void;
  onRefresh: () => void;
};

function fmtEntry(entry: Mem0LogEntry | null): string {
  if (!entry) return "—";
  const bits = [
    entry.timestamp,
    entry.op,
    entry.status_code != null ? `HTTP ${entry.status_code}` : null,
    entry.latency_ms != null ? `${entry.latency_ms}ms` : null,
  ].filter(Boolean) as string[];
  return bits.join(" · ");
}

function Mem0DiagnosticsPanel({
  diag,
  testing,
  testResult,
  onTest,
  onRefresh,
}: Mem0DiagnosticsPanelProps) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-semibold text-[var(--color-text-primary)]">
          Mem0 debug
        </span>
        <div className="flex gap-2">
          <button
            onClick={onTest}
            disabled={testing}
            className="rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)] px-2 py-0.5 text-xs font-medium text-[var(--color-bg)] disabled:opacity-40"
          >
            {testing ? "Testing…" : "Test connection"}
          </button>
          <button
            onClick={onRefresh}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2 py-0.5 text-xs hover:bg-[var(--color-surface-2)]"
          >
            Refresh log
          </button>
        </div>
      </div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
        <dt className="text-[var(--color-text-tertiary)]">API key</dt>
        <dd>
          {diag?.api_key_present ? (
            <span>
              <span style={{ color: "var(--color-success)" }}>✓</span>{" "}
              <span className="font-mono">
                {diag.api_key_masked ?? "(set)"}
              </span>
            </span>
          ) : (
            <span>
              <span style={{ color: "var(--color-warn)" }}>✗</span>{" "}
              <span className="text-[var(--color-text-tertiary)]">
                {diag?.api_key_error ?? "not configured"}
              </span>
            </span>
          )}
        </dd>
        <dt className="text-[var(--color-text-tertiary)]">Endpoint</dt>
        <dd className="break-all font-mono">{diag?.endpoint ?? "—"}</dd>
        <dt className="text-[var(--color-text-tertiary)]">Log file</dt>
        <dd className="break-all font-mono">{diag?.log_path ?? "—"}</dd>
        <dt className="text-[var(--color-text-tertiary)]">Last success</dt>
        <dd>{fmtEntry(diag?.last_success ?? null)}</dd>
        <dt className="text-[var(--color-text-tertiary)]">Last error</dt>
        <dd>
          {diag?.last_error ? (
            <span style={{ color: "var(--color-danger)" }}>
              {fmtEntry(diag.last_error)}
              {diag.last_error.error ? ` — ${diag.last_error.error}` : ""}
            </span>
          ) : (
            "—"
          )}
        </dd>
      </dl>
      {testResult && (
        <div
          className="mt-2 rounded-md border p-2"
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
      {diag && diag.recent.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[var(--color-text-tertiary)]">
            Recent calls ({diag.recent.length})
          </summary>
          <ul className="mt-1 max-h-48 space-y-1 overflow-y-auto">
            {diag.recent
              .slice()
              .reverse()
              .map((e, i) => (
                <li
                  key={i}
                  className="rounded-md bg-[var(--color-surface-3)] px-2 py-1"
                  style={{
                    color: e.ok
                      ? "var(--color-text-primary)"
                      : "var(--color-danger)",
                  }}
                >
                  <div className="flex justify-between">
                    <span>{fmtEntry(e)}</span>
                    <span>{e.ok ? "OK" : "FAIL"}</span>
                  </div>
                  {e.error && (
                    <div className="text-[var(--color-text-tertiary)]">
                      err: {e.error}
                    </div>
                  )}
                  {e.body_excerpt && (
                    <div className="break-all text-[var(--color-text-tertiary)] font-mono">
                      body: {e.body_excerpt.slice(0, 240)}
                      {e.body_excerpt.length > 240 ? "…" : ""}
                    </div>
                  )}
                </li>
              ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Mem0Pane() {
  const [status, setStatus] = useState<Mem0Status | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Mem0Memory[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addContent, setAddContent] = useState("");
  const [addProject, setAddProject] = useState("global");
  const [adding, setAdding] = useState(false);
  // v2.6.3 — Mem0 `add` is async (returns PENDING + event_id). Track recent
  // queued events so the user sees feedback even before the worker hydrates.
  const [addNotice, setAddNotice] = useState<string | null>(null);
  // The user_id (project_id) currently used for listing/searching. Surfaced
  // in the header so we can transparently show WHICH bucket is being
  // queried — fixes the "memories no aparecen" confusion when memories
  // exist under a different user_id than expected.
  const [listUserId, setListUserId] = useState<string>("global");
  // v2.6 (card-v26-fb-008): manual refresh — the 30s interval is fine for
  // passive use but the user wants an immediate reload after editing keys
  // in settings.json.
  const [refreshing, setRefreshing] = useState(false);
  // v2.6 (card v27-f16): diagnostics panel — the user reported memories were
  // not showing and there was no visible reason why. Surface the last success,
  // last error, masked key, endpoint, log path and a manual test button.
  const [diag, setDiag] = useState<Mem0DiagnosticsData | null>(null);
  const [diagOpen, setDiagOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<Mem0Status | null>(null);

  const refreshStatus = useCallback(async () => {
    setRefreshing(true);
    try {
      const s = (await invoke("mem0_status")) as Mem0Status;
      setStatus(s);
    } catch (e) {
      setStatus({
        connected: false,
        api_key_masked: null,
        latency_ms: null,
        error: String(e),
      });
    } finally {
      setRefreshing(false);
    }
  }, []);

  const refreshDiagnostics = useCallback(async () => {
    try {
      const d = (await invoke("mem0_diagnostics")) as Mem0DiagnosticsData;
      setDiag(d);
    } catch (e) {
      setError(`diagnostics: ${String(e)}`);
    }
  }, []);

  const runTestConnection = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const s = (await invoke("mem0_test_connection")) as Mem0Status;
      setTestResult(s);
      // Test connection writes to the log, so refresh diagnostics too.
      void refreshDiagnostics();
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
  }, [refreshDiagnostics]);

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
    if (diagOpen) {
      void refreshDiagnostics();
    }
  }, [diagOpen, refreshDiagnostics]);

  // v2.6.3 — combined list/search effect.
  //   · empty query → GET /v1/memories/?user_id=global   (real list, not blank-search)
  //   · non-empty    → POST /v1/memories/search/
  // Previously the empty-query branch returned [] immediately, so the tab
  // always looked empty until the user typed something — which is the
  // "Mem0 sigue sin ofrecer nada" bug USER reported.
  useEffect(() => {
    if (!status?.connected) {
      setResults([]);
      return;
    }
    if (!query.trim()) {
      setSearching(true);
      setError(null);
      (async () => {
        try {
          const res = (await invoke("mem0_list_all", {
            projectId: null,
            limit: DEFAULT_LIMIT,
          })) as Mem0Memory[];
          setResults(res);
          setListUserId("global");
        } catch (e) {
          setError(String(e));
          setResults([]);
        } finally {
          setSearching(false);
        }
      })();
      return;
    }
    const handle = window.setTimeout(async () => {
      setSearching(true);
      setError(null);
      try {
        const res = (await invoke("mem0_search", {
          query: query.trim(),
          projectId: null,
          limit: DEFAULT_LIMIT,
        })) as Mem0Memory[];
        setResults(res);
        setListUserId("global");
      } catch (e) {
        setError(String(e));
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
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
    setAddNotice(null);
    try {
      // v2.6.3 — Mem0's add endpoint is async: it returns PENDING + event_id
      // and the actual memory id/text materializes later when the background
      // worker finishes. Surface that explicitly so the user understands why
      // the list doesn't show the new entry instantly.
      const added = (await invoke("mem0_add", {
        content: addContent.trim(),
        projectId: addProject.trim() || "global",
        metadata: null,
      })) as Mem0Memory & {
        status?: string;
        event_id?: string;
        message?: string;
      };
      setAddContent("");
      setAddOpen(false);
      const pending = added?.status === "PENDING" || (!added?.id && added?.event_id);
      if (pending) {
        setAddNotice(
          `Memory queued for processing (event ${added.event_id ?? "?"}). It will appear in the list shortly.`,
        );
      } else if (added?.id) {
        setAddNotice(`Memory added · id ${added.id.slice(0, 8)}…`);
      } else {
        setAddNotice("Memory request accepted.");
      }
      // Refresh whichever view is active (list or search) so the user sees
      // updated state immediately, even if the new memory is still PENDING.
      if (query.trim()) {
        const res = (await invoke("mem0_search", {
          query: query.trim(),
          projectId: null,
          limit: DEFAULT_LIMIT,
        })) as Mem0Memory[];
        setResults(res);
      } else {
        const res = (await invoke("mem0_list_all", {
          projectId: null,
          limit: DEFAULT_LIMIT,
        })) as Mem0Memory[];
        setResults(res);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await invoke("mem0_delete", { id });
      setResults((prev) => prev.filter((m) => m.id !== id));
    } catch (e) {
      setError(String(e));
    }
  };

  const emptyState = useMemo(() => {
    if (!status) return null;
    if (!status.connected) {
      return (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4 text-sm">
          <p className="mb-2 font-medium">Mem0 no configurado</p>
          <p className="text-[var(--color-text-tertiary)]">
            {status.error ?? "API key no configurada"}
          </p>
          <button
            className="mt-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-3)] px-3 py-1 text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-surface-2)]"
            onClick={openSettings}
          >
            Abrir settings.json
          </button>
        </div>
      );
    }
    return null;
  }, [status]);

  return (
    <section className="flex h-full flex-col gap-3">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Mem0 · cloud</h3>
          <StatusPill status={status} />
        </div>
        <div className="flex gap-2">
          {/* v2.6 (card-v26-fb-008): manual refresh — the 30s tick is fine
              but USER wants an instant reload after editing keys. */}
          <button
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)] disabled:opacity-50"
            onClick={() => void refreshStatus()}
            disabled={refreshing}
            title="Re-check Mem0 status now"
          >
            {refreshing ? "Checking…" : "Refresh"}
          </button>
          <button
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)]"
            onClick={openSettings}
            disabled={!status}
          >
            Update API key
          </button>
          {/* v27-f16: debug toggle. When something fails silently, the user
              wants to SEE why — endpoint, masked key, last success/error and
              the full log. */}
          <button
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)]"
            onClick={() => setDiagOpen((v) => !v)}
          >
            {diagOpen ? "Hide debug" : "Debug"}
          </button>
          <button
            className="rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-bg)] hover:opacity-90 disabled:opacity-40"
            onClick={() => setAddOpen((v) => !v)}
            disabled={!status?.connected}
          >
            + New memory
          </button>
        </div>
      </header>

      {diagOpen && (
        <Mem0DiagnosticsPanel
          diag={diag}
          testing={testing}
          testResult={testResult}
          onTest={runTestConnection}
          onRefresh={refreshDiagnostics}
        />
      )}

      {emptyState}

      {status?.connected && (
        <>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Buscar en user_id="${listUserId}" o vacío para listar todo…`}
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
          />
          {addNotice && (
            <div className="rounded-md border border-[var(--color-accent)] bg-[var(--color-surface-2)] p-2 text-xs">
              {addNotice}
              <button
                onClick={() => setAddNotice(null)}
                className="ml-2 text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          )}

          {addOpen && (
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
              <textarea
                value={addContent}
                onChange={(e) => setAddContent(e.target.value)}
                placeholder="Contenido de la memoria…"
                rows={3}
                className="w-full resize-none rounded-md border border-[var(--color-border)] bg-[var(--color-surface-3)] p-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
              />
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="text"
                  value={addProject}
                  onChange={(e) => setAddProject(e.target.value)}
                  placeholder="project_id (default: global)"
                  className="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2 py-1 text-xs text-[var(--color-text-primary)] outline-none"
                />
                <button
                  onClick={handleAdd}
                  disabled={adding || !addContent.trim()}
                  className="rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-bg)] disabled:opacity-40"
                >
                  {adding ? "Adding…" : "Add"}
                </button>
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-surface-2)] p-3 text-xs text-[var(--color-danger)]">
              {error}
            </div>
          )}

          <div className="flex-1 overflow-y-auto">
            {searching ? (
              <p className="text-xs text-[var(--color-text-tertiary)]">
                Buscando…
              </p>
            ) : results.length === 0 ? (
              query.trim() ? (
                <p className="text-xs text-[var(--color-text-tertiary)]">
                  Sin resultados para "{query}" en user_id="{listUserId}".
                </p>
              ) : (
                <p className="text-xs text-[var(--color-text-tertiary)]">
                  No hay memorias guardadas para user_id="{listUserId}". Usa
                  + New memory para añadir una.
                </p>
              )
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
                        onClick={() => handleDelete(m.id)}
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
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// ECC graph pane (local, read-only)
// ---------------------------------------------------------------------------

function EccGraphPane() {
  const [snapshot, setSnapshot] = useState<EccMemorySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [bootstrapping, setBootstrapping] = useState(false);

  const refreshSnapshot = useCallback(async () => {
    try {
      const snap = (await invoke("ecc_memory_read")) as EccMemorySnapshot;
      setSnapshot(snap);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

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
    const id = setInterval(tick, ECC_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const handleBootstrap = useCallback(async () => {
    setBootstrapping(true);
    try {
      await invoke("bootstrap_ecc_memory");
      await refreshSnapshot();
    } catch (e) {
      setError(`bootstrap: ${String(e)}`);
    } finally {
      setBootstrapping(false);
    }
  }, [refreshSnapshot]);

  const filtered = useMemo<EccEntity[]>(() => {
    if (!snapshot) return [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return snapshot.entities;
    return snapshot.entities.filter((e) => {
      if (e.name.toLowerCase().includes(needle)) return true;
      if (e.entity_type.toLowerCase().includes(needle)) return true;
      return e.observations.some((o) => o.toLowerCase().includes(needle));
    });
  }, [snapshot, filter]);

  const grouped = useMemo(() => {
    const map = new Map<string, EccEntity[]>();
    for (const ent of filtered) {
      const key = ent.entity_type || "entity";
      const bucket = map.get(key) ?? [];
      bucket.push(ent);
      map.set(key, bucket);
    }
    return Array.from(map.entries()).sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
  }, [filtered]);

  const relationsByEntity = useMemo(() => {
    const map = new Map<string, EccRelation[]>();
    if (!snapshot) return map;
    for (const rel of snapshot.relations) {
      for (const name of [rel.from, rel.to]) {
        const bucket = map.get(name) ?? [];
        bucket.push(rel);
        map.set(name, bucket);
      }
    }
    return map;
  }, [snapshot]);

  const toggle = (name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const noStorage = snapshot && !snapshot.source_path;

  return (
    <section className="flex h-full flex-col gap-3">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">ECC knowledge graph · local</h3>
          <EccStatusPill snapshot={snapshot} />
        </div>
        {snapshot?.source_path && (
          <button
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-xs hover:bg-[var(--color-surface-3)]"
            onClick={() => openPath(snapshot.source_path!).catch(() => {})}
          >
            Open JSONL
          </button>
        )}
      </header>

      {error && (
        <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-surface-2)] p-3 text-xs text-[var(--color-danger)]">
          {error}
        </div>
      )}

      {noStorage && (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4 text-sm">
          <p className="mb-2 font-medium">ECC memory storage not detected</p>
          <p className="mb-2 text-[var(--color-text-tertiary)]">
            Looked for the JSONL graph in:
          </p>
          <ul className="space-y-1 text-xs font-mono text-[var(--color-text-tertiary)]">
            {snapshot?.searched_paths.map((p) => (
              <li key={p} className="break-all">
                · {p}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-[var(--color-text-tertiary)]">
            Install the ECC plugin or run a session that calls the memory MCP
            (create_entities / add_observations) to bootstrap the file. Or
            create an empty graph right now:
          </p>
          <button
            onClick={() => void handleBootstrap()}
            disabled={bootstrapping}
            className="mt-2 rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-bg)] disabled:opacity-40"
            title="Create ~/.claude/memory.jsonl with a seed entity"
          >
            {bootstrapping ? "Bootstrapping…" : "Bootstrap memory"}
          </button>
        </div>
      )}

      {snapshot?.source_path && (
        <>
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filtrar entities…"
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
          />
          <div className="flex-1 overflow-y-auto">
            {grouped.length === 0 ? (
              <p className="text-xs text-[var(--color-text-tertiary)]">
                {filter.trim()
                  ? `Sin entities para "${filter}".`
                  : "El grafo está vacío. Lanza una sesión que use create_entities."}
              </p>
            ) : (
              <div className="space-y-4">
                {grouped.map(([type, ents]) => (
                  <div key={type}>
                    <div className="mb-1 text-xs uppercase tracking-wider text-[var(--color-text-tertiary)]">
                      {type} · {ents.length}
                    </div>
                    <ul className="space-y-1">
                      {ents.map((ent) => {
                        const isOpen = expanded.has(ent.name);
                        const rels = relationsByEntity.get(ent.name) ?? [];
                        return (
                          <li
                            key={ent.name}
                            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] text-sm"
                          >
                            <button
                              onClick={() => toggle(ent.name)}
                              className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-[var(--color-surface-3)]"
                            >
                              <span className="font-medium">{ent.name}</span>
                              <span className="text-xs text-[var(--color-text-tertiary)]">
                                {ent.observations.length} obs · {rels.length} rel
                              </span>
                            </button>
                            {isOpen && (
                              <div className="border-t border-[var(--color-border)] px-3 py-2 text-xs">
                                {ent.observations.length > 0 && (
                                  <div className="mb-2">
                                    <div className="mb-1 text-[var(--color-text-tertiary)]">
                                      Observations
                                    </div>
                                    <ul className="space-y-1">
                                      {ent.observations.map((obs, i) => (
                                        <li
                                          key={i}
                                          className="whitespace-pre-wrap text-[var(--color-text-primary)]"
                                        >
                                          · {obs}
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                )}
                                {rels.length > 0 && (
                                  <div>
                                    <div className="mb-1 text-[var(--color-text-tertiary)]">
                                      Relations
                                    </div>
                                    <ul className="space-y-1">
                                      {rels.map((r, i) => (
                                        <li
                                          key={i}
                                          className="text-[var(--color-text-primary)]"
                                        >
                                          <span className="font-mono">
                                            {r.from}
                                          </span>
                                          <span className="mx-1 text-[var(--color-text-tertiary)]">
                                            ─ {r.relation_type} →
                                          </span>
                                          <span className="font-mono">
                                            {r.to}
                                          </span>
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                )}
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Local Knowledge Graph editor (card v2.6 fb-047)
// ---------------------------------------------------------------------------
//
// Why a separate store?  The ECC graph (`EccGraphPane`) is owned by the
// @modelcontextprotocol/server-memory MCP, which writes via stdio from
// Claude Code sessions. The Control Center can't safely drive that file in
// parallel, so this pane uses a Control-Center-owned JSONL at
// `~/.ultron/cockpit/kg.jsonl` (`crate::kg`). The on-disk schema matches the
// MCP server's so future integrations stay interoperable.
//
// MCP integration roadmap: a future iteration could shell out to
// `claude --mcp-tool plugin_ecc_memory.create_entities ...` from the
// backend, but the user explicitly asked to prefer a local functional
// implementation over a placeholder. See report.

function KgEditorPane() {
  const [graph, setGraph] = useState<KgGraph>({ entities: [], relations: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [searchMatches, setSearchMatches] = useState<KgGraph | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  // Add-entity form
  const [entName, setEntName] = useState("");
  const [entType, setEntType] = useState("");
  const [entObs, setEntObs] = useState("");

  // Add-observation to selected entity
  const [obsText, setObsText] = useState("");

  // Add-relation form
  const [relFrom, setRelFrom] = useState("");
  const [relTo, setRelTo] = useState("");
  const [relType, setRelType] = useState("");

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

  // Debounced search
  useEffect(() => {
    if (!search.trim()) {
      setSearchMatches(null);
      return;
    }
    const h = window.setTimeout(async () => {
      try {
        const g = (await invoke("kg_search_nodes", {
          query: search.trim(),
        })) as KgGraph;
        setSearchMatches(g);
      } catch (e) {
        setError(String(e));
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(h);
  }, [search]);

  const view = searchMatches ?? graph;

  const createEntity = async () => {
    const name = entName.trim();
    if (!name) return;
    const observations = entObs
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      const g = (await invoke("kg_create_entities", {
        entities: [
          {
            name,
            entity_type: entType.trim() || "entity",
            observations,
          },
        ],
      })) as KgGraph;
      setGraph(g);
      setEntName("");
      setEntType("");
      setEntObs("");
      setSelected(name);
    } catch (e) {
      setError(String(e));
    }
  };

  const addObservation = async () => {
    if (!selected || !obsText.trim()) return;
    try {
      const g = (await invoke("kg_add_observations", {
        name: selected,
        observations: obsText
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
      })) as KgGraph;
      setGraph(g);
      setObsText("");
    } catch (e) {
      setError(String(e));
    }
  };

  const createRelation = async () => {
    const from = relFrom.trim();
    const to = relTo.trim();
    if (!from || !to) return;
    try {
      const g = (await invoke("kg_create_relations", {
        relations: [
          {
            from,
            to,
            relation_type: relType.trim() || "relates_to",
          },
        ],
      })) as KgGraph;
      setGraph(g);
      setRelFrom("");
      setRelTo("");
      setRelType("");
    } catch (e) {
      setError(String(e));
    }
  };

  const deleteEntity = async (name: string) => {
    if (!confirm(`Delete entity "${name}" and all its relations?`)) return;
    try {
      const g = (await invoke("kg_delete_entity", { name })) as KgGraph;
      setGraph(g);
      if (selected === name) setSelected(null);
    } catch (e) {
      setError(String(e));
    }
  };

  const deleteRelation = async (rel: KgRelation) => {
    try {
      const g = (await invoke("kg_delete_relation", {
        from: rel.from,
        to: rel.to,
        relationType: rel.relation_type,
      })) as KgGraph;
      setGraph(g);
    } catch (e) {
      setError(String(e));
    }
  };

  const selectedEntity = useMemo(
    () => graph.entities.find((e) => e.name === selected) ?? null,
    [graph.entities, selected],
  );

  const selectedRelations = useMemo(
    () =>
      selected
        ? graph.relations.filter((r) => r.from === selected || r.to === selected)
        : [],
    [graph.relations, selected],
  );

  // Simple SVG graph: nodes laid out on a circle, edges drawn as lines.
  // Keeps the implementation footprint tiny — no d3 / cytoscape dependency.
  const svg = useMemo(() => {
    const W = 360;
    const H = 360;
    const cx = W / 2;
    const cy = H / 2;
    const R = Math.min(W, H) / 2 - 30;
    const ents = view.entities.slice(0, 24); // hard cap so layout stays readable
    const positions = new Map<string, { x: number; y: number }>();
    ents.forEach((ent, i) => {
      const angle = (2 * Math.PI * i) / Math.max(ents.length, 1) - Math.PI / 2;
      positions.set(ent.name, {
        x: cx + R * Math.cos(angle),
        y: cy + R * Math.sin(angle),
      });
    });
    const edges = view.relations.filter(
      (r) => positions.has(r.from) && positions.has(r.to),
    );
    return { W, H, positions, ents, edges };
  }, [view]);

  return (
    <section className="flex h-full flex-col gap-3">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Local Knowledge Graph</h3>
          <span className="text-xs text-[var(--color-text-muted)]">
            {loading
              ? "loading…"
              : `${graph.entities.length} entities · ${graph.relations.length} relations`}
            <span className="ml-2 text-[var(--color-text-tertiary)]">
              · stored at ~/.ultron/cockpit/kg.jsonl
            </span>
          </span>
        </div>
        <button
          onClick={() => void reload()}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-xs hover:bg-[var(--color-surface-3)]"
        >
          Reload
        </button>
      </header>

      {error && (
        <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-surface-2)] p-3 text-xs text-[var(--color-danger)]">
          {error}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-3">
        {/* Left: entity list + search */}
        <div className="flex min-h-0 flex-col gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search nodes (name, type, observations)…"
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
          />
          <div className="min-h-0 flex-1 overflow-y-auto">
            {view.entities.length === 0 ? (
              <p className="text-xs text-[var(--color-text-tertiary)]">
                {search.trim() ? "No matches." : "No entities yet."}
              </p>
            ) : (
              <ul className="space-y-1">
                {view.entities.map((ent) => {
                  const active = ent.name === selected;
                  return (
                    <li key={ent.name}>
                      <button
                        onClick={() => setSelected(ent.name)}
                        className={
                          active
                            ? "flex w-full items-center justify-between rounded-md border border-[var(--color-accent)] bg-[var(--color-surface-3)] px-2 py-1 text-left text-xs"
                            : "flex w-full items-center justify-between rounded-md border border-transparent px-2 py-1 text-left text-xs hover:bg-[var(--color-surface-3)]"
                        }
                      >
                        <span className="truncate font-medium">{ent.name}</span>
                        <span className="ml-2 shrink-0 text-[var(--color-text-tertiary)]">
                          {ent.entity_type}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        {/* Center: forms + selected detail */}
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
              New entity
            </div>
            <div className="space-y-2">
              <input
                type="text"
                value={entName}
                onChange={(e) => setEntName(e.target.value)}
                placeholder="name"
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
              />
              <input
                type="text"
                value={entType}
                onChange={(e) => setEntType(e.target.value)}
                placeholder="entityType (default: entity)"
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
              />
              <textarea
                value={entObs}
                onChange={(e) => setEntObs(e.target.value)}
                placeholder="observations — one per line"
                rows={3}
                className="w-full resize-none rounded-md border border-[var(--color-border)] bg-[var(--color-surface-3)] p-2 text-xs outline-none focus:border-[var(--color-accent)]"
              />
              <button
                onClick={() => void createEntity()}
                disabled={!entName.trim()}
                className="rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-bg)] disabled:opacity-40"
              >
                Create entity
              </button>
            </div>
          </div>

          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
              New relation
            </div>
            <div className="space-y-2">
              <input
                type="text"
                value={relFrom}
                onChange={(e) => setRelFrom(e.target.value)}
                placeholder="from (entity name)"
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
              />
              <input
                type="text"
                value={relTo}
                onChange={(e) => setRelTo(e.target.value)}
                placeholder="to (entity name)"
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
              />
              <input
                type="text"
                value={relType}
                onChange={(e) => setRelType(e.target.value)}
                placeholder="relationType (default: relates_to)"
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
              />
              <button
                onClick={() => void createRelation()}
                disabled={!relFrom.trim() || !relTo.trim()}
                className="rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-bg)] disabled:opacity-40"
              >
                Create relation
              </button>
            </div>
          </div>

          {selectedEntity && (
            <div className="border-t border-[var(--color-border)] pt-3">
              <div className="mb-1 flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
                <span>Selected: {selectedEntity.name}</span>
                <button
                  onClick={() => void deleteEntity(selectedEntity.name)}
                  className="rounded-md border border-[var(--color-danger)] px-2 py-0.5 text-xs text-[var(--color-danger)] hover:bg-[var(--color-surface-3)]"
                >
                  Delete
                </button>
              </div>
              <div className="mb-2 text-xs text-[var(--color-text-tertiary)]">
                Type:{" "}
                <span className="font-mono">{selectedEntity.entity_type}</span>
              </div>
              <ul className="mb-2 space-y-1 text-xs">
                {selectedEntity.observations.length === 0 ? (
                  <li className="text-[var(--color-text-tertiary)]">
                    (no observations yet)
                  </li>
                ) : (
                  selectedEntity.observations.map((obs, i) => (
                    <li
                      key={i}
                      className="whitespace-pre-wrap rounded-md bg-[var(--color-surface-3)] px-2 py-1"
                    >
                      · {obs}
                    </li>
                  ))
                )}
              </ul>
              <div className="space-y-2">
                <textarea
                  value={obsText}
                  onChange={(e) => setObsText(e.target.value)}
                  placeholder="Add observations — one per line"
                  rows={2}
                  className="w-full resize-none rounded-md border border-[var(--color-border)] bg-[var(--color-surface-3)] p-2 text-xs outline-none focus:border-[var(--color-accent)]"
                />
                <button
                  onClick={() => void addObservation()}
                  disabled={!obsText.trim()}
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-3)] px-3 py-1 text-xs hover:bg-[var(--color-surface-2)] disabled:opacity-40"
                >
                  Add observation
                </button>
              </div>
              {selectedRelations.length > 0 && (
                <div className="mt-2">
                  <div className="mb-1 text-xs text-[var(--color-text-tertiary)]">
                    Relations
                  </div>
                  <ul className="space-y-1 text-xs">
                    {selectedRelations.map((r, i) => (
                      <li
                        key={i}
                        className="flex items-center justify-between rounded-md bg-[var(--color-surface-3)] px-2 py-1"
                      >
                        <span>
                          <span className="font-mono">{r.from}</span>
                          <span className="mx-1 text-[var(--color-text-tertiary)]">
                            ─ {r.relation_type} →
                          </span>
                          <span className="font-mono">{r.to}</span>
                        </span>
                        <button
                          onClick={() => void deleteRelation(r)}
                          className="rounded-md border border-[var(--color-border)] px-1 py-0 text-xs hover:bg-[var(--color-surface-2)]"
                          title="Delete relation"
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right: graph visualization */}
        <div className="flex min-h-0 flex-col gap-2 overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
            Graph ({svg.ents.length}
            {view.entities.length > svg.ents.length
              ? ` of ${view.entities.length}`
              : ""}{" "}
            nodes)
          </div>
          {svg.ents.length === 0 ? (
            <p className="text-xs text-[var(--color-text-tertiary)]">
              Create an entity to start the graph.
            </p>
          ) : (
            <svg
              viewBox={`0 0 ${svg.W} ${svg.H}`}
              className="h-auto w-full"
              role="img"
              aria-label="Knowledge graph"
            >
              {svg.edges.map((r, i) => {
                const a = svg.positions.get(r.from)!;
                const b = svg.positions.get(r.to)!;
                return (
                  <g key={`e-${i}`}>
                    <line
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      stroke="var(--color-border)"
                      strokeWidth={1}
                    />
                    <text
                      x={(a.x + b.x) / 2}
                      y={(a.y + b.y) / 2}
                      textAnchor="middle"
                      fontSize={8}
                      fill="var(--color-text-tertiary)"
                    >
                      {r.relation_type}
                    </text>
                  </g>
                );
              })}
              {svg.ents.map((ent) => {
                const p = svg.positions.get(ent.name)!;
                const active = ent.name === selected;
                return (
                  <g
                    key={`n-${ent.name}`}
                    style={{ cursor: "pointer" }}
                    onClick={() => setSelected(ent.name)}
                  >
                    <circle
                      cx={p.x}
                      cy={p.y}
                      r={active ? 10 : 7}
                      fill={
                        active ? "var(--color-accent)" : "var(--color-surface-3)"
                      }
                      stroke="var(--color-border)"
                    />
                    <text
                      x={p.x}
                      y={p.y - 14}
                      textAnchor="middle"
                      fontSize={10}
                      fill="var(--color-text-primary)"
                    >
                      {ent.name.length > 16
                        ? `${ent.name.slice(0, 15)}…`
                        : ent.name}
                    </text>
                  </g>
                );
              })}
            </svg>
          )}
          {view.relations.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-[var(--color-text-tertiary)]">
                Relations table ({view.relations.length})
              </summary>
              <ul className="mt-1 space-y-1">
                {view.relations.map((r, i) => (
                  <li
                    key={i}
                    className="rounded-md bg-[var(--color-surface-3)] px-2 py-1"
                  >
                    <span className="font-mono">{r.from}</span>
                    <span className="mx-1 text-[var(--color-text-tertiary)]">
                      ─ {r.relation_type} →
                    </span>
                    <span className="font-mono">{r.to}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export function Memory() {
  const [mode, setMode] = useState<PaneMode>("both");

  const tabBtn = (target: PaneMode, label: string) => {
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
        <div className="flex gap-2">
          {tabBtn("mem0", "Mem0")}
          {tabBtn("ecc", "ECC Graph")}
          {tabBtn("kg", "KG Editor")}
          {tabBtn("both", "Both")}
        </div>
      </header>

      <div
        className={
          mode === "both"
            ? "grid min-h-0 flex-1 grid-cols-1 gap-6 lg:grid-cols-2"
            : "min-h-0 flex-1"
        }
      >
        {(mode === "both" || mode === "mem0") && (
          <div className="min-h-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <Mem0Pane />
          </div>
        )}
        {(mode === "both" || mode === "ecc") && (
          <div className="min-h-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <EccGraphPane />
          </div>
        )}
        {mode === "kg" && (
          <div className="min-h-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <KgEditorPane />
          </div>
        )}
      </div>
    </div>
  );
}

export default Memory;
