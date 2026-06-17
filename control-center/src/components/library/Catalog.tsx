// Catalog sub-tab — discover and install skills, agents, rules and MCP servers
// from GitHub. Each result card has a fixed uniform height.
//
// Per-card action: "Integrar con IA" spawns a Claude session that analyses the
// repo and installs it if it is worth it — this is the AI integration path.
// Filter bar: min-stars and topic chips. Cards are uniform 220px tall.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { analyzeLocalRepo } from "../../lib/library-client";
import type { AnalyzeRepoResult } from "../../types";
import { getPrompt } from "../../lib/button-prompts";
import {
  AlertTriangle,
  Check,
  Clipboard,
  Compass,
  Folder,
  Github,
  Loader,
  Search,
  Sparkles,
  X,
} from "./icons";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RepoHit = {
  full_name: string;
  owner: string;
  name: string;
  description: string | null;
  stars: number;
  language: string | null;
  html_url: string | null;
  updated_at: string | null;
  topics: string[];
};

type SearchTab = "trending" | "skills" | "agents" | "rules" | "mcps" | "repos";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TABS: { id: SearchTab; label: string; hint: string }[] = [
  { id: "trending", label: "Trending", hint: "Recent claude-flavoured repos" },
  { id: "skills", label: "Skills", hint: "topic:claude-skill" },
  { id: "agents", label: "Agents", hint: "topic:claude-agent" },
  { id: "rules", label: "Rules", hint: "topic:claude-rules" },
  { id: "mcps", label: "MCPs", hint: "topic:mcp-server" },
  { id: "repos", label: "Repos", hint: "Free-text repo search" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatStars(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toString();
}

function queryForTab(tab: SearchTab, raw: string): string {
  const q = raw.trim();
  switch (tab) {
    case "skills":
      return q ? `${q} topic:claude-skill` : "topic:claude-skill stars:>5 sort:updated";
    case "agents":
      return q ? `${q} topic:claude-agent` : "topic:claude-agent stars:>5 sort:updated";
    case "rules":
      return q ? `${q} topic:claude-rules` : "topic:claude-rules stars:>1 sort:updated";
    case "mcps":
      return q ? `${q} topic:mcp-server` : "topic:mcp-server stars:>10 sort:updated";
    case "repos":
      return q || "claude-code stars:>20 sort:updated";
    case "trending":
      return q;
  }
}

function repoUrl(hit: RepoHit): string {
  return hit.html_url ?? `https://github.com/${hit.full_name}`;
}



// ---------------------------------------------------------------------------
// FilterBar (v2.9.8)
// ---------------------------------------------------------------------------

type FilterState = {
  minStars: number;
  topics: string[];
};

type FilterBarProps = {
  filters: FilterState;
  allTopics: string[];
  onFiltersChange: (f: FilterState) => void;
};

function FilterBar({
  filters,
  allTopics,
  onFiltersChange,
}: FilterBarProps) {
  function update(partial: Partial<FilterState>) {
    onFiltersChange({ ...filters, ...partial });
  }

  function toggleTopic(t: string) {
    const next = filters.topics.includes(t)
      ? filters.topics.filter((x) => x !== t)
      : [...filters.topics, t];
    update({ topics: next });
  }

  const hasActive =
    filters.minStars > 0 ||
    filters.topics.length > 0;

  return (
    <div
      className="flex flex-wrap items-center gap-2 border-t px-6 py-2 text-[11.5px]"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
    >
      {/* Min stars */}
      <label className="flex items-center gap-1.5" style={{ color: "var(--color-text-secondary)" }}>
        <span className="shrink-0">Min ★</span>
        <input
          type="number"
          min={0}
          value={filters.minStars}
          onChange={(e) => update({ minStars: Math.max(0, Number(e.target.value)) })}
          className="w-16 rounded border px-1.5 py-0.5 text-[11px] outline-none"
          style={{
            background: "var(--color-surface-2)",
            borderColor: "var(--color-border-strong)",
            color: "var(--color-text)",
          }}
        />
      </label>

      {/* Topic chips (top 10 to avoid overflow) */}
      {allTopics.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span style={{ color: "var(--color-text-tertiary)" }}>Topic:</span>
          {allTopics.slice(0, 10).map((t) => {
            const active = filters.topics.includes(t);
            return (
              <button
                key={t}
                type="button"
                onClick={() => toggleTopic(t)}
                className="rounded px-1.5 py-0.5 text-[10.5px] transition-colors"
                style={{
                  background: active ? "var(--color-accent)" : "var(--color-surface-3)",
                  color: active ? "var(--color-accent-text)" : "var(--color-text-secondary)",
                  border: `1px solid ${active ? "var(--color-accent)" : "var(--color-border)"}`,
                }}
              >
                {t}
              </button>
            );
          })}
        </div>
      )}

      {/* Clear */}
      {hasActive && (
        <button
          type="button"
          onClick={() => onFiltersChange({ minStars: 0, topics: [] })}
          className="ml-auto flex items-center gap-1 rounded px-2 py-0.5 text-[10.5px]"
          style={{
            color: "var(--color-text-secondary)",
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
          }}
        >
          <X size={10} /> Clear filters
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// LocalRepoAnalyzer (iter-10) — wires `analyze_local_repo`
// ---------------------------------------------------------------------------
//
// Scans a repo ALREADY on disk for skills/agents and runs the SAME post-install
// integration a GitHub install does (sync-registry catalog refresh + a governed
// memory candidate in the inbox). Read-only — copies nothing. Surfaces the
// returned `AnalyzeRepoResult` (assets found, newly detected, candidate id,
// non-fatal warnings) so the previously-orphan command has a consumer.

function LocalRepoAnalyzer() {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalyzeRepoResult | null>(null);

  async function pickFolder() {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "Selecciona el repo local a analizar",
      });
      if (typeof picked === "string") setPath(picked);
    } catch (e) {
      setError(String(e));
    }
  }

  async function analyze() {
    const p = path.trim();
    if (!p) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await analyzeLocalRepo(p);
      setResult(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const integration = result?.integration;

  return (
    <div
      className="border-t px-6 py-3 text-[12px]"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
    >
      <div className="mb-2 flex items-center gap-2" style={{ color: "var(--color-text-secondary)" }}>
        <Folder size={14} />
        <span className="font-medium">Analizar repo local</span>
        <span className="text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
          Escanea skills/agentes ya en disco y los integra al catálogo + memoria (read-only).
        </span>
      </div>

      <div className="flex items-center gap-2">
        <input
          type="text"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void analyze(); }}
          placeholder="Ruta del repo (o usa Examinar…)"
          className="flex-1 rounded-md border px-2.5 py-1.5 text-[12px] outline-none"
          style={{ background: "var(--color-surface-2)", borderColor: "var(--color-border-strong)", color: "var(--color-text)", fontFamily: "var(--font-mono)" }}
        />
        <button
          type="button"
          onClick={() => void pickFolder()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[11.5px] disabled:opacity-60"
          style={{ borderColor: "var(--color-border-strong)", background: "var(--color-surface-2)", color: "var(--color-text)" }}
        >
          <Folder size={12} /> Examinar…
        </button>
        <button
          type="button"
          onClick={() => void analyze()}
          disabled={busy || !path.trim()}
          className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11.5px] font-medium disabled:opacity-60"
          style={{ background: "var(--color-accent)", color: "var(--color-accent-text)", border: "1px solid var(--color-border-strong)" }}
        >
          {busy ? <><Loader size={12} className="animate-spin" /> Analizando…</> : <><Sparkles size={12} /> Analizar</>}
        </button>
      </div>

      {error && (
        <div
          className="mt-2 rounded-md border p-2 text-[11.5px]"
          style={{ background: "rgba(248, 81, 73, 0.06)", borderColor: "rgba(248, 81, 73, 0.22)", color: "var(--color-danger)" }}
        >
          <div className="flex items-center gap-1.5 font-medium"><AlertTriangle size={12} /> Fallo al analizar</div>
          <div className="mt-0.5" style={{ color: "var(--color-text-secondary)" }}>{error}</div>
        </div>
      )}

      {result && integration && (
        <div
          className="mt-2 rounded-md border p-2.5 text-[11.5px]"
          style={{ background: "var(--color-surface-2)", borderColor: "var(--color-border-strong)", color: "var(--color-text)" }}
        >
          <div className="mb-1 flex items-center gap-1.5 font-medium" style={{ color: "var(--color-success)" }}>
            <Check size={12} /> Analizado
          </div>
          <div className="space-y-1" style={{ color: "var(--color-text-secondary)" }}>
            <div>
              <span style={{ color: "var(--color-text-tertiary)" }}>Ruta: </span>
              <span style={{ fontFamily: "var(--font-mono)" }}>{result.repo_path}</span>
            </div>
            <div>
              <span style={{ color: "var(--color-text-tertiary)" }}>Skills/agentes detectados ({result.assets.length}): </span>
              {result.assets.length > 0 ? (
                <span className="flex flex-wrap gap-1 pt-1">
                  {result.assets.map((a) => (
                    <span
                      key={a}
                      className="rounded px-1.5 py-0.5 text-[10px]"
                      style={{ background: "var(--color-surface-3)", color: "var(--color-text-secondary)", border: "1px solid var(--color-border)", fontFamily: "var(--font-mono)" }}
                    >
                      {a}
                    </span>
                  ))}
                </span>
              ) : (
                <span style={{ color: "var(--color-text-tertiary)" }}>(ninguno)</span>
              )}
            </div>
            <div>
              <span style={{ color: "var(--color-text-tertiary)" }}>Catálogo: </span>
              {integration.registry_synced
                ? `sincronizado (${integration.newly_detected} nuevos detectados)`
                : "no sincronizado"}
            </div>
            <div>
              <span style={{ color: "var(--color-text-tertiary)" }}>Candidato de memoria: </span>
              {integration.memory_candidate_id
                ? <span style={{ fontFamily: "var(--font-mono)" }}>{integration.memory_candidate_id}</span>
                : "ninguno"}
            </div>
            {integration.warnings.length > 0 && (
              <ul className="list-inside list-disc pt-0.5" style={{ color: "var(--color-warning, var(--color-text-tertiary))" }}>
                {integration.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Catalog component
// ---------------------------------------------------------------------------

export function Catalog() {
  // Search engine state
  const [tab, setTab] = useState<SearchTab>("trending");
  // `query` drives the live local filter (name/description/topics, case-insensitive).
  const [query, setQuery] = useState("");
  // `appliedQuery` is the text last sent to the GitHub API (on Enter / Search).
  // Kept separate so typing filters instantly without re-fetching on every keystroke.
  const [appliedQuery, setAppliedQuery] = useState("");
  const [hits, setHits] = useState<RepoHit[]>([]);
  const [hitsLoading, setHitsLoading] = useState(false);
  const [hitsError, setHitsError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<Record<string, "copied">>({});
  // Per-card "Integrar con IA" feedback: launching → launched (resets after 2 s).
  const [aiState, setAiState] = useState<Record<string, "launching" | "launched">>({});
  const [refreshTick, setRefreshTick] = useState(0);

  // Filter state
  const [filters, setFilters] = useState<FilterState>({
    minStars: 0,
    topics: [],
  });

  // ---------------------------------------------------------------------------
  // Derived filter data
  // ---------------------------------------------------------------------------

  const allTopics = Array.from(
    new Set(hits.flatMap((h) => h.topics))
  ).sort();

  // Live local text filter — applied on top of the fetched hits without
  // re-querying GitHub. Matches name, owner, full_name, description and topics,
  // case-insensitively. Empty query = no text filtering.
  const textNeedle = query.trim().toLowerCase();

  const filteredHits = hits.filter((h) => {
    if (textNeedle) {
      const haystack = [
        h.name,
        h.owner,
        h.full_name,
        h.description ?? "",
        h.language ?? "",
        ...h.topics,
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(textNeedle)) return false;
    }
    if (filters.minStars > 0 && h.stars < filters.minStars) return false;
    if (filters.topics.length > 0 && !filters.topics.some((t) => h.topics.includes(t))) return false;
    return true;
  });

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  const runSearch = useCallback(async () => {
    setHitsLoading(true);
    setHitsError(null);
    try {
      if (tab === "trending") {
        const results = (await invoke("github_search_trending", { kind: null, limit: 30 })) as RepoHit[];
        setHits(results);
      } else {
        const composed = queryForTab(tab, appliedQuery);
        const results = (await invoke("github_search_repos", { query: composed, limit: 30 })) as RepoHit[];
        setHits(results);
      }
    } catch (e) {
      setHitsError(String(e));
      setHits([]);
    } finally {
      setHitsLoading(false);
    }
  }, [tab, appliedQuery]);

  // Commit the typed query to the GitHub API (Enter / Search button). The live
  // local filter already runs off `query` on every keystroke; this only widens
  // the result set by re-querying the remote API.
  const submitSearch = useCallback(() => {
    setAppliedQuery(query.trim());
  }, [query]);

  useEffect(() => {
    void runSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, appliedQuery, refreshTick]);

  // ---------------------------------------------------------------------------
  // Repo actions
  // ---------------------------------------------------------------------------

  async function copyToClipboard(hit: RepoHit) {
    const url = repoUrl(hit);
    try {
      await navigator.clipboard.writeText(url);
      setCopyState((s) => ({ ...s, [hit.full_name]: "copied" }));
      setTimeout(() => {
        setCopyState((s) => {
          const next = { ...s };
          delete next[hit.full_name];
          return next;
        });
      }, 1500);
    } catch {
      /* no-op */
    }
  }

  // "Integrar con IA" — opens a Claude session pre-loaded with an analysis +
  // install prompt for this repo. Reuses the existing `spawn_session` command
  // (same one the rest of the Control Center uses) so we do not need new
  // backend plumbing. The session decides whether the repo is worth installing
  // and performs the install if so.
  async function integrateWithAi(hit: RepoHit) {
    const url = repoUrl(hit);
    try {
      const meta = [
        `- Repositorio: ${hit.full_name}`,
        `- URL: ${url}`,
        hit.description ? `- Descripción: ${hit.description}` : null,
        `- Estrellas: ${hit.stars}`,
        hit.language ? `- Lenguaje principal: ${hit.language}` : null,
        hit.topics.length > 0 ? `- Topics: ${hit.topics.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join("\n");
      const prompt = await getPrompt("catalog.integrate_with_ai", {
        repo: hit.full_name,
        url,
        meta,
      });
      setAiState((s) => ({ ...s, [hit.full_name]: "launching" }));
      await invoke("spawn_session", {
        provider: "claude",
        prompt,
        cwd: null,
        flags: { dangerouslySkipPermissions: false },
      });
      setAiState((s) => ({ ...s, [hit.full_name]: "launched" }));
      setTimeout(() => {
        setAiState((s) => {
          const next = { ...s };
          delete next[hit.full_name];
          return next;
        });
      }, 2000);
    } catch (e) {
      setAiState((s) => {
        const next = { ...s };
        delete next[hit.full_name];
        return next;
      });
      setHitsError(`No se pudo lanzar la sesión de IA: ${String(e)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex h-full flex-col" style={{ background: "var(--color-surface)" }}>
      {/* HEADER */}
      <div
        className="sticky top-0 z-10 border-b"
        style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
      >
        {/* Search row */}
        <div className="px-6 py-4">
          <div className="flex items-center gap-3">
            <Compass size={18} className="shrink-0" />
            <div className="relative flex-1">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)]" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submitSearch(); }}
                placeholder="Filter results live, or press Enter to query GitHub…"
                className="w-full rounded-md border py-2.5 pl-9 pr-9 text-sm outline-none"
                style={{ background: "var(--color-surface-2)", borderColor: "var(--color-border-strong)", color: "var(--color-text)" }}
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 hover:opacity-70"
                  style={{ color: "var(--color-text-tertiary)" }}
                  title="Clear filter text"
                  aria-label="Clear filter text"
                >
                  <X size={13} />
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={submitSearch}
              disabled={hitsLoading}
              className="inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium disabled:opacity-60"
              style={{ background: "var(--color-accent)", color: "var(--color-accent-text)", border: "1px solid var(--color-border-strong)" }}
            >
              {hitsLoading ? <><Loader size={13} className="animate-spin" /> Searching</> : <><Search size={13} /> Search</>}
            </button>
            <button
              type="button"
              onClick={() => setRefreshTick((n) => n + 1)}
              disabled={hitsLoading}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-xs disabled:opacity-60"
              style={{ borderColor: "var(--color-border-strong)", background: "var(--color-surface-2)", color: "var(--color-text)" }}
              title="Re-fetch current tab"
            >
              Refresh
            </button>
          </div>

          {/* Tab strip */}
          <div className="mt-3 flex flex-wrap gap-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className="rounded-md px-3 py-1.5 text-[12.5px] transition-colors"
                style={{
                  background: tab === t.id ? "var(--color-surface-3)" : "transparent",
                  color: tab === t.id ? "var(--color-text)" : "var(--color-text-secondary)",
                  border: `1px solid ${tab === t.id ? "var(--color-border-strong)" : "var(--color-border)"}`,
                }}
                title={t.hint}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Filter bar (v2.9.8) */}
        {hits.length > 0 && (
          <FilterBar
            filters={filters}
            allTopics={allTopics}
            onFiltersChange={setFilters}
          />
        )}

        {/* Local repo analyzer (iter-10) — wires analyze_local_repo */}
        <LocalRepoAnalyzer />

      </div>

      {/* BODY */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {hitsError && (
          <div
            className="mb-3 rounded-md border p-3 text-[12.5px]"
            style={{ background: "rgba(248, 81, 73, 0.06)", borderColor: "rgba(248, 81, 73, 0.22)", color: "var(--color-danger)" }}
          >
            <div className="mb-1 flex items-center gap-2 font-medium">
              <AlertTriangle size={13} /> GitHub search failed
            </div>
            <div className="text-[11.5px]" style={{ color: "var(--color-text-secondary)" }}>{hitsError}</div>
          </div>
        )}

        {hitsLoading && hits.length === 0 && (
          <div className="flex items-center gap-2 text-[12.5px]" style={{ color: "var(--color-text-tertiary)" }}>
            <Loader size={13} className="animate-spin" />
            Loading {TABS.find((t) => t.id === tab)?.label.toLowerCase()}…
          </div>
        )}

        {!hitsLoading && hits.length === 0 && !hitsError && (
          <p className="text-[12.5px]" style={{ color: "var(--color-text-tertiary)" }}>
            No results for this tab. Try a different keyword or hit Refresh.
          </p>
        )}

        {filteredHits.length > 0 && (
          <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {filteredHits.map((hit) => {
              const copied = copyState[hit.full_name] === "copied";
              const aiBusy = aiState[hit.full_name];
              return (
                <li
                  key={hit.full_name}
                  className="flex h-[220px] flex-col rounded-md border p-3 text-[12px]"
                  style={{
                    background: "var(--color-surface-2)",
                    borderColor: "var(--color-border-strong)",
                    color: "var(--color-text)",
                  }}
                >
                  {/* Card header */}
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <Github size={12} className="shrink-0 text-[var(--color-text-tertiary)]" />
                    <span className="font-medium">{hit.name}</span>
                    <span className="text-[10.5px]" style={{ color: "var(--color-text-tertiary)", fontFamily: "var(--font-mono)" }}>
                      {hit.owner}
                    </span>
                    <span className="rounded px-1.5 py-0.5 text-[10px]" style={{ background: "var(--color-surface-3)", color: "var(--color-text-secondary)" }} title="Stars">
                      ★ {formatStars(hit.stars)}
                    </span>
                    {hit.language && (
                      <span className="rounded px-1.5 py-0.5 text-[10px]" style={{ background: "var(--color-surface-3)", color: "var(--color-text-tertiary)" }}>
                        {hit.language}
                      </span>
                    )}
                  </div>

                  {/* Middle section grows to push footer to bottom */}
                  <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                  {/* Description */}
                  {hit.description && (
                    <p className="mb-1.5 line-clamp-2 text-[11.5px] leading-snug" style={{ color: "var(--color-text-secondary)" }}>
                      {hit.description}
                    </p>
                  )}

                  {/* Topics */}
                  {hit.topics.length > 0 && (
                    <div className="flex flex-wrap gap-1 overflow-hidden" style={{ maxHeight: "3rem" }}>
                      {hit.topics.slice(0, 5).map((t) => (
                        <span
                          key={t}
                          className="rounded px-1.5 py-0.5 text-[9.5px]"
                          style={{ background: "var(--color-surface-3)", color: "var(--color-text-tertiary)", border: "1px solid var(--color-border)" }}
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                  </div>

                  {/* Footer: full_name + action buttons — always pinned at bottom */}
                  <div className="mt-2 flex flex-col gap-1.5 text-[10.5px]" style={{ color: "var(--color-text-tertiary)" }}>
                    <span className="truncate" style={{ fontFamily: "var(--font-mono)" }} title={hit.full_name}>
                      {hit.full_name}
                    </span>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {/* Integrar con IA — spawns an analysis + install session */}
                      <button
                        type="button"
                        onClick={() => void integrateWithAi(hit)}
                        disabled={!!aiBusy}
                        className="inline-flex items-center gap-1 rounded px-2 py-1 font-medium disabled:opacity-60"
                        style={{
                          color: aiBusy ? "var(--color-success)" : "var(--color-accent-text)",
                          background: aiBusy ? "rgba(63, 185, 80, 0.12)" : "var(--color-accent)",
                          border: aiBusy ? "1px solid rgba(63, 185, 80, 0.30)" : "1px solid var(--color-border-strong)",
                          fontSize: "10.5px",
                        }}
                        title="Lanza una sesión de IA que analiza si vale la pena instalarlo y lo instala"
                      >
                        {aiBusy === "launching" ? (
                          <><Loader size={11} className="animate-spin" /> Lanzando…</>
                        ) : aiBusy === "launched" ? (
                          <><Check size={11} /> Lanzado</>
                        ) : (
                          <><Sparkles size={11} /> Integrar con IA</>
                        )}
                      </button>

                      {/* Copiar repo URL */}
                      <button
                        type="button"
                        onClick={() => void copyToClipboard(hit)}
                        className="inline-flex items-center gap-1 rounded px-2 py-1 font-medium"
                        style={{
                          color: copied ? "var(--color-success)" : "var(--color-text)",
                          background: copied ? "rgba(63, 185, 80, 0.12)" : "var(--color-surface-3)",
                          border: copied ? "1px solid rgba(63, 185, 80, 0.30)" : "1px solid var(--color-border)",
                          fontSize: "10.5px",
                        }}
                        title="Copiar la URL del repo al portapapeles"
                      >
                        {copied ? <Check size={11} /> : <Clipboard size={11} />}
                        {copied ? "Copiado!" : "Copiar"}
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {/* Empty-state when the live filter / filter bar removes all results */}
        {!hitsLoading && hits.length > 0 && filteredHits.length === 0 && (
          <p className="text-[12.5px]" style={{ color: "var(--color-text-tertiary)" }}>
            {textNeedle
              ? `No results contain “${query.trim()}”. Clear the filter text or press Enter to query GitHub.`
              : "No items match the active filters. Adjust min-stars or topic, or clear filters."}
          </p>
        )}
      </div>

    </div>
  );
}

export default Catalog;
