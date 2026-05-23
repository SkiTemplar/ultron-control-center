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

import { useEffect, useMemo, useState } from "react";
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

const DEBOUNCE_MS = 300;
const DEFAULT_LIMIT = 30;
const ECC_REFRESH_MS = 60_000;

type PaneMode = "both" | "mem0" | "ecc";

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
    if (!query.trim() || !status?.connected) {
      setResults([]);
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
    try {
      await invoke("mem0_add", {
        content: addContent.trim(),
        projectId: addProject.trim() || "global",
        metadata: null,
      });
      setAddContent("");
      setAddOpen(false);
      if (query.trim()) {
        const res = (await invoke("mem0_search", {
          query: query.trim(),
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
          <button
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)]"
            onClick={openSettings}
            disabled={!status}
          >
            Update API key
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

      {emptyState}

      {status?.connected && (
        <>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar memorias…"
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
          />

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
                  Sin resultados para "{query}".
                </p>
              ) : (
                <p className="text-xs text-[var(--color-text-tertiary)]">
                  Empieza a escribir para buscar.
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
            (create_entities / add_observations) to bootstrap the file.
          </p>
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
      </div>
    </div>
  );
}

export default Memory;
