// Mem0Pane — browse, search, add and delete Mem0 cloud memories.
// Extracted from Memory.tsx (1151 L) as part of the P1 split refactor.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { getHomeDir, joinPath } from "../../lib/paths";
import type { Mem0Memory, Mem0Status } from "../../types";
import { DEBOUNCE_MS, DEFAULT_LIMIT } from "./memoryTypes";

export function Mem0Pane() {
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
        if (!cancelled) setStatus({ connected: false, api_key_masked: null, latency_ms: null, error: String(e) });
      }
    };
    void tick();
    const id = setInterval(tick, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  useEffect(() => {
    if (!status?.connected) { setResults([]); return; }
    if (!query.trim()) {
      setSearching(true);
      (async () => {
        try {
          const res = (await invoke("mem0_list_all", { projectId: null, limit: DEFAULT_LIMIT })) as Mem0Memory[];
          setResults(res);
        } catch (e) { setError(String(e)); }
        finally { setSearching(false); }
      })();
      return;
    }
    const h = window.setTimeout(async () => {
      setSearching(true);
      try {
        const res = (await invoke("mem0_search", { query: query.trim(), projectId: null, limit: DEFAULT_LIMIT })) as Mem0Memory[];
        setResults(res);
      } catch (e) { setError(String(e)); }
      finally { setSearching(false); }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(h);
  }, [query, status?.connected]);

  const openSettings = async () => {
    try {
      const home = await getHomeDir();
      const settingsPath = joinPath(home, ".claude", "settings.json");
      await openPath(settingsPath);
    } catch (e) { setError(`open settings.json: ${e}`); }
  };

  const handleAdd = async () => {
    if (!addContent.trim()) return;
    setAdding(true);
    try {
      await invoke("mem0_add", { content: addContent.trim(), projectId: "global", metadata: null });
      setAddContent("");
      setAddOpen(false);
      const res = (await invoke("mem0_list_all", { projectId: null, limit: DEFAULT_LIMIT })) as Mem0Memory[];
      setResults(res);
    } catch (e) { setError(String(e)); }
    finally { setAdding(false); }
  };

  const handleDelete = async (id: string) => {
    try {
      await invoke("mem0_delete", { id });
      setResults((p) => p.filter((m) => m.id !== id));
    } catch (e) { setError(String(e)); }
  };

  if (!status?.connected) {
    return (
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm">
        <p className="mb-2 font-medium">Mem0 not configured</p>
        <p className="text-[var(--color-text-tertiary)]">{status?.error ?? "API key missing"}</p>
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
        <div className="rounded-md border p-2 text-xs"
          style={{ borderColor: "var(--color-danger)", color: "var(--color-danger)" }}>
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
              <li key={m.id} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 text-sm">
                <div className="mb-2 whitespace-pre-wrap">{m.memory}</div>
                <div className="flex items-center justify-between text-xs text-[var(--color-text-tertiary)]">
                  <span>{m.created_at ?? "—"}{m.user_id ? ` · ${m.user_id}` : ""}</span>
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
