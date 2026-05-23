// ULTRON Control Center 2.0 — Rules viewer.
//
// Lists every Markdown rule under ~/.claude/rules/, groups by top-level
// folder (common/, rust/, typescript/, …), exposes a category filter and a
// search box, and opens the source file in the OS-default editor. Backend
// = `rules_list` Tauri command (path-sandboxed to the rules root).

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import type { RuleFile } from "../types";
import { BookOpen, Folder } from "./library/icons";

const NO_CATEGORY = "root";

function deriveCategory(r: RuleFile): string {
  const rel = (r.relative ?? "").replace(/\\/g, "/");
  const first = rel.split("/")[0];
  if (!first || first === r.name || first.endsWith(".md")) return NO_CATEGORY;
  return first;
}

export function Rules() {
  const [rules, setRules] = useState<RuleFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("all");

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = (await invoke("rules_list")) as RuleFile[];
      setRules(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const r of rules) set.add(deriveCategory(r));
    return Array.from(set).sort((a, b) => {
      if (a === NO_CATEGORY) return 1;
      if (b === NO_CATEGORY) return -1;
      return a.localeCompare(b);
    });
  }, [rules]);

  useEffect(() => {
    if (category !== "all" && !categories.includes(category)) {
      setCategory("all");
    }
  }, [categories, category]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rules.filter((r) => {
      if (category !== "all" && deriveCategory(r) !== category) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        r.relative.toLowerCase().includes(q) ||
        (r.preview ?? "").toLowerCase().includes(q)
      );
    });
  }, [rules, category, query]);

  const handleOpen = async (path: string) => {
    try {
      await openPath(path);
    } catch (e) {
      setError(`open ${path}: ${e}`);
    }
  };

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h2 className="text-lg font-semibold">Rules</h2>
          <span
            className="text-[11.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            ~/.claude/rules/**/*.md · {filtered.length} of {rules.length}
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

      {categories.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className="text-[10.5px] uppercase tracking-wide"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Category
          </span>
          <button
            onClick={() => setCategory("all")}
            className="rounded-full border px-2.5 py-0.5 text-[11px] transition-colors"
            style={{
              borderColor:
                category === "all"
                  ? "var(--color-text)"
                  : "var(--color-border-strong)",
              background:
                category === "all"
                  ? "var(--color-surface-4)"
                  : "transparent",
              color:
                category === "all"
                  ? "var(--color-text)"
                  : "var(--color-text-secondary)",
            }}
          >
            All
          </button>
          {categories.map((c) => {
            const active = c === category;
            return (
              <button
                key={c}
                onClick={() => setCategory(c)}
                className="rounded-full border px-2.5 py-0.5 text-[11px] transition-colors"
                style={{
                  borderColor: active
                    ? "var(--color-text)"
                    : "var(--color-border-strong)",
                  background: active
                    ? "var(--color-surface-4)"
                    : "transparent",
                  color: active
                    ? "var(--color-text)"
                    : "var(--color-text-secondary)",
                }}
              >
                {c}
              </button>
            );
          })}
        </div>
      )}

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Buscar rules…"
        className="w-full rounded-md px-3 py-2 text-sm outline-none"
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

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <p
            className="text-xs"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Loading…
          </p>
        ) : filtered.length === 0 ? (
          <p
            className="text-xs"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Sin reglas para el filtro actual.
          </p>
        ) : (
          <ul className="grid gap-2 md:grid-cols-2">
            {filtered.map((r) => {
              const cat = deriveCategory(r);
              return (
                <li
                  key={r.path}
                  className="rounded-md p-3 text-sm"
                  style={{
                    border: "1px solid var(--color-border-strong)",
                    background: "var(--color-surface-2)",
                    color: "var(--color-text)",
                  }}
                >
                  <div className="mb-1 flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <BookOpen
                        size={12}
                        className="shrink-0 text-[var(--color-text-tertiary)]"
                      />
                      <span className="truncate font-medium">{r.name}</span>
                    </div>
                    <span
                      className="truncate text-[10.5px]"
                      style={{
                        color: "var(--color-text-tertiary)",
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      {r.relative}
                    </span>
                  </div>
                  {cat !== NO_CATEGORY && (
                    <div
                      className="mb-2 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]"
                      style={{
                        background: "var(--color-surface-3)",
                        color: "var(--color-text-tertiary)",
                      }}
                    >
                      <Folder size={10} /> {cat}
                    </div>
                  )}
                  <pre
                    className="mb-2 max-h-20 overflow-hidden whitespace-pre-wrap text-xs leading-snug"
                    style={{ color: "var(--color-text-secondary)" }}
                  >
                    {r.preview || "(sin preview)"}
                  </pre>
                  <button
                    onClick={() => handleOpen(r.path)}
                    className="rounded-md border px-2 py-0.5 text-xs"
                    style={{
                      borderColor: "var(--color-border-strong)",
                      background: "var(--color-surface-3)",
                      color: "var(--color-text)",
                    }}
                  >
                    Open in editor
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
