// Catalog sub-tab — full redesign (v2.6.2, fb-100).
//
// Previous behaviour: rendered a curated JSON catalog with two-pane filters
// for skill/agent. The user wanted a real discovery surface — "Trending
// repos + skills + agents + rules + MCPs + full repos, with search".
//
// New behaviour: search-engine layout.
//   - Big search bar at the top ("Search GitHub repos, skills, agents…").
//   - Tab strip below: Trending | Skills | Agents | Rules | MCPs | Repos.
//     Each tab fires a backend search with a tailored query:
//       Trending  → github_search_trending (no filter, latest claude-flavoured)
//       Skills    → topic:claude-skill OR `SKILL.md`
//       Agents    → topic:claude-agent
//       Rules     → topic:claude-rules / topic:claude-code-rules
//       MCPs      → topic:mcp-server OR topic:model-context-protocol
//       Repos     → free-text search on whatever the user typed
//   - Each result is a card: name + owner, stars, language, topics, short
//     description, "Open" and "Install" actions. Install copies the repo
//     URL to the clipboard for now (backend repo-clone install is on the
//     roadmap — see backlog).
//   - The legacy curated list survives as a collapsed section at the
//     bottom so the seed entries are not lost.

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  Bot,
  Check,
  Clipboard,
  Compass,
  Download,
  ExternalLink,
  Github,
  Loader,
  Search,
  Sparkle,
} from "./icons";

type CatalogKind = "skill" | "agent";

type CatalogItem = {
  kind: CatalogKind;
  name: string;
  title: string;
  owner: string;
  repo: string;
  path: string;
  summary: string;
  dead?: boolean;
  dead_reason?: string;
};

type CatalogDomain = {
  id: string;
  label: string;
  description: string;
  items: CatalogItem[];
};

type CatalogPayload = {
  schema_version?: number;
  updated_at?: string | null;
  domains: CatalogDomain[];
};

type ItemState =
  | { kind: "idle" }
  | { kind: "installing" }
  | { kind: "done"; path: string }
  | { kind: "error"; message: string };

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

const TABS: { id: SearchTab; label: string; hint: string }[] = [
  { id: "trending", label: "Trending", hint: "Recent claude-flavoured repos" },
  { id: "skills", label: "Skills", hint: "topic:claude-skill" },
  { id: "agents", label: "Agents", hint: "topic:claude-agent" },
  { id: "rules", label: "Rules", hint: "topic:claude-rules" },
  { id: "mcps", label: "MCPs", hint: "topic:mcp-server" },
  { id: "repos", label: "Repos", hint: "Free-text repo search" },
];

function itemKey(it: CatalogItem): string {
  return `${it.owner}/${it.repo}/${it.path}`;
}

function formatStars(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toString();
}

/// Compose the GitHub search query for a given tab + user query.
function queryForTab(tab: SearchTab, raw: string): string {
  const q = raw.trim();
  switch (tab) {
    case "skills":
      return q
        ? `${q} topic:claude-skill`
        : "topic:claude-skill stars:>5 sort:updated";
    case "agents":
      return q
        ? `${q} topic:claude-agent`
        : "topic:claude-agent stars:>5 sort:updated";
    case "rules":
      return q
        ? `${q} topic:claude-rules`
        : "topic:claude-rules stars:>1 sort:updated";
    case "mcps":
      return q
        ? `${q} topic:mcp-server`
        : "topic:mcp-server stars:>10 sort:updated";
    case "repos":
      return q || "claude-code stars:>20 sort:updated";
    case "trending":
      return q; // unused — trending uses dedicated backend command
  }
}

export function Catalog() {
  // Curated catalog (legacy)
  const [data, setData] = useState<CatalogPayload | null>(null);
  const [legacyError, setLegacyError] = useState<string | null>(null);
  const [legacyLoading, setLegacyLoading] = useState(true);
  const [legacyOpen, setLegacyOpen] = useState(false);
  const [state, setState] = useState<Record<string, ItemState>>({});

  // Search engine
  const [tab, setTab] = useState<SearchTab>("trending");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<RepoHit[]>([]);
  const [hitsLoading, setHitsLoading] = useState(false);
  const [hitsError, setHitsError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<Record<string, "copied">>({});
  const [refreshTick, setRefreshTick] = useState(0);

  // Load legacy curated catalog lazily (only when user expands it).
  useEffect(() => {
    if (!legacyOpen || data) return;
    let cancelled = false;
    async function load() {
      setLegacyLoading(true);
      try {
        const res = (await invoke("read_curated_catalog")) as CatalogPayload;
        if (cancelled) return;
        setData(res);
      } catch (e) {
        if (!cancelled) setLegacyError(String(e));
      } finally {
        if (!cancelled) setLegacyLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [legacyOpen, data]);

  // Run the search whenever the tab changes, when the user submits a
  // manual query (Enter), or when a Refresh is requested.
  const runSearch = useCallback(async () => {
    setHitsLoading(true);
    setHitsError(null);
    try {
      if (tab === "trending") {
        const results = (await invoke("github_search_trending", {
          kind: null,
          limit: 30,
        })) as RepoHit[];
        setHits(results);
      } else {
        const composed = queryForTab(tab, query);
        const results = (await invoke("github_search_repos", {
          query: composed,
          limit: 30,
        })) as RepoHit[];
        setHits(results);
      }
    } catch (e) {
      setHitsError(String(e));
      setHits([]);
    } finally {
      setHitsLoading(false);
    }
  }, [tab, query]);

  // Auto-run on tab change so each tab arrives populated.
  useEffect(() => {
    void runSearch();
    // We deliberately don't depend on `query` here — query updates only
    // fire a new search on Enter to avoid hammering the GitHub API.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, refreshTick]);

  async function install(it: CatalogItem) {
    const key = itemKey(it);
    setState((s) => ({ ...s, [key]: { kind: "installing" } }));
    try {
      const installed = (await invoke("library_install_from_github", {
        args: {
          owner: it.owner,
          repo: it.repo,
          path: it.path,
          kind: it.kind,
          target_scope: "global",
          target_project_id: null,
          target_name: null,
          overwrite: false,
        },
      })) as string;
      setState((s) => ({ ...s, [key]: { kind: "done", path: installed } }));
    } catch (e) {
      setState((s) => ({
        ...s,
        [key]: { kind: "error", message: String(e) },
      }));
    }
  }

  async function openRepo(hit: RepoHit) {
    const url = hit.html_url ?? `https://github.com/${hit.full_name}`;
    try {
      await openPath(url);
    } catch {
      void copyRepoUrl(hit);
    }
  }

  async function copyRepoUrl(hit: RepoHit) {
    const url = hit.html_url ?? `https://github.com/${hit.full_name}`;
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

  const legacyDomains = useMemo<CatalogDomain[]>(() => {
    if (!data) return [];
    return data.domains;
  }, [data]);

  return (
    <div className="flex h-full flex-col">
      {/* HEADER — big search bar */}
      <div
        className="border-b px-6 py-4"
        style={{ borderColor: "var(--color-border)" }}
      >
        <div className="flex items-center gap-3">
          <Compass size={18} className="shrink-0" />
          <div className="relative flex-1">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)]"
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void runSearch();
              }}
              placeholder="Search GitHub repos, skills, agents, rules, MCPs…"
              className="w-full rounded-md border py-2.5 pl-9 pr-3 text-sm outline-none"
              style={{
                background: "var(--color-surface-2)",
                borderColor: "var(--color-border-strong)",
                color: "var(--color-text)",
              }}
            />
          </div>
          <button
            type="button"
            onClick={() => void runSearch()}
            disabled={hitsLoading}
            className="inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium disabled:opacity-60"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            {hitsLoading ? (
              <>
                <Loader size={13} className="animate-spin" /> Searching
              </>
            ) : (
              <>
                <Search size={13} /> Search
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() => setRefreshTick((n) => n + 1)}
            disabled={hitsLoading}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-xs disabled:opacity-60"
            style={{
              borderColor: "var(--color-border-strong)",
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
            }}
            title="Re-fetch current tab"
          >
            Refresh
          </button>
        </div>
        {/* TAB STRIP */}
        <div className="mt-3 flex flex-wrap gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className="rounded-md px-3 py-1.5 text-[12.5px] transition-colors"
              style={{
                background:
                  tab === t.id ? "var(--color-surface-3)" : "transparent",
                color:
                  tab === t.id
                    ? "var(--color-text)"
                    : "var(--color-text-secondary)",
                border: `1px solid ${
                  tab === t.id
                    ? "var(--color-border-strong)"
                    : "var(--color-border)"
                }`,
              }}
              title={t.hint}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* BODY */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {hitsError && (
          <div
            className="mb-3 rounded-md border p-3 text-[12.5px]"
            style={{
              background: "rgba(248, 81, 73, 0.06)",
              borderColor: "rgba(248, 81, 73, 0.22)",
              color: "var(--color-danger)",
            }}
          >
            <div className="mb-1 flex items-center gap-2 font-medium">
              <AlertTriangle size={13} /> GitHub search failed
            </div>
            <div
              className="text-[11.5px]"
              style={{ color: "var(--color-text-secondary)" }}
            >
              {hitsError}
            </div>
          </div>
        )}

        {hitsLoading && hits.length === 0 && (
          <div
            className="flex items-center gap-2 text-[12.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            <Loader size={13} className="animate-spin" />
            Loading {TABS.find((t) => t.id === tab)?.label.toLowerCase()}…
          </div>
        )}

        {!hitsLoading && hits.length === 0 && !hitsError && (
          <p
            className="text-[12.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            No results for this tab. Try a different keyword or hit Refresh.
          </p>
        )}

        {hits.length > 0 && (
          <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {hits.map((hit) => {
              const copied = copyState[hit.full_name] === "copied";
              return (
                <li
                  key={hit.full_name}
                  className="rounded-md border p-3 text-[12px]"
                  style={{
                    background: "var(--color-surface-2)",
                    borderColor: "var(--color-border-strong)",
                    color: "var(--color-text)",
                  }}
                >
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <Github
                      size={12}
                      className="shrink-0 text-[var(--color-text-tertiary)]"
                    />
                    <span className="font-medium">{hit.name}</span>
                    <span
                      className="text-[10.5px]"
                      style={{
                        color: "var(--color-text-tertiary)",
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      {hit.owner}
                    </span>
                    <span
                      className="rounded px-1.5 py-0.5 text-[10px]"
                      style={{
                        background: "var(--color-surface-3)",
                        color: "var(--color-text-secondary)",
                      }}
                      title="Stars"
                    >
                      ★ {formatStars(hit.stars)}
                    </span>
                    {hit.language && (
                      <span
                        className="rounded px-1.5 py-0.5 text-[10px]"
                        style={{
                          background: "var(--color-surface-3)",
                          color: "var(--color-text-tertiary)",
                        }}
                      >
                        {hit.language}
                      </span>
                    )}
                  </div>
                  {hit.description && (
                    <p
                      className="mb-2 text-[11.5px] leading-snug"
                      style={{ color: "var(--color-text-secondary)" }}
                    >
                      {hit.description}
                    </p>
                  )}
                  {hit.topics.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-1">
                      {hit.topics.slice(0, 6).map((t) => (
                        <span
                          key={t}
                          className="rounded px-1.5 py-0.5 text-[9.5px]"
                          style={{
                            background: "var(--color-surface-3)",
                            color: "var(--color-text-tertiary)",
                            border: "1px solid var(--color-border)",
                          }}
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                  <div
                    className="flex items-center justify-between text-[10.5px]"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    <span style={{ fontFamily: "var(--font-mono)" }}>
                      {hit.full_name}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => void openRepo(hit)}
                        className="inline-flex items-center gap-1 rounded px-2 py-0.5"
                        style={{
                          color: "var(--color-text)",
                          background: "var(--color-surface-3)",
                        }}
                        title="Open repo on GitHub"
                      >
                        <ExternalLink size={11} />
                      </button>
                      <button
                        type="button"
                        onClick={() => void copyRepoUrl(hit)}
                        className="inline-flex items-center gap-1 rounded px-2 py-0.5"
                        style={{
                          color: copied
                            ? "var(--color-success)"
                            : "var(--color-text)",
                          background: copied
                            ? "rgba(63, 185, 80, 0.12)"
                            : "var(--color-surface-3)",
                          border: copied
                            ? "1px solid rgba(63, 185, 80, 0.30)"
                            : "1px solid var(--color-border)",
                        }}
                        title="Copy URL — full clone-into-library is on the roadmap"
                      >
                        {copied ? (
                          <>
                            <Check size={11} /> Copied
                          </>
                        ) : (
                          <>
                            <Clipboard size={11} /> Install
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {/* Legacy curated catalog — kept as a collapsed section so the
            seed entries are still reachable but no longer dominate the
            page. */}
        <section
          className="mt-6 rounded-md border"
          style={{
            background: "var(--color-surface)",
            borderColor: "var(--color-border)",
          }}
        >
          <button
            type="button"
            onClick={() => setLegacyOpen((v) => !v)}
            className="flex w-full items-center justify-between px-3 py-2 text-left"
            style={{ color: "var(--color-text)" }}
          >
            <span className="inline-flex items-center gap-2 text-[12.5px] font-semibold">
              <Compass size={13} /> Curated picks (legacy seed)
            </span>
            <span
              className="text-[11.5px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {legacyOpen ? "Hide" : "Show"}
            </span>
          </button>

          {legacyOpen && (
            <div
              className="border-t px-3 py-3"
              style={{ borderColor: "var(--color-border)" }}
            >
              {legacyLoading && (
                <div
                  className="flex items-center gap-2 text-[12px]"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  <Loader size={12} className="animate-spin" /> Loading curated
                  catalog…
                </div>
              )}
              {legacyError && (
                <div
                  className="rounded-md border p-2 text-[11.5px]"
                  style={{
                    background: "rgba(248, 81, 73, 0.06)",
                    borderColor: "rgba(248, 81, 73, 0.22)",
                    color: "var(--color-danger)",
                  }}
                >
                  {legacyError}
                </div>
              )}
              {legacyDomains.map((domain) => (
                <section key={domain.id} className="mb-4">
                  <header className="mb-1">
                    <h3 className="text-[12.5px] font-semibold">
                      {domain.label}
                    </h3>
                    <p
                      className="text-[11px]"
                      style={{ color: "var(--color-text-tertiary)" }}
                    >
                      {domain.description}
                    </p>
                  </header>
                  <ul className="grid gap-2 md:grid-cols-2">
                    {domain.items
                      .filter((it) => !it.dead)
                      .map((it) => {
                        const key = itemKey(it);
                        const st = state[key] ?? { kind: "idle" };
                        const isInstalled = st.kind === "done";
                        const isInstalling = st.kind === "installing";
                        const KindIcon = it.kind === "skill" ? Sparkle : Bot;
                        return (
                          <li
                            key={key}
                            className="rounded-md border p-2 text-[11.5px]"
                            style={{
                              background: "var(--color-surface-2)",
                              borderColor: "var(--color-border)",
                              color: "var(--color-text)",
                            }}
                          >
                            <div className="mb-1 flex items-center gap-1.5">
                              <KindIcon
                                size={11}
                                className="shrink-0 text-[var(--color-text-tertiary)]"
                              />
                              <span className="font-medium">{it.title}</span>
                              <span
                                className="rounded px-1.5 py-0.5 text-[9.5px] uppercase"
                                style={{
                                  background: "var(--color-surface-3)",
                                  color: "var(--color-text-tertiary)",
                                }}
                              >
                                {it.kind}
                              </span>
                            </div>
                            <p
                              className="mb-1 text-[11px] leading-snug"
                              style={{ color: "var(--color-text-secondary)" }}
                            >
                              {it.summary}
                            </p>
                            <div
                              className="flex items-center justify-between text-[10px]"
                              style={{ color: "var(--color-text-tertiary)" }}
                            >
                              <span style={{ fontFamily: "var(--font-mono)" }}>
                                {it.owner}/{it.repo}
                              </span>
                              <button
                                type="button"
                                onClick={() => install(it)}
                                disabled={isInstalling || isInstalled}
                                className="inline-flex items-center gap-1 rounded px-2 py-0.5"
                                style={{
                                  background: isInstalled
                                    ? "rgba(63, 185, 80, 0.12)"
                                    : "var(--color-accent)",
                                  color: isInstalled
                                    ? "var(--color-success)"
                                    : "var(--color-accent-text)",
                                  border: `1px solid ${
                                    isInstalled
                                      ? "rgba(63, 185, 80, 0.30)"
                                      : "var(--color-border-strong)"
                                  }`,
                                  cursor:
                                    isInstalled || isInstalling
                                      ? "default"
                                      : "pointer",
                                }}
                              >
                                {isInstalled ? (
                                  <>
                                    <Check size={10} /> Installed
                                  </>
                                ) : isInstalling ? (
                                  <>
                                    <Loader
                                      size={10}
                                      className="animate-spin"
                                    />{" "}
                                    Installing
                                  </>
                                ) : (
                                  <>
                                    <Download size={10} /> Install
                                  </>
                                )}
                              </button>
                            </div>
                            {st.kind === "error" && (
                              <div
                                className="mt-1 rounded px-1.5 py-0.5 text-[10px]"
                                style={{
                                  background: "rgba(248, 81, 73, 0.06)",
                                  color: "var(--color-danger)",
                                  border:
                                    "1px solid rgba(248, 81, 73, 0.22)",
                                }}
                              >
                                {st.message}
                              </div>
                            )}
                          </li>
                        );
                      })}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export default Catalog;
