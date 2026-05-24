// Catalog sub-tab — renders the curated catalog from
// ~/.ultron/cockpit/curated-catalog.json (backend cmd `read_curated_catalog`).
// One-click install of each item via `library_install_from_github`.
//
// v2.1: live preview refresh. After loading the static seed we fetch each
// item's first paragraph from GitHub raw via the backend command
// `catalog_fetch_previews` (sequential HTTPS GETs in Rust with reqwest;
// 8s per-request timeout). The fresh summary replaces the seed value if
// available, the seed wins otherwise. A Refresh button re-triggers the
// fetch on demand and shows a Loader while it's in flight.
//
// v2.6.1:
//   - Honour `dead: true` entries from the catalog (toggleable; hidden by
//     default, surfaced via a "Show stale entries" switch with a yellow
//     warning chip explaining why the URL 404s upstream).
//   - New "Search GitHub" section beneath the curated list with two modes:
//       Trending  → `github_search_trending` (recent claude-flavoured repos)
//       Search    → `github_search_repos` with the user-typed query
//     Each result is a card with stars / language / topics and an
//     ExternalLink + Clipboard-copy action. Full install flow stays inside
//     the curated catalog for now (one-click install needs the file path,
//     which repo-level search doesn't surface).

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
  // v2.6.1 — entries whose upstream URL has 404'd. Kept in the JSON for
  // history/audit trail; hidden in the GUI unless the user opts in.
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

type CatalogPreview = {
  key: string;
  summary: string | null;
  error: string | null;
};

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

type SearchMode = "trending" | "manual";
type TrendingKind = "all" | "skill" | "agent" | "mcp";

function itemKey(it: CatalogItem): string {
  return `${it.owner}/${it.repo}/${it.path}`;
}

function formatStars(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toString();
}

export function Catalog() {
  const [data, setData] = useState<CatalogPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<Record<string, ItemState>>({});
  const [filter, setFilter] = useState<"all" | CatalogKind>("all");
  const [refreshing, setRefreshing] = useState(false);
  const [previewMap, setPreviewMap] = useState<Record<string, string>>({});
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [showDead, setShowDead] = useState(false);

  // GitHub repo search panel state.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchMode, setSearchMode] = useState<SearchMode>("trending");
  const [trendingKind, setTrendingKind] = useState<TrendingKind>("all");
  const [manualQuery, setManualQuery] = useState("");
  const [hits, setHits] = useState<RepoHit[]>([]);
  const [hitsLoading, setHitsLoading] = useState(false);
  const [hitsError, setHitsError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<Record<string, "copied">>({});

  const allItems = useMemo<CatalogItem[]>(() => {
    if (!data) return [];
    return data.domains.flatMap((d) => d.items);
  }, [data]);

  const refreshPreviews = useCallback(
    async (items: CatalogItem[]) => {
      // Skip dead entries — fetching their previews wastes the 8s timeout
      // per request and the result wouldn't be displayed anyway.
      const live = items.filter((it) => !it.dead);
      if (live.length === 0) return;
      setRefreshing(true);
      try {
        const previews = (await invoke("catalog_fetch_previews", {
          items: live.map((it) => ({
            owner: it.owner,
            repo: it.repo,
            path: it.path,
          })),
        })) as CatalogPreview[];
        setPreviewMap((prev) => {
          const next = { ...prev };
          for (const p of previews) {
            if (p.summary && p.summary.trim().length > 0) {
              next[p.key] = p.summary;
            }
          }
          return next;
        });
        setRefreshedAt(new Date().toISOString());
      } catch (e) {
        // Non-fatal: seed summaries still render.
        setError((prev) => prev ?? `preview fetch: ${String(e)}`);
      } finally {
        setRefreshing(false);
      }
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const res = (await invoke("read_curated_catalog")) as CatalogPayload;
        if (cancelled) return;
        setData(res);
        // Kick off a non-blocking refresh of live summaries on first mount.
        const items = res.domains.flatMap((d) => d.items);
        void refreshPreviews(items);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [refreshPreviews]);

  const filteredDomains = useMemo(() => {
    if (!data) return [];
    return data.domains
      .map((d) => ({
        ...d,
        items: d.items.filter((it) => {
          if (filter !== "all" && it.kind !== filter) return false;
          if (!showDead && it.dead) return false;
          return true;
        }),
      }))
      .filter((d) => d.items.length > 0);
  }, [data, filter, showDead]);

  const deadCount = useMemo(
    () => allItems.filter((it) => it.dead).length,
    [allItems],
  );

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

  async function openSource(it: CatalogItem) {
    const url = `https://github.com/${it.owner}/${it.repo}/blob/main/${it.path}`;
    try {
      await openPath(url);
    } catch {
      setState((s) => ({
        ...s,
        [itemKey(it)]: { kind: "error", message: `Open manually: ${url}` },
      }));
    }
  }

  // --- GitHub repo search handlers --------------------------------------

  const runTrending = useCallback(async () => {
    setHitsLoading(true);
    setHitsError(null);
    try {
      const results = (await invoke("github_search_trending", {
        kind: trendingKind === "all" ? null : trendingKind,
        limit: 24,
      })) as RepoHit[];
      setHits(results);
    } catch (e) {
      setHitsError(String(e));
      setHits([]);
    } finally {
      setHitsLoading(false);
    }
  }, [trendingKind]);

  const runManual = useCallback(async () => {
    const q = manualQuery.trim();
    if (q.length === 0) return;
    setHitsLoading(true);
    setHitsError(null);
    try {
      const results = (await invoke("github_search_repos", {
        query: q,
        limit: 24,
      })) as RepoHit[];
      setHits(results);
    } catch (e) {
      setHitsError(String(e));
      setHits([]);
    } finally {
      setHitsLoading(false);
    }
  }, [manualQuery]);

  async function openRepo(hit: RepoHit) {
    const url = hit.html_url ?? `https://github.com/${hit.full_name}`;
    try {
      await openPath(url);
    } catch {
      // Best-effort: fall through to clipboard if the OS link handler fails.
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
      // No-op — clipboard refusal is rare in a Tauri webview.
    }
  }

  if (loading) {
    return (
      <div
        className="flex h-full items-center justify-center text-[12px]"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        <Loader size={14} className="mr-2 animate-spin" />
        Loading catalog…
      </div>
    );
  }

  if (error && !data) {
    return (
      <div
        className="m-6 rounded-md border p-4 text-[12.5px]"
        style={{
          background: "rgba(248, 81, 73, 0.06)",
          borderColor: "rgba(248, 81, 73, 0.22)",
          color: "var(--color-danger)",
        }}
      >
        <div className="mb-1 flex items-center gap-2 font-medium">
          <AlertTriangle size={14} /> Could not load curated-catalog.json
        </div>
        <div
          className="text-[11.5px]"
          style={{ color: "var(--color-text-secondary)" }}
        >
          {error}
        </div>
      </div>
    );
  }

  if (!data || data.domains.length === 0) {
    return (
      <div
        className="m-6 rounded-md border p-6 text-[12.5px]"
        style={{
          background: "var(--color-surface-2)",
          borderColor: "var(--color-border)",
        }}
      >
        <div className="mb-2 flex items-center gap-2 font-medium">
          <Compass size={14} /> Catalog is empty
        </div>
        <p
          className="text-[11.5px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Edit{" "}
          <code style={{ fontFamily: "var(--font-mono)" }}>
            ~/.ultron/cockpit/curated-catalog.json
          </code>{" "}
          to add domains and items.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div
        className="flex items-center justify-between gap-3 border-b px-6 py-3"
        style={{ borderColor: "var(--color-border)" }}
      >
        <div
          className="flex min-w-0 items-center gap-2 text-[12px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          <Compass size={14} />
          <span className="truncate">
            Curated picks for graphics, UE5, AI, and MCP work · seed{" "}
            {data.updated_at ?? "—"}
            {refreshedAt && (
              <>
                {" "}
                · live{" "}
                {new Date(refreshedAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </>
            )}
            {deadCount > 0 && (
              <>
                {" "}
                ·{" "}
                <span style={{ color: "var(--color-warning, #d29922)" }}>
                  {deadCount} stale
                </span>
              </>
            )}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {deadCount > 0 && (
            <button
              type="button"
              onClick={() => setShowDead((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11.5px]"
              style={{
                borderColor: "var(--color-border-strong)",
                background: showDead
                  ? "var(--color-surface-3)"
                  : "var(--color-surface-2)",
                color: "var(--color-text)",
              }}
              title={
                showDead
                  ? "Hide entries whose upstream URL 404s"
                  : "Show entries whose upstream URL 404s"
              }
            >
              <AlertTriangle size={11} />
              {showDead ? "Hide stale" : `Show stale (${deadCount})`}
            </button>
          )}
          <button
            type="button"
            onClick={() => void refreshPreviews(allItems)}
            disabled={refreshing || allItems.length === 0}
            className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11.5px] disabled:opacity-60"
            style={{
              borderColor: "var(--color-border-strong)",
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
            }}
            title="Re-fetch live summaries from GitHub raw"
          >
            {refreshing ? (
              <>
                <Loader size={11} className="animate-spin" /> Refreshing
              </>
            ) : (
              <>Refresh from GitHub</>
            )}
          </button>
          <div className="flex gap-1">
            {(["all", "skill", "agent"] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className="rounded-md px-2.5 py-1 text-[11.5px] transition-colors"
                style={{
                  background:
                    filter === f ? "var(--color-surface-3)" : "transparent",
                  color:
                    filter === f
                      ? "var(--color-text)"
                      : "var(--color-text-secondary)",
                  border: `1px solid ${
                    filter === f
                      ? "var(--color-border-strong)"
                      : "transparent"
                  }`,
                }}
              >
                {f === "all" ? "All" : f === "skill" ? "Skills" : "Agents"}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {filteredDomains.map((domain) => (
          <section key={domain.id} className="mb-6">
            <header className="mb-2">
              <h3 className="text-[13px] font-semibold">{domain.label}</h3>
              <p
                className="text-[11.5px]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {domain.description}
              </p>
            </header>
            <ul className="grid gap-2 md:grid-cols-2">
              {domain.items.map((it) => {
                const key = itemKey(it);
                const st = state[key] ?? { kind: "idle" };
                const isInstalled = st.kind === "done";
                const isInstalling = st.kind === "installing";
                const KindIcon = it.kind === "skill" ? Sparkle : Bot;
                const liveSummary = previewMap[key];
                const summary = liveSummary ?? it.summary;
                const isDead = it.dead === true;
                return (
                  <li
                    key={key}
                    className="rounded-md border p-3 text-[12px]"
                    style={{
                      background: "var(--color-surface-2)",
                      borderColor: isDead
                        ? "rgba(210, 153, 34, 0.30)"
                        : "var(--color-border-strong)",
                      color: "var(--color-text)",
                      opacity: isDead ? 0.78 : 1,
                    }}
                  >
                    <div className="mb-1 flex items-center gap-2">
                      <KindIcon
                        size={12}
                        className="shrink-0 text-[var(--color-text-tertiary)]"
                      />
                      <span className="font-medium">{it.title}</span>
                      <span
                        className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide"
                        style={{
                          background: "var(--color-surface-3)",
                          color: "var(--color-text-tertiary)",
                        }}
                      >
                        {it.kind}
                      </span>
                      {isDead && (
                        <span
                          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]"
                          style={{
                            background: "rgba(210, 153, 34, 0.12)",
                            color: "var(--color-warning, #d29922)",
                            border: "1px solid rgba(210, 153, 34, 0.30)",
                          }}
                          title={
                            it.dead_reason ?? "Upstream URL 404s as of last verification."
                          }
                        >
                          <AlertTriangle size={9} /> 404
                        </span>
                      )}
                      {liveSummary && !isDead && (
                        <span
                          className="rounded px-1.5 py-0.5 text-[10px]"
                          style={{
                            background: "rgba(63, 185, 80, 0.12)",
                            color: "var(--color-success)",
                            border: "1px solid rgba(63, 185, 80, 0.30)",
                          }}
                          title="Summary fetched from GitHub raw"
                        >
                          live
                        </span>
                      )}
                    </div>
                    <p
                      className="mb-2 text-[11.5px] leading-snug"
                      style={{ color: "var(--color-text-secondary)" }}
                    >
                      {summary}
                    </p>
                    {isDead && it.dead_reason && (
                      <p
                        className="mb-2 rounded px-2 py-1 text-[10.5px] leading-snug"
                        style={{
                          background: "rgba(210, 153, 34, 0.08)",
                          color: "var(--color-warning, #d29922)",
                          border: "1px solid rgba(210, 153, 34, 0.22)",
                        }}
                      >
                        {it.dead_reason}
                      </p>
                    )}
                    <div
                      className="flex items-center justify-between text-[10.5px]"
                      style={{ color: "var(--color-text-tertiary)" }}
                    >
                      <span style={{ fontFamily: "var(--font-mono)" }}>
                        {it.owner}/{it.repo}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => openSource(it)}
                          className="inline-flex items-center gap-1 rounded px-2 py-0.5"
                          style={{
                            color: "var(--color-text)",
                            background: "var(--color-surface-3)",
                          }}
                          title="Open source on GitHub"
                        >
                          <ExternalLink size={11} />
                        </button>
                        <button
                          type="button"
                          onClick={() => install(it)}
                          disabled={isInstalling || isInstalled || isDead}
                          className="inline-flex items-center gap-1 rounded px-2 py-0.5 transition-colors"
                          style={{
                            background: isInstalled
                              ? "rgba(63, 185, 80, 0.12)"
                              : isInstalling
                                ? "var(--color-surface-3)"
                                : isDead
                                  ? "var(--color-surface-3)"
                                  : "var(--color-accent)",
                            color: isInstalled
                              ? "var(--color-success)"
                              : isInstalling
                                ? "var(--color-text-secondary)"
                                : isDead
                                  ? "var(--color-text-tertiary)"
                                  : "var(--color-accent-text)",
                            border: `1px solid ${
                              isInstalled
                                ? "rgba(63, 185, 80, 0.30)"
                                : "var(--color-border-strong)"
                            }`,
                            cursor:
                              isInstalled || isInstalling || isDead
                                ? "default"
                                : "pointer",
                          }}
                          title={
                            isDead
                              ? "Upstream URL 404s — cannot install"
                              : isInstalled
                                ? "Installed"
                                : isInstalling
                                  ? "Installing…"
                                  : "Install to global scope"
                          }
                        >
                          {isInstalled ? (
                            <>
                              <Check size={11} /> Installed
                            </>
                          ) : isInstalling ? (
                            <>
                              <Loader size={11} className="animate-spin" />{" "}
                              Installing
                            </>
                          ) : (
                            <>
                              <Download size={11} /> Install
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                    {st.kind === "error" && (
                      <div
                        className="mt-2 rounded px-2 py-1 text-[10.5px]"
                        style={{
                          background: "rgba(248, 81, 73, 0.06)",
                          color: "var(--color-danger)",
                          border: "1px solid rgba(248, 81, 73, 0.22)",
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

        {/* ---------- v2.6.1: GitHub repo discovery panel ---------- */}
        <section
          className="mt-2 rounded-md border"
          style={{
            background: "var(--color-surface-2)",
            borderColor: "var(--color-border-strong)",
          }}
        >
          <header
            className="flex items-center justify-between gap-2 border-b px-3 py-2"
            style={{ borderColor: "var(--color-border)" }}
          >
            <button
              type="button"
              onClick={() => setSearchOpen((v) => !v)}
              className="inline-flex items-center gap-2 text-[13px] font-semibold"
              style={{ color: "var(--color-text)" }}
            >
              <Github size={13} />
              Search GitHub
              <span
                className="text-[11.5px] font-normal"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {searchOpen ? "(hide)" : "(show)"}
              </span>
            </button>
            <span
              className="text-[11.5px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Trending claude-flavoured repos and free-text repo search.
            </span>
          </header>

          {searchOpen && (
            <div className="px-3 py-3">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <div
                  className="flex rounded-md border p-0.5"
                  style={{ borderColor: "var(--color-border-strong)" }}
                >
                  {(["trending", "manual"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setSearchMode(m)}
                      className="rounded px-2.5 py-1 text-[11.5px] transition-colors"
                      style={{
                        background:
                          searchMode === m
                            ? "var(--color-surface-3)"
                            : "transparent",
                        color:
                          searchMode === m
                            ? "var(--color-text)"
                            : "var(--color-text-secondary)",
                      }}
                    >
                      {m === "trending" ? "Trending" : "Search"}
                    </button>
                  ))}
                </div>

                {searchMode === "trending" ? (
                  <>
                    <div className="flex flex-wrap gap-1">
                      {(["all", "skill", "agent", "mcp"] as const).map((k) => (
                        <button
                          key={k}
                          type="button"
                          onClick={() => setTrendingKind(k)}
                          className="rounded-md px-2 py-1 text-[11.5px] transition-colors"
                          style={{
                            background:
                              trendingKind === k
                                ? "var(--color-surface-3)"
                                : "transparent",
                            color:
                              trendingKind === k
                                ? "var(--color-text)"
                                : "var(--color-text-secondary)",
                            border: `1px solid ${
                              trendingKind === k
                                ? "var(--color-border-strong)"
                                : "var(--color-border)"
                            }`,
                          }}
                        >
                          {k}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => void runTrending()}
                      disabled={hitsLoading}
                      className="inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-[11.5px] disabled:opacity-60"
                      style={{
                        background: "var(--color-accent)",
                        color: "var(--color-accent-text)",
                        border: "1px solid var(--color-border-strong)",
                      }}
                    >
                      {hitsLoading ? (
                        <>
                          <Loader size={11} className="animate-spin" />{" "}
                          Loading
                        </>
                      ) : (
                        <>Show trending</>
                      )}
                    </button>
                  </>
                ) : (
                  <>
                    <input
                      type="text"
                      value={manualQuery}
                      onChange={(e) => setManualQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void runManual();
                      }}
                      placeholder="e.g. topic:claude-skill language:python stars:>50"
                      className="flex-1 rounded-md border px-2.5 py-1 text-[11.5px] outline-none"
                      style={{
                        background: "var(--color-surface)",
                        borderColor: "var(--color-border-strong)",
                        color: "var(--color-text)",
                        minWidth: "240px",
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => void runManual()}
                      disabled={hitsLoading || manualQuery.trim().length === 0}
                      className="inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-[11.5px] disabled:opacity-60"
                      style={{
                        background: "var(--color-accent)",
                        color: "var(--color-accent-text)",
                        border: "1px solid var(--color-border-strong)",
                      }}
                    >
                      {hitsLoading ? (
                        <>
                          <Loader size={11} className="animate-spin" />{" "}
                          Searching
                        </>
                      ) : (
                        <>
                          <Search size={11} /> Search
                        </>
                      )}
                    </button>
                  </>
                )}
              </div>

              {hitsError && (
                <div
                  className="mb-2 rounded px-2 py-1 text-[11.5px]"
                  style={{
                    background: "rgba(248, 81, 73, 0.06)",
                    color: "var(--color-danger)",
                    border: "1px solid rgba(248, 81, 73, 0.22)",
                  }}
                >
                  {hitsError}
                </div>
              )}

              {hits.length === 0 && !hitsLoading && !hitsError && (
                <p
                  className="text-[11.5px]"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  {searchMode === "trending"
                    ? "Pick a kind and hit Show trending to fetch the latest claude-flavoured repos."
                    : "Type a GitHub repo query — qualifiers like topic:, stars:, language: are supported."}
                </p>
              )}

              {hits.length > 0 && (
                <ul className="grid gap-2 md:grid-cols-2">
                  {hits.map((hit) => {
                    const copied = copyState[hit.full_name] === "copied";
                    return (
                      <li
                        key={hit.full_name}
                        className="rounded-md border p-3 text-[12px]"
                        style={{
                          background: "var(--color-surface)",
                          borderColor: "var(--color-border)",
                          color: "var(--color-text)",
                        }}
                      >
                        <div className="mb-1 flex flex-wrap items-center gap-2">
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
                              title="Copy URL to clipboard (Install requires the source path — TODO: clone-into-library flow)"
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
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export default Catalog;
