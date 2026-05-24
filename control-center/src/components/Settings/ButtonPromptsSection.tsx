import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  copyButtonPromptToClipboard,
  refreshButtonPrompts,
  resetButtonPrompt,
  updateButtonPrompt,
  type ButtonPrompt,
  type ButtonPromptsCatalog,
} from "../../lib/button-prompts";

// ---------------------------------------------------------------------------
// Button prompts Settings panel.
//
// v2.5.2 (wave 2): two-level Library-style layout.
//   Level 1: category cards (derived from the prompt key prefix —
//            "dashboard.*", "plans.*", "skills.*", …).
//   Level 2: prompt cards within the picked category.
//   Detail : modal overlay (unchanged, opens on prompt-card click).
//
// Dead-prompt audit (CANDIDATE FOR REMOVAL): some categories no longer have
// a UI surface in the Control Center because the corresponding tab was
// retired. Those categories are flagged with `dead: true` so the user can
// see them and clean up later. None are deleted automatically.
//
// Live Tab union (from Sidebar.tsx):
//   dashboard, mcps, library (= skills/agents/rules/plugins/hooks/commands),
//   projects, memory, notes, plans, changelog, notifications, sessions,
//   usage, system, settings.
//
// Categories present in button_prompts.rs that DO map to a tab:
//   dashboard, skills, agents, memory, notif, plans, system, usage, mcps,
//   projects, sessions.
//
// Categories that have NO matching tab anymore (dead surfaces):
//   selfimprove, logs.
//
// Keys flagged for removal (see button_prompts.rs):
//   selfimprove.repo_evaluator
//   logs.summarize_recent
// ---------------------------------------------------------------------------

const SEARCH_FOCUS_KEY = "/";

// Categories whose UI surface no longer exists in the Control Center. The
// prompts under these prefixes are CANDIDATES FOR REMOVAL — they still
// exist in button_prompts.rs but nothing in the React tree calls them.
const DEAD_CATEGORIES: ReadonlySet<string> = new Set(["selfimprove", "logs"]);

/** Category derived from the prompt key prefix (everything before the first
 *  dot). Falls back to "misc" when the key has no dot. */
function categoryOf(entry: ButtonPrompt): string {
  const dot = entry.key.indexOf(".");
  if (dot === -1) return "misc";
  return entry.key.slice(0, dot);
}

/** Legacy `location`-based group, kept for the search badge. */
function groupOf(entry: ButtonPrompt): string {
  const slash = entry.location.indexOf("/");
  if (slash === -1) return entry.location.trim();
  return entry.location.slice(0, slash).trim();
}

function matchesQuery(entry: ButtonPrompt, q: string): boolean {
  if (!q) return true;
  const haystack = [
    entry.key,
    entry.label,
    entry.location,
    entry.description,
    entry.prompt,
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(q);
}

export function ButtonPromptsSection() {
  const [catalog, setCatalog] = useState<ButtonPromptsCatalog | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("");
  const [activeGroups, setActiveGroups] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  // v2.5.2: two-level navigation. When null we render the category grid.
  // When set, we render the prompts inside that category.
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const c = (await invoke("list_button_prompts")) as ButtonPromptsCatalog;
      setCatalog(c);
      setDrafts((prev) => {
        const next: Record<string, string> = { ...prev };
        for (const b of c.buttons) {
          if (next[b.key] === undefined) next[b.key] = b.prompt;
        }
        return next;
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // "/" focuses the search input unless the user is already typing somewhere.
  // Esc closes the open modal (v2.6 / fb-031).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && expanded) {
        e.preventDefault();
        setExpanded(null);
        setEditing(null);
        return;
      }
      if (e.key !== SEARCH_FOCUS_KEY) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (
        tag === "input" ||
        tag === "textarea" ||
        (target?.isContentEditable ?? false)
      ) {
        return;
      }
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  const flashSuccess = useCallback((msg: string) => {
    setSuccess(msg);
    window.setTimeout(() => setSuccess(null), 2200);
  }, []);

  const onSave = useCallback(
    async (key: string) => {
      const draft = drafts[key] ?? "";
      setBusy(key);
      setError(null);
      try {
        await updateButtonPrompt(key, draft);
        const next = await refreshButtonPrompts();
        setCatalog(next);
        const persisted =
          next.buttons.find((b) => b.key === key)?.prompt ?? draft;
        setDrafts((prev) => ({ ...prev, [key]: persisted }));
        setEditing(null);
        flashSuccess(`Saved ${key}`);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(null);
      }
    },
    [drafts, flashSuccess],
  );

  const onReset = useCallback(
    async (key: string) => {
      setBusy(key);
      setError(null);
      try {
        const restored = await resetButtonPrompt(key);
        const next = await refreshButtonPrompts();
        setCatalog(next);
        setDrafts((prev) => ({ ...prev, [key]: restored.prompt }));
        flashSuccess(`Reset ${key}`);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(null);
      }
    },
    [flashSuccess],
  );

  const onCopy = useCallback(
    async (entry: ButtonPrompt) => {
      setBusy(entry.key);
      setError(null);
      try {
        await copyButtonPromptToClipboard(entry);
        flashSuccess(`Copied "${entry.label}" to clipboard`);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(null);
      }
    },
    [flashSuccess],
  );

  const groups = useMemo(() => {
    if (!catalog) return [] as Array<{ name: string; count: number }>;
    const counts = new Map<string, number>();
    for (const b of catalog.buttons) {
      const g = groupOf(b);
      counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [catalog]);

  // v2.5.2 (wave 2): Level-1 categories derived from the key prefix
  // (dashboard.foo → "dashboard"). Each category card surfaces its prompt
  // count and a "dead" tag when no Control Center tab consumes that prefix.
  const categories = useMemo(() => {
    if (!catalog) return [] as Array<{ name: string; count: number; dead: boolean }>;
    const counts = new Map<string, number>();
    for (const b of catalog.buttons) {
      const c = categoryOf(b);
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([name, count]) => ({
        name,
        count,
        dead: DEAD_CATEGORIES.has(name),
      }))
      // Dead categories sink to the bottom so live categories surface first.
      .sort((a, b) => {
        if (a.dead !== b.dead) return a.dead ? 1 : -1;
        return a.name.localeCompare(b.name);
      });
  }, [catalog]);

  const filtered = useMemo(() => {
    if (!catalog) return [] as ButtonPrompt[];
    const q = filter.trim().toLowerCase();
    return catalog.buttons.filter((b) => {
      // v2.5.2: when a category is active, scope to its prompts. The
      // legacy `activeGroups` chip filter still works inside a category
      // (handy for prompts whose `location` spans multiple sub-pages).
      if (activeCategory && categoryOf(b) !== activeCategory) return false;
      if (activeGroups.size > 0 && !activeGroups.has(groupOf(b))) return false;
      return matchesQuery(b, q);
    });
  }, [catalog, filter, activeGroups, activeCategory]);

  const toggleGroup = (name: string) => {
    setActiveGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const clearFilters = () => {
    setFilter("");
    setActiveGroups(new Set());
  };

  if (loading) {
    return (
      <div className="text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
        Loading button prompts…
      </div>
    );
  }

  // Level 1 (no active category): render the category grid. Search still
  // works at this level — typing a query auto-flattens the view by surfacing
  // every matching prompt regardless of category.
  const searchActive = filter.trim().length > 0;
  const showCategoryGrid = activeCategory === null && !searchActive;

  return (
    <div>
      <p className="text-[12px]" style={{ color: "var(--color-text-secondary)" }}>
        Each entry here is the prompt that fires when you press an AI-powered
        button somewhere in the Control Center. Pick a category to drill in,
        or search across every prompt with{" "}
        <kbd
          className="rounded px-1 py-px text-[10px]"
          style={{
            background: "var(--color-surface-3)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-secondary)",
          }}
        >
          /
        </kbd>
        .
      </p>
      <p
        className="mt-1 text-[10.5px]"
        style={{
          color: "var(--color-text-faint)",
          fontFamily: "var(--font-mono)",
        }}
      >
        ~/.claude/projects/control-center/button-prompts.json
      </p>

      {/* Back row — only when inside a category */}
      {activeCategory && (
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setActiveCategory(null);
              setActiveGroups(new Set());
            }}
            className="rounded px-2.5 py-1 text-[11.5px]"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            ← Categories
          </button>
          <span
            className="text-[12px]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            <span style={{ fontFamily: "var(--font-mono)" }}>{activeCategory}.*</span>
            {DEAD_CATEGORIES.has(activeCategory) && (
              <span
                className="ml-2 rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide"
                style={{
                  background: "rgba(248, 81, 73, 0.10)",
                  color: "var(--color-danger)",
                }}
                title="No Control Center tab consumes this category — candidate for removal"
              >
                dead surface
              </span>
            )}
          </span>
        </div>
      )}

      {/* Search row */}
      <div className="mt-3 flex items-center gap-2">
        <div className="relative flex-1">
          <input
            ref={searchRef}
            type="text"
            placeholder="Search prompts — press / to focus"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-full rounded px-2.5 py-1.5 text-[12px]"
            style={{
              background: "var(--color-surface-1)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
              outline: "none",
            }}
          />
        </div>
        <span
          className="tabular-nums text-[11.5px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {filter || activeGroups.size > 0
            ? `${filtered.length} / ${catalog?.buttons.length ?? 0}`
            : `${catalog?.buttons.length ?? 0}`}
        </span>
        <button
          type="button"
          onClick={clearFilters}
          disabled={!filter && activeGroups.size === 0}
          className="rounded px-2.5 py-1.5 text-[11.5px] disabled:opacity-40"
          style={{
            background: "transparent",
            color: "var(--color-text-tertiary)",
            border: "1px solid var(--color-border)",
          }}
          title="Clear search and group filters"
        >
          Clear
        </button>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded px-2.5 py-1.5 text-[11.5px]"
          style={{
            background: "var(--color-surface-2)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
          }}
        >
          Refresh
        </button>
      </div>

      {/* Group filter chips — hidden on the Level-1 category grid since the
          chips would compete with the category cards themselves. */}
      {!showCategoryGrid && groups.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {groups.map((g) => {
            const active = activeGroups.has(g.name);
            return (
              <button
                key={g.name}
                type="button"
                onClick={() => toggleGroup(g.name)}
                className="rounded-full px-2.5 py-0.5 text-[11.5px]"
                style={{
                  background: active
                    ? "var(--color-accent)"
                    : "var(--color-surface-2)",
                  color: active
                    ? "var(--color-accent-text)"
                    : "var(--color-text)",
                  border: `1px solid ${active ? "var(--color-accent)" : "var(--color-border-strong)"}`,
                }}
                title={`${g.count} prompt(s) in ${g.name}`}
              >
                {g.name}{" "}
                <span
                  className="tabular-nums"
                  style={{
                    color: active
                      ? "var(--color-accent-text)"
                      : "var(--color-text-tertiary)",
                    opacity: 0.8,
                  }}
                >
                  {g.count}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {error && (
        <div
          className="mt-3 rounded p-3 text-[12px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}
      {success && (
        <div
          className="mt-3 rounded p-2 text-[12px]"
          style={{
            background: "rgba(63, 185, 80, 0.06)",
            border: "1px solid rgba(63, 185, 80, 0.22)",
            color: "var(--color-success)",
          }}
        >
          {success}
        </div>
      )}

      {/* Level 1 — Category grid (mirrors the Library two-step UX). */}
      {showCategoryGrid && categories.length > 0 && (
        <div
          className="mt-4 grid gap-3"
          style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}
        >
          {categories.map((c) => (
            <button
              key={c.name}
              type="button"
              onClick={() => {
                setActiveCategory(c.name);
                setActiveGroups(new Set());
              }}
              className="rounded p-4 text-left transition-colors"
              style={{
                background: "var(--color-surface-2)",
                border: `1px solid ${c.dead ? "rgba(248, 81, 73, 0.32)" : "var(--color-border)"}`,
                cursor: "pointer",
                opacity: c.dead ? 0.7 : 1,
              }}
              title={
                c.dead
                  ? `No Control Center tab consumes '${c.name}.*' anymore — candidate for removal`
                  : `${c.count} prompt(s) in ${c.name}.*`
              }
            >
              <div className="flex items-baseline justify-between gap-2">
                <span
                  className="truncate text-[14px] font-semibold"
                  style={{ color: "var(--color-text)" }}
                >
                  {c.name}
                </span>
                <span
                  className="shrink-0 tabular-nums text-[11.5px]"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  {c.count}
                </span>
              </div>
              <div
                className="mt-1 text-[11px]"
                style={{
                  color: "var(--color-text-faint)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {c.name}.*
              </div>
              {c.dead && (
                <div className="mt-2">
                  <span
                    className="rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide"
                    style={{
                      background: "rgba(248, 81, 73, 0.10)",
                      color: "var(--color-danger)",
                    }}
                  >
                    dead surface
                  </span>
                </div>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Level 2 — Prompt grid. Visible when a category is picked OR when a
          search query is active (search auto-flattens the view). */}
      {!showCategoryGrid && (
        filtered.length === 0 ? (
        <div
          className="mt-4 rounded p-8 text-center text-[12px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-tertiary)",
          }}
        >
          No prompts match the current search or filters.
          <div className="mt-2">
            <button
              type="button"
              onClick={clearFilters}
              className="rounded px-2.5 py-1 text-[11.5px]"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
              }}
            >
              Clear filters
            </button>
          </div>
        </div>
      ) : (
        <div
          className="mt-4 grid gap-3"
          style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}
        >
          {filtered.map((b) => (
            <button
              key={b.key}
              type="button"
              onClick={() => {
                setExpanded(b.key);
                setEditing(null);
              }}
              className="rounded p-3 text-left transition-colors"
              style={{
                background: "var(--color-surface-2)",
                border: `1px solid ${b.overridden ? "var(--color-accent)" : "var(--color-border)"}`,
                cursor: "pointer",
              }}
              title={`Click to inspect "${b.label}"`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span
                  className="truncate text-[13px] font-semibold"
                  style={{ color: "var(--color-text)" }}
                >
                  {b.label}
                </span>
                <span
                  className="shrink-0 rounded-full px-2 py-px text-[10px]"
                  style={{
                    background: "var(--color-surface-3)",
                    color: "var(--color-text-tertiary)",
                    border: "1px solid var(--color-border)",
                  }}
                >
                  {groupOf(b)}
                </span>
              </div>
              {b.overridden && (
                <div className="mt-1">
                  <span
                    className="rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide"
                    style={{
                      background: "rgba(88, 166, 255, 0.12)",
                      color: "var(--color-accent)",
                    }}
                  >
                    custom
                  </span>
                </div>
              )}
              {b.description && (
                <div
                  className="mt-1.5 text-[11.5px]"
                  style={{
                    color: "var(--color-text-secondary)",
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  }}
                >
                  {b.description}
                </div>
              )}
              <div
                className="mt-1.5 text-[10.5px]"
                style={{
                  color: "var(--color-text-faint)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {b.key}
              </div>
            </button>
          ))}
        </div>
        )
      )}

      {/* Modal overlay (v2.6 / fb-031). Replaces the previous inline detail
          panel so opening a prompt no longer pushes the whole list down. */}
      {expanded && (() => {
        const b = catalog?.buttons.find((x) => x.key === expanded);
        if (!b) return null;
        const isEditing = editing === b.key;
        const draft = drafts[b.key] ?? b.prompt;
        const dirty = draft !== b.prompt;
        const isBusy = busy === b.key;
        const close = () => {
          setExpanded(null);
          setEditing(null);
        };
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            style={{ background: "rgba(0, 0, 0, 0.65)" }}
            onClick={close}
          >
            <div
              role="dialog"
              aria-modal="true"
              onClick={(e) => e.stopPropagation()}
              className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg"
              style={{
                background: "var(--color-surface-2)",
                border: `1px solid ${b.overridden ? "var(--color-accent)" : "var(--color-border-strong)"}`,
                boxShadow: "0 24px 64px rgba(0, 0, 0, 0.55)",
              }}
            >
              {/* Modal header */}
              <div
                className="flex items-start justify-between gap-3 border-b p-4"
                style={{ borderColor: "var(--color-border)" }}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3
                      className="truncate text-[15px] font-semibold"
                      style={{ color: "var(--color-text)" }}
                    >
                      {b.label}
                    </h3>
                    {b.overridden && (
                      <span
                        className="rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide"
                        style={{
                          background: "rgba(88, 166, 255, 0.12)",
                          color: "var(--color-accent)",
                        }}
                      >
                        custom
                      </span>
                    )}
                  </div>
                  <div
                    className="mt-1 text-[11.5px]"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    {b.location}
                  </div>
                  <div
                    className="mt-0.5 text-[10.5px]"
                    style={{
                      color: "var(--color-text-faint)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {b.key}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={close}
                  className="shrink-0 rounded px-2 py-1 text-[12px]"
                  style={{
                    background: "var(--color-surface-3)",
                    color: "var(--color-text)",
                    border: "1px solid var(--color-border-strong)",
                  }}
                  aria-label="Close"
                >
                  Close
                </button>
              </div>

              {/* Modal body — scrollable */}
              <div className="flex-1 overflow-y-auto p-4">
                {b.description && (
                  <p
                    className="text-[12px]"
                    style={{ color: "var(--color-text-secondary)" }}
                  >
                    {b.description}
                  </p>
                )}
                {b.vars.length > 0 && (
                  <div
                    className="mt-2 text-[10.5px]"
                    style={{
                      color: "var(--color-text-faint)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    vars: {b.vars.map((v) => `{${v}}`).join(", ")}
                  </div>
                )}

                {!isEditing ? (
                  <div className="mt-3">
                    {b.overridden ? (
                      <div
                        className="grid gap-3"
                        style={{
                          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                        }}
                      >
                        <div>
                          <div
                            className="mb-1 text-[10.5px] uppercase tracking-wide"
                            style={{ color: "var(--color-text-faint)" }}
                          >
                            Effective (custom)
                          </div>
                          <pre
                            className="whitespace-pre-wrap rounded p-2.5 text-[11.5px]"
                            style={{
                              background: "var(--color-surface-1)",
                              border: "1px solid var(--color-border-strong)",
                              color: "var(--color-text)",
                              fontFamily: "var(--font-mono)",
                              maxHeight: 420,
                              overflow: "auto",
                            }}
                          >
                            {b.prompt}
                          </pre>
                        </div>
                        <div>
                          <div
                            className="mb-1 text-[10.5px] uppercase tracking-wide"
                            style={{ color: "var(--color-text-faint)" }}
                          >
                            Original default
                          </div>
                          <pre
                            className="whitespace-pre-wrap rounded p-2.5 text-[11.5px]"
                            style={{
                              background: "var(--color-surface-1)",
                              border: "1px dashed var(--color-border)",
                              color: "var(--color-text-secondary)",
                              fontFamily: "var(--font-mono)",
                              maxHeight: 420,
                              overflow: "auto",
                            }}
                          >
                            {b.default_prompt}
                          </pre>
                        </div>
                      </div>
                    ) : (
                      <pre
                        className="whitespace-pre-wrap rounded p-2.5 text-[11.5px]"
                        style={{
                          background: "var(--color-surface-1)",
                          border: "1px solid var(--color-border-strong)",
                          color: "var(--color-text)",
                          fontFamily: "var(--font-mono)",
                          maxHeight: 480,
                          overflow: "auto",
                        }}
                      >
                        {b.prompt}
                      </pre>
                    )}
                  </div>
                ) : (
                  <textarea
                    value={draft}
                    onChange={(e) =>
                      setDrafts((prev) => ({
                        ...prev,
                        [b.key]: e.target.value,
                      }))
                    }
                    rows={Math.min(
                      24,
                      Math.max(8, draft.split("\n").length + 1),
                    )}
                    className="mt-3 w-full rounded p-2.5 text-[12px]"
                    style={{
                      background: "var(--color-surface-1)",
                      color: "var(--color-text)",
                      border: `1px solid ${dirty ? "var(--color-accent)" : "var(--color-border-strong)"}`,
                      outline: "none",
                      fontFamily: "var(--font-mono)",
                      resize: "vertical",
                    }}
                    spellCheck={false}
                  />
                )}
              </div>

              {/* Modal footer — action row */}
              <div
                className="flex flex-wrap items-center gap-1.5 border-t p-3"
                style={{ borderColor: "var(--color-border)" }}
              >
                <button
                  type="button"
                  onClick={() => void onCopy(b)}
                  disabled={isBusy}
                  className="rounded px-2.5 py-1 text-[11.5px] disabled:opacity-40"
                  style={{
                    background: "var(--color-accent)",
                    color: "var(--color-accent-text)",
                  }}
                  title="Copy the rendered prompt to the clipboard"
                >
                  Copy to clipboard
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(isEditing ? null : b.key)}
                  disabled={isBusy}
                  className="rounded px-2.5 py-1 text-[11.5px] disabled:opacity-40"
                  style={{
                    background: "var(--color-surface-3)",
                    color: "var(--color-text)",
                    border: "1px solid var(--color-border-strong)",
                  }}
                >
                  {isEditing ? "Stop editing" : "Edit override"}
                </button>
                <button
                  type="button"
                  onClick={() => void onReset(b.key)}
                  disabled={isBusy || !b.overridden}
                  className="rounded px-2.5 py-1 text-[11.5px] disabled:opacity-30"
                  style={{
                    background: "transparent",
                    color: "var(--color-text-tertiary)",
                    border: "1px solid var(--color-border)",
                  }}
                  title="Drop the override and go back to the default"
                >
                  Reset to default
                </button>
                {isEditing && (
                  <button
                    type="button"
                    onClick={() => void onSave(b.key)}
                    disabled={isBusy || !dirty}
                    className="ml-auto rounded px-2.5 py-1 text-[11.5px] font-medium disabled:opacity-40"
                    style={{
                      background: "var(--color-success)",
                      color: "var(--color-accent-text)",
                    }}
                  >
                    {isBusy ? "Saving…" : "Save override"}
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
