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
// Layout:
//   1. Header copy + storage hint.
//   2. Search input (debounced via `/` keyboard shortcut to focus).
//   3. Group filter chips derived from the `header` (location) of each entry.
//   4. 2-column card grid. Each card is collapsible — clicking the card opens
//      an inline detail panel with the full body, var list, original default
//      (when an override exists) and three actions: copy / edit / reset.
// ---------------------------------------------------------------------------

const SEARCH_FOCUS_KEY = "/";

/** Derive a coarse group from the `location` string (everything before the
 * first " / "). Falls back to the full location when no slash is present. */
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
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
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
  }, []);

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

  const filtered = useMemo(() => {
    if (!catalog) return [] as ButtonPrompt[];
    const q = filter.trim().toLowerCase();
    return catalog.buttons.filter((b) => {
      if (activeGroups.size > 0 && !activeGroups.has(groupOf(b))) return false;
      return matchesQuery(b, q);
    });
  }, [catalog, filter, activeGroups]);

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

  return (
    <div>
      <p className="text-[12px]" style={{ color: "var(--color-text-secondary)" }}>
        Each entry here is the prompt that fires when you press an AI-powered
        button somewhere in the Control Center. Search by any keyword, filter
        by section, then click a card to inspect, copy, edit, or reset it.
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
          className="tabular-nums text-[11px]"
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

      {/* Group filter chips */}
      {groups.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {groups.map((g) => {
            const active = activeGroups.has(g.name);
            return (
              <button
                key={g.name}
                type="button"
                onClick={() => toggleGroup(g.name)}
                className="rounded-full px-2.5 py-0.5 text-[11px]"
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

      {/* Card grid */}
      {filtered.length === 0 ? (
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
              className="rounded px-2.5 py-1 text-[11px]"
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
          {filtered.map((b) => {
            const isOpen = expanded === b.key;
            const isEditing = editing === b.key;
            const draft = drafts[b.key] ?? b.prompt;
            const dirty = draft !== b.prompt;
            const isBusy = busy === b.key;
            return (
              <div
                key={b.key}
                className="rounded"
                style={{
                  background: "var(--color-surface-2)",
                  border: `1px solid ${b.overridden ? "var(--color-accent)" : "var(--color-border)"}`,
                  gridColumn: isOpen ? "1 / -1" : undefined,
                }}
              >
                {/* Card head — always visible */}
                <button
                  type="button"
                  onClick={() => {
                    setExpanded(isOpen ? null : b.key);
                    if (isOpen) setEditing(null);
                  }}
                  className="w-full p-3 text-left"
                  style={{ background: "transparent", cursor: "pointer" }}
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

                {/* Expanded detail panel */}
                {isOpen && (
                  <div
                    className="border-t p-3"
                    style={{ borderColor: "var(--color-border)" }}
                  >
                    <div
                      className="text-[11px]"
                      style={{ color: "var(--color-text-tertiary)" }}
                    >
                      Location:{" "}
                      <span style={{ color: "var(--color-text-secondary)" }}>
                        {b.location}
                      </span>
                    </div>
                    {b.vars.length > 0 && (
                      <div
                        className="mt-1.5 text-[10.5px]"
                        style={{
                          color: "var(--color-text-faint)",
                          fontFamily: "var(--font-mono)",
                        }}
                      >
                        vars: {b.vars.map((v) => `{${v}}`).join(", ")}
                      </div>
                    )}

                    {/* Action row */}
                    <div className="mt-3 flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => void onCopy(b)}
                        disabled={isBusy}
                        className="rounded px-2.5 py-1 text-[11px] disabled:opacity-40"
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
                        onClick={() =>
                          setEditing(isEditing ? null : b.key)
                        }
                        disabled={isBusy}
                        className="rounded px-2.5 py-1 text-[11px] disabled:opacity-40"
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
                        className="rounded px-2.5 py-1 text-[11px] disabled:opacity-30"
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
                          className="ml-auto rounded px-2.5 py-1 text-[11px] font-medium disabled:opacity-40"
                          style={{
                            background: "var(--color-success)",
                            color: "var(--color-accent-text)",
                          }}
                        >
                          {isBusy ? "Saving…" : "Save override"}
                        </button>
                      )}
                    </div>

                    {/* Body view */}
                    {!isEditing ? (
                      <div className="mt-3">
                        {b.overridden ? (
                          <div
                            className="grid gap-3"
                            style={{
                              gridTemplateColumns:
                                "repeat(2, minmax(0, 1fr))",
                            }}
                          >
                            <div>
                              <div
                                className="mb-1 text-[10.5px] uppercase tracking-wide"
                                style={{
                                  color: "var(--color-text-faint)",
                                }}
                              >
                                Effective (custom)
                              </div>
                              <pre
                                className="whitespace-pre-wrap rounded p-2.5 text-[11.5px]"
                                style={{
                                  background: "var(--color-surface-1)",
                                  border:
                                    "1px solid var(--color-border-strong)",
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
                                style={{
                                  color: "var(--color-text-faint)",
                                }}
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
                              maxHeight: 420,
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
                          18,
                          Math.max(6, draft.split("\n").length + 1),
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
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
