// Library → Routing — inspector del catálogo semántico de routing
// (colección Qdrant `ultron_catalog`, E5-large). Dos funciones:
//   1. Probar a qué agente/skill rutearía un prompt (catalog_search).
//   2. Reindexar el catálogo a mano (catalog_reindex / catalog_reindex_skills)
//      — útil cuando el warm-up automático de setup() falla en silencio.
// Wiring 2026-08-11 (audit 08-09 #40).

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Search, Loader, Bot, Sparkle } from "./icons";

type CatalogHit = {
  entity: string; // "agent" | "skill"
  name: string;
  description: string;
  score: number;
  kind?: string; // solo skills: "persona" | "technical" | "meta"
};

type ReindexResult = {
  indexed_agents?: number;
  indexed_skills?: number;
  errors?: number;
  skill_error?: string | null;
  collection?: string;
};

type EntityFilter = "any" | "agent" | "skill";

const FILTERS: { id: EntityFilter; label: string }[] = [
  { id: "any", label: "All" },
  { id: "agent", label: "Agents" },
  { id: "skill", label: "Skills" },
];

function scoreColor(score: number): string {
  if (score >= 0.85) return "var(--color-success)";
  if (score >= 0.8) return "var(--color-warn)";
  return "var(--color-text-tertiary)";
}

export function RoutingCatalog() {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<EntityFilter>("any");
  const [hits, setHits] = useState<CatalogHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reindexing, setReindexing] = useState<"full" | "skills" | null>(null);
  const [reindexResult, setReindexResult] = useState<string | null>(null);

  async function runSearch() {
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    setError(null);
    try {
      const res = (await invoke("catalog_search", {
        query: q,
        entity: filter === "any" ? null : filter,
        limit: 8,
      })) as CatalogHit[];
      setHits(res);
    } catch (e) {
      setError(String(e));
      setHits(null);
    } finally {
      setSearching(false);
    }
  }

  async function runReindex(mode: "full" | "skills") {
    if (reindexing) return;
    setReindexing(mode);
    setError(null);
    setReindexResult(null);
    try {
      const cmd = mode === "full" ? "catalog_reindex" : "catalog_reindex_skills";
      const r = (await invoke(cmd)) as ReindexResult;
      const parts: string[] = [];
      if (typeof r.indexed_agents === "number") {
        parts.push(`${r.indexed_agents} agents`);
      }
      if (typeof r.indexed_skills === "number") {
        parts.push(`${r.indexed_skills} skills`);
      }
      const errs = r.errors ?? 0;
      let msg = `Indexed ${parts.join(" + ")} into ${r.collection ?? "ultron_catalog"}`;
      if (errs > 0) msg += ` · ${errs} errors`;
      if (r.skill_error) msg += ` · skills failed: ${r.skill_error}`;
      setReindexResult(msg);
    } catch (e) {
      setError(String(e));
    } finally {
      setReindexing(null);
    }
  }

  return (
    <div className="h-full overflow-auto px-6 py-4">
      {/* Reindex row */}
      <div
        className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded p-3"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border)",
        }}
      >
        <div>
          <div className="text-[12.5px] font-medium">Routing catalog index</div>
          <p
            className="mt-0.5 text-[11.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Qdrant <span style={{ fontFamily: "var(--font-mono, monospace)" }}>ultron_catalog</span>{" "}
            (E5) · el warm-up automático corre al arrancar; usa Reindex si un
            skill/agente nuevo no aparece en el routing.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void runReindex("skills")}
            disabled={reindexing !== null}
            className="rounded px-3 py-1.5 text-[12px] transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            {reindexing === "skills" ? "Reindexing…" : "Reindex skills"}
          </button>
          <button
            type="button"
            onClick={() => void runReindex("full")}
            disabled={reindexing !== null}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            {reindexing === "full" ? "Reindexing…" : "Reindex all"}
          </button>
        </div>
      </div>

      {reindexResult && (
        <div
          className="mb-4 rounded p-3 text-[12px]"
          style={{
            background: "rgba(63, 185, 80, 0.06)",
            border: "1px solid rgba(63, 185, 80, 0.22)",
            color: "var(--color-success)",
          }}
        >
          {reindexResult}
        </div>
      )}

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

      {/* Search row */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void runSearch();
        }}
        className="mb-3 flex items-center gap-2"
      >
        <div
          className="flex flex-1 items-center gap-2 rounded px-3 py-2"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border-strong)",
          }}
        >
          <Search size={14} className="shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="¿A quién rutearía este prompt? (p.ej. «optimiza esta query SQL lenta»)"
            className="w-full bg-transparent text-[12.5px] outline-none"
            style={{ color: "var(--color-text)" }}
          />
        </div>
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className="rounded px-2.5 py-1.5 text-[11.5px] transition-colors"
              style={{
                background: filter === f.id ? "var(--color-surface-3)" : "transparent",
                color: filter === f.id ? "var(--color-text)" : "var(--color-text-secondary)",
                border: `1px solid ${
                  filter === f.id ? "var(--color-border-strong)" : "var(--color-border)"
                }`,
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
        <button
          type="submit"
          disabled={searching || !query.trim()}
          className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
        >
          {searching ? <Loader size={13} /> : "Route"}
        </button>
      </form>

      {/* Results */}
      {hits !== null && hits.length === 0 && (
        <div
          className="rounded p-3 text-[12px]"
          style={{
            background: "rgba(210, 153, 34, 0.05)",
            border: "1px solid rgba(210, 153, 34, 0.18)",
            color: "var(--color-warn)",
          }}
        >
          0 hits. O el catálogo está vacío (usa Reindex all) o Qdrant/E5 no
          responde — el backend devuelve lista vacía en ambos casos, no
          distingue cuál.
        </div>
      )}

      {hits !== null && hits.length > 0 && (
        <div className="space-y-1.5">
          {hits.map((h, i) => (
            <div
              key={`${h.entity}-${h.name}-${i}`}
              className="flex items-start gap-3 rounded p-3"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border)",
              }}
            >
              <span
                className="mt-0.5 shrink-0"
                style={{ color: "var(--color-text-tertiary)" }}
                title={h.entity}
              >
                {h.entity === "agent" ? <Bot size={14} /> : <Sparkle size={14} />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-[12.5px] font-medium">{h.name}</span>
                  <span
                    className="text-[10px] uppercase tracking-wide"
                    style={{ color: "var(--color-text-faint)" }}
                  >
                    {h.entity}
                    {h.kind ? ` · ${h.kind}` : ""}
                  </span>
                </div>
                {h.description && (
                  <p
                    className="mt-0.5 truncate text-[11.5px]"
                    style={{ color: "var(--color-text-secondary)" }}
                    title={h.description}
                  >
                    {h.description}
                  </p>
                )}
              </div>
              <span
                className="shrink-0 text-[12px] font-semibold tabular-nums"
                style={{ color: scoreColor(h.score) }}
                title="Cosine similarity (E5)"
              >
                {h.score.toFixed(3)}
              </span>
            </div>
          ))}
        </div>
      )}

      {hits === null && !error && (
        <p className="text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          Escribe un prompt y pulsa Route para ver el top-8 de especialistas
          (agentes + skills) por similitud semántica — el mismo índice que usa
          el orquestador para delegar.
        </p>
      )}
    </div>
  );
}
