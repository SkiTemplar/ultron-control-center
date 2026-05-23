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

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  Bot,
  Check,
  Compass,
  Download,
  ExternalLink,
  Loader,
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

function itemKey(it: CatalogItem): string {
  return `${it.owner}/${it.repo}/${it.path}`;
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

  const allItems = useMemo<CatalogItem[]>(() => {
    if (!data) return [];
    return data.domains.flatMap((d) => d.items);
  }, [data]);

  const refreshPreviews = useCallback(
    async (items: CatalogItem[]) => {
      if (items.length === 0) return;
      setRefreshing(true);
      try {
        const previews = (await invoke("catalog_fetch_previews", {
          items: items.map((it) => ({
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
    if (filter === "all") return data.domains;
    return data.domains
      .map((d) => ({ ...d, items: d.items.filter((it) => it.kind === filter) }))
      .filter((d) => d.items.length > 0);
  }, [data, filter]);

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
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void refreshPreviews(allItems)}
            disabled={refreshing || allItems.length === 0}
            className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] disabled:opacity-60"
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
                className="rounded-md px-2.5 py-1 text-[11px] transition-colors"
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
                className="text-[11px]"
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
                return (
                  <li
                    key={key}
                    className="rounded-md border p-3 text-[12px]"
                    style={{
                      background: "var(--color-surface-2)",
                      borderColor: "var(--color-border-strong)",
                      color: "var(--color-text)",
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
                      {liveSummary && (
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
                          disabled={isInstalling || isInstalled}
                          className="inline-flex items-center gap-1 rounded px-2 py-0.5 transition-colors"
                          style={{
                            background: isInstalled
                              ? "rgba(63, 185, 80, 0.12)"
                              : isInstalling
                                ? "var(--color-surface-3)"
                                : "var(--color-accent)",
                            color: isInstalled
                              ? "var(--color-success)"
                              : isInstalling
                                ? "var(--color-text-secondary)"
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
                          title={
                            isInstalled
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
      </div>
    </div>
  );
}

export default Catalog;
