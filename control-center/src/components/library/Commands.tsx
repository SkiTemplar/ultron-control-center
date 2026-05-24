// v2.3 — Slash command browser.
// v2.6 (fb-023, fb-051) — first split-view rework (deprecated by v2.6.2).
// v2.6.2 (fb-099) — full redesign: 3-column [categories][command list][preview].
//   - The 2-col layout (tree on left, preview on right) wasted vertical
//     space in the preview pane and forced the user to scroll an enormous
//     plugin tree just to find a single command. The new layout splits the
//     tree into TWO panes: a compact category list on the far left
//     (marketplace/plugin chips) and a dedicated command list in the
//     middle. The preview keeps its place on the right but no longer needs
//     to absorb all the empty horizontal real estate.
//   - Search input is prominent at the top and filters across every plugin
//     so the user can find any command without touching the tree.
//   - Active category is highlighted; clicking a category swaps the
//     middle pane to that plugin's commands.
//   - localStorage still persists the last active category so a relaunch
//     drops the user back where they were.

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import type { SlashCommand } from "../../types";
import { Clipboard, ExternalLink, Folder, Terminal } from "./icons";

type CategoryKey = string; // `${marketplace}/${plugin}` — empty plugin means "all of marketplace"

type Category = {
  key: CategoryKey;
  marketplace: string;
  plugin: string;
  count: number;
};

function categoriesOf(cmds: SlashCommand[]): Category[] {
  const map = new Map<CategoryKey, Category>();
  for (const c of cmds) {
    const key = `${c.marketplace}/${c.plugin}`;
    const prev = map.get(key);
    if (prev) {
      prev.count += 1;
    } else {
      map.set(key, {
        key,
        marketplace: c.marketplace,
        plugin: c.plugin,
        count: 1,
      });
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    if (a.marketplace !== b.marketplace) {
      return a.marketplace.localeCompare(b.marketplace);
    }
    return a.plugin.localeCompare(b.plugin);
  });
}

function commandSlug(c: SlashCommand): string {
  if (c.marketplace === "user" && c.plugin === "user") {
    return `/${c.name}`;
  }
  return `/${c.plugin}:${c.name}`;
}

const LAST_CATEGORY_KEY = "control-center.commands.lastCategory";

function readLastCategory(): string | null {
  try {
    return window.localStorage.getItem(LAST_CATEGORY_KEY);
  } catch {
    return null;
  }
}

function writeLastCategory(key: string): void {
  try {
    window.localStorage.setItem(LAST_CATEGORY_KEY, key);
  } catch {
    /* ignore */
  }
}

export function Commands() {
  const [cmds, setCmds] = useState<SlashCommand[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<CategoryKey | null>(
    readLastCategory(),
  );
  const [selected, setSelected] = useState<SlashCommand | null>(null);
  const [copied, setCopied] = useState(false);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = (await invoke("list_all_slash_commands")) as SlashCommand[];
      setCmds(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const trimmedQuery = query.trim().toLowerCase();
  const isSearching = trimmedQuery.length > 0;

  // Full filtered set (used when searching — search ignores category).
  const filteredAll = useMemo(() => {
    if (!isSearching) return cmds;
    return cmds.filter(
      (c) =>
        c.name.toLowerCase().includes(trimmedQuery) ||
        c.plugin.toLowerCase().includes(trimmedQuery) ||
        c.marketplace.toLowerCase().includes(trimmedQuery) ||
        c.description.toLowerCase().includes(trimmedQuery),
    );
  }, [cmds, isSearching, trimmedQuery]);

  const categories = useMemo(() => categoriesOf(cmds), [cmds]);

  // Pick a sensible default category when none is set and data has loaded.
  useEffect(() => {
    if (activeCategory || categories.length === 0) return;
    const first = categories[0];
    setActiveCategory(first.key);
  }, [activeCategory, categories]);

  // Commands shown in the middle column.
  const middleList = useMemo(() => {
    // When searching, the middle pane shows global matches regardless of
    // the active category — but if the user has a category selected we
    // still scope to it for relevance.
    if (isSearching) {
      return filteredAll;
    }
    if (!activeCategory) return cmds;
    return cmds.filter(
      (c) => `${c.marketplace}/${c.plugin}` === activeCategory,
    );
  }, [isSearching, filteredAll, activeCategory, cmds]);

  const sortedMiddle = useMemo(
    () => middleList.slice().sort((a, b) => a.name.localeCompare(b.name)),
    [middleList],
  );

  const handleCopy = async (c: SlashCommand) => {
    const slug = commandSlug(c);
    try {
      await navigator.clipboard.writeText(slug);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      setError(`copy ${slug}: ${e}`);
    }
  };

  const handleOpen = async (path: string) => {
    try {
      await openPath(path);
    } catch (e) {
      setError(`open ${path}: ${e}`);
    }
  };

  const matchingCategoryCount = useMemo(() => {
    if (!isSearching) return null;
    const seen = new Set<string>();
    for (const c of filteredAll) seen.add(`${c.marketplace}/${c.plugin}`);
    return seen.size;
  }, [isSearching, filteredAll]);

  return (
    <div className="flex h-full flex-col gap-3 p-6">
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h2 className="text-lg font-semibold">Commands</h2>
          <span
            className="text-[11.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {isSearching
              ? `${filteredAll.length} matches across ${matchingCategoryCount} ${
                  matchingCategoryCount === 1 ? "category" : "categories"
                }`
              : `${cmds.length} slash commands · ${categories.length} categories`}
          </span>
        </div>
        <button
          onClick={reload}
          className="rounded-md border px-3 py-1 text-xs"
          style={{
            borderColor: "var(--color-border-strong)",
            background: "var(--color-surface-2)",
            color: "var(--color-text)",
          }}
        >
          Refresh
        </button>
      </header>

      {/* Prominent search input — finds any command across every plugin. */}
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Buscar en TODOS los comandos (nombre, plugin, descripción)…"
        className="w-full rounded-md px-3 py-2.5 text-sm outline-none"
        style={{
          border: "1px solid var(--color-border-strong)",
          background: "var(--color-surface-2)",
          color: "var(--color-text)",
        }}
      />

      {error && (
        <div
          className="rounded-md p-3 text-xs"
          style={{
            border: "1px solid rgba(248, 81, 73, 0.30)",
            background: "rgba(248, 81, 73, 0.08)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {/* 3-col layout: [categories 220px] [command list 1fr] [preview 1.2fr].
          Reclaims horizontal space from the (previously enormous) preview
          pane and gives the user a dedicated list of commands within the
          selected category — no more scrolling through a 300+ entry tree. */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-[220px_minmax(260px,1fr)_minmax(0,1.2fr)]">
        {/* COL 1 — categories */}
        <div
          className="min-h-0 overflow-y-auto rounded-md"
          style={{
            border: "1px solid var(--color-border-strong)",
            background: "var(--color-surface-2)",
          }}
        >
          {loading && (
            <p
              className="p-3 text-xs"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Loading…
            </p>
          )}
          {!loading && categories.length === 0 && (
            <p
              className="p-3 text-xs"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              No hay comandos.
            </p>
          )}
          <ul className="p-1">
            {categories.map((cat) => {
              const isActive = cat.key === activeCategory && !isSearching;
              return (
                <li key={cat.key}>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveCategory(cat.key);
                      writeLastCategory(cat.key);
                      // Clear search when the user picks a category so the
                      // middle pane returns to category-scoped browsing.
                      if (isSearching) setQuery("");
                    }}
                    className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-[12px]"
                    style={{
                      background: isActive
                        ? "var(--color-surface-4)"
                        : "transparent",
                      color: isActive
                        ? "var(--color-text)"
                        : "var(--color-text-secondary)",
                      border: `1px solid ${
                        isActive
                          ? "var(--color-border-strong)"
                          : "transparent"
                      }`,
                    }}
                    title={`${cat.marketplace} · ${cat.plugin}`}
                  >
                    <Folder size={12} />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium">{cat.plugin}</span>
                      <span
                        className="ml-1 text-[10.5px]"
                        style={{ color: "var(--color-text-tertiary)" }}
                      >
                        · {cat.marketplace}
                      </span>
                    </span>
                    <span
                      className="ml-1 shrink-0 text-[10.5px]"
                      style={{ color: "var(--color-text-tertiary)" }}
                    >
                      {cat.count}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {/* COL 2 — command list (scoped to active category, or search results) */}
        <div
          className="min-h-0 overflow-y-auto rounded-md"
          style={{
            border: "1px solid var(--color-border-strong)",
            background: "var(--color-surface-2)",
          }}
        >
          {!loading && sortedMiddle.length === 0 && (
            <p
              className="p-3 text-xs"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {isSearching
                ? "Sin coincidencias para la búsqueda."
                : "Selecciona una categoría a la izquierda."}
            </p>
          )}
          <ul className="p-1">
            {sortedMiddle.map((c) => {
              const isActive = selected?.path === c.path;
              return (
                <li key={c.path}>
                  <button
                    type="button"
                    onClick={() => setSelected(c)}
                    className="flex w-full items-start gap-1.5 rounded px-2 py-1.5 text-left text-[12px]"
                    style={{
                      background: isActive
                        ? "var(--color-surface-4)"
                        : "transparent",
                      color: isActive
                        ? "var(--color-text)"
                        : "var(--color-text-secondary)",
                      border: `1px solid ${
                        isActive
                          ? "var(--color-border-strong)"
                          : "transparent"
                      }`,
                    }}
                  >
                    <Terminal size={12} className="mt-0.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{c.name}</div>
                      {isSearching && (
                        <div
                          className="truncate text-[10.5px]"
                          style={{ color: "var(--color-text-tertiary)" }}
                        >
                          {c.marketplace} / {c.plugin}
                        </div>
                      )}
                      {c.description && (
                        <div
                          className="mt-0.5 line-clamp-2 text-[11px]"
                          style={{
                            color: "var(--color-text-tertiary)",
                            whiteSpace: "normal",
                          }}
                        >
                          {c.description}
                        </div>
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {/* COL 3 — preview / detail */}
        <div
          className="min-h-0 overflow-y-auto rounded-md p-5"
          style={{
            border: "1px solid var(--color-border-strong)",
            background: "var(--color-surface-2)",
          }}
        >
          {!selected ? (
            <p
              className="text-xs"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Selecciona un comando para ver detalles.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <h3
                    className="text-base font-semibold"
                    style={{ wordBreak: "break-word" }}
                  >
                    {commandSlug(selected)}
                  </h3>
                  <p
                    className="mt-0.5 text-[11.5px]"
                    style={{
                      color: "var(--color-text-tertiary)",
                      fontFamily: "var(--font-mono)",
                      wordBreak: "break-word",
                    }}
                  >
                    {selected.marketplace} / {selected.plugin}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    onClick={() => handleCopy(selected)}
                    className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs"
                    style={{
                      borderColor: "var(--color-border-strong)",
                      background: copied
                        ? "var(--color-accent)"
                        : "var(--color-surface-3)",
                      color: copied
                        ? "var(--color-accent-text)"
                        : "var(--color-text)",
                    }}
                  >
                    <Clipboard size={12} />
                    {copied ? "Copied!" : "Copy"}
                  </button>
                  <button
                    onClick={() => handleOpen(selected.path)}
                    className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs"
                    style={{
                      borderColor: "var(--color-border-strong)",
                      background: "var(--color-surface-3)",
                      color: "var(--color-text)",
                    }}
                  >
                    <ExternalLink size={12} />
                    Open
                  </button>
                </div>
              </div>

              <p
                className="text-[12.5px] leading-relaxed"
                style={{
                  color: "var(--color-text-secondary)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {selected.description || "(sin descripción)"}
              </p>

              {selected.argument_hint && (
                <div className="text-xs">
                  <span
                    className="mr-2 uppercase tracking-wide"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    Arguments
                  </span>
                  <code
                    className="rounded px-1.5 py-0.5"
                    style={{
                      background: "var(--color-surface-3)",
                      color: "var(--color-text)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {selected.argument_hint}
                  </code>
                </div>
              )}

              {selected.model && (
                <div className="text-xs">
                  <span
                    className="mr-2 uppercase tracking-wide"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    Model
                  </span>
                  <code
                    className="rounded px-1.5 py-0.5"
                    style={{
                      background: "var(--color-surface-3)",
                      color: "var(--color-text)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {selected.model}
                  </code>
                </div>
              )}

              <div
                className="text-[12.5px]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                <div
                  className="mb-1 text-[10.5px] uppercase tracking-wide"
                  style={{ color: "var(--color-text-faint)" }}
                >
                  Source
                </div>
                <code
                  className="block overflow-x-auto rounded p-2"
                  style={{
                    fontFamily: "var(--font-mono)",
                    background: "var(--color-surface-1)",
                    color: "var(--color-text)",
                    border: "1px solid var(--color-border)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {selected.path}
                </code>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default Commands;
