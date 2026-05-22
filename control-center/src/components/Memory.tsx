// ULTRON Control Center 2.0 — Mem0 panel (global)
//
// Read/search/add/delete against Mem0 cloud via the Rust backend. The API
// key lives in `~/.claude/settings.json` (mem0.apiKey). If the key is the
// placeholder or missing, the panel renders an empty state pointing at
// Settings → general.

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { getHomeDir, joinPath } from "../lib/paths";
import type { Mem0Memory, Mem0Status } from "../types";

const DEBOUNCE_MS = 300;
const DEFAULT_LIMIT = 30;

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

export function Memory() {
  const [status, setStatus] = useState<Mem0Status | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Mem0Memory[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addContent, setAddContent] = useState("");
  const [addProject, setAddProject] = useState("global");
  const [adding, setAdding] = useState(false);

  // Initial + 30s status poll
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

  // Debounced search
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
      // Refresh search if there's a live query.
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
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-6 text-sm">
          <p className="mb-2 font-medium">Mem0 no configurado</p>
          <p className="text-[var(--color-text-tertiary)]">
            {status.error ?? "API key no configurada"}
          </p>
          <button
            className="mt-3 rounded-md border border-[var(--color-border)] px-3 py-1 text-xs hover:bg-[var(--color-surface-3)]"
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
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Memory · Mem0</h2>
          <StatusPill status={status} />
        </div>
        <div className="flex gap-2">
          <button
            className="rounded-md border border-[var(--color-border)] px-3 py-1 text-xs hover:bg-[var(--color-surface-2)]"
            onClick={openSettings}
            disabled={!status}
          >
            Update API key
          </button>
          <button
            className="rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)] px-3 py-1 text-xs text-white hover:opacity-90 disabled:opacity-50"
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
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
          />

          {addOpen && (
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
              <textarea
                value={addContent}
                onChange={(e) => setAddContent(e.target.value)}
                placeholder="Contenido de la memoria…"
                rows={3}
                className="w-full resize-none rounded-md border border-[var(--color-border)] bg-[var(--color-surface-3)] p-2 text-sm outline-none focus:border-[var(--color-accent)]"
              />
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="text"
                  value={addProject}
                  onChange={(e) => setAddProject(e.target.value)}
                  placeholder="project_id (default: global)"
                  className="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2 py-1 text-xs outline-none"
                />
                <button
                  onClick={handleAdd}
                  disabled={adding || !addContent.trim()}
                  className="rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)] px-3 py-1 text-xs text-white disabled:opacity-50"
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
                        className="rounded-md border border-[var(--color-border)] px-2 py-0.5 text-xs hover:bg-[var(--color-surface-3)]"
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
    </div>
  );
}

export default Memory;
