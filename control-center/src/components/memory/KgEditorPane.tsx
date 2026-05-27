// KgEditorPane — local knowledge graph editor (kg.jsonl).
// Extracted from Memory.tsx (1151 L) as part of the P1 split refactor.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { KgGraph } from "./memoryTypes";

export function KgEditorPane() {
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

  useEffect(() => { void reload(); }, [reload]);

  const createEntity = async () => {
    const name = entName.trim();
    if (!name) return;
    try {
      const g = (await invoke("kg_create_entities", {
        entities: [{
          name,
          entity_type: entType.trim() || "entity",
          observations: entObs.split("\n").map((s) => s.trim()).filter(Boolean),
        }],
      })) as KgGraph;
      setGraph(g);
      setEntName(""); setEntType(""); setEntObs("");
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <section className="flex h-full flex-col gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Local knowledge graph</h3>
        <span className="text-xs text-[var(--color-text-tertiary)]">
          {loading ? "loading…" : `${graph.entities.length} entities · ${graph.relations.length} relations`}
        </span>
      </div>

      {error && (
        <div className="rounded-md border p-2 text-xs"
          style={{ borderColor: "var(--color-danger)", color: "var(--color-danger)" }}>
          {error}
        </div>
      )}

      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
        <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
          New entity
        </div>
        <input type="text" value={entName} onChange={(e) => setEntName(e.target.value)}
          placeholder="name"
          className="mb-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
        />
        <input type="text" value={entType} onChange={(e) => setEntType(e.target.value)}
          placeholder="entityType"
          className="mb-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
        />
        <textarea value={entObs} onChange={(e) => setEntObs(e.target.value)}
          placeholder="observations (one per line)" rows={2}
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
            <li key={e.name} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2">
              <div className="flex items-center justify-between">
                <span className="font-medium">{e.name}</span>
                <span className="text-[var(--color-text-tertiary)]">{e.entity_type}</span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
