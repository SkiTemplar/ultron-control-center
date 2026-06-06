// ULTRON Control Center 2.6 — Rules viewer (FULL REDESIGN, aligned with
// Skills/Agents).
//
// Same big-tile card grid as Skills + Agents, with a lime accent to
// distinguish rules from skills (cyan) and agents (violet). The shared
// `LibraryDetailPane` powers the right-side detail view, so Edit /
// Edit with AI / Open Externally behave identically across all three.
//
// Backend wiring (rules_list, rules_read, rules_write) is unchanged — the
// detail pane uses the path-based `read_text_file` for reading and a
// `rules_write` wrapper for writing.

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RuleFile } from "../types";
import { BookOpen } from "./library/icons";
import { TreeView, type TreeOrigin } from "./library/TreeView";
import {
  BlocksView,
  type BlocksItem,
} from "./library/BlocksView";
import { ViewToggle, useLibraryViewMode } from "./library/ViewToggle";
import { LibraryDetailPane } from "./library/LibraryDetailPane";

const NO_CATEGORY = "root";

// Lime — distinct from skill cyan and agent violet.
const RULE_ACCENT = "rgba(132, 204, 22, 0.55)";
const RULE_ACCENT_SOFT = "rgba(132, 204, 22, 0.18)";

function deriveCategory(r: RuleFile): string {
  const rel = (r.relative ?? "").replace(/\\/g, "/");
  const first = rel.split("/")[0];
  if (!first || first === r.name || first.endsWith(".md")) return NO_CATEGORY;
  return first;
}

function deriveSubGroup(r: RuleFile): string | null {
  const rel = (r.relative ?? "").replace(/\\/g, "/");
  const parts = rel.split("/").filter(Boolean);
  if (parts.length < 3) return null;
  return parts[1];
}

/// Compute the workspace folder for a rule. ~/.claude/rules/<top>/<file>.md
/// → opening the <top> folder in VS Code shows sibling rules at the same
/// time, which mirrors the "open whole skill workspace" behaviour the user
/// asked for.
function ruleWorkspace(r: RuleFile): { folder: string; file: string } {
  const file = r.path;
  const lastSep = Math.max(file.lastIndexOf("\\"), file.lastIndexOf("/"));
  return {
    folder: lastSep > 0 ? file.slice(0, lastSep) : "",
    file,
  };
}

export function Rules() {
  const [rules, setRules] = useState<RuleFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [view, setView] = useLibraryViewMode("rules");
  const [selected, setSelected] = useState<RuleFile | null>(null);

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

  const treeOrigins: TreeOrigin<RuleFile>[] = useMemo(() => {
    const byTop = new Map<string, RuleFile[]>();
    for (const r of filtered) {
      const top = deriveCategory(r);
      const arr = byTop.get(top) ?? [];
      arr.push(r);
      byTop.set(top, arr);
    }
    return Array.from(byTop.entries())
      .sort(([a], [b]) => {
        if (a === NO_CATEGORY) return 1;
        if (b === NO_CATEGORY) return -1;
        return a.localeCompare(b);
      })
      .map(([id, list]) => {
        const byGroup = new Map<string, RuleFile[]>();
        for (const r of list) {
          const sub = deriveSubGroup(r) ?? "(root)";
          const arr = byGroup.get(sub) ?? [];
          arr.push(r);
          byGroup.set(sub, arr);
        }
        return {
          id,
          label: id,
          groups: Array.from(byGroup.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, leaves]) => ({
              name,
              leaves: leaves.map((r) => ({
                key: r.path,
                label: r.name,
                data: r,
              })),
            })),
        };
      });
  }, [filtered]);

  const blockItems: BlocksItem<RuleFile>[] = useMemo(
    () =>
      filtered.map((r) => ({
        key: r.path,
        topGroup:
          deriveCategory(r) === NO_CATEGORY ? "Root" : deriveCategory(r),
        subGroup: deriveSubGroup(r),
        data: r,
      })),
    [filtered],
  );

  const buildOnSave = (r: RuleFile) => async (body: string) => {
    await invoke("rules_write", { name: r.relative, body });
    await reload();
  };

  const renderCardGrid = (items: RuleFile[]) => (
    <div
      className="grid gap-3"
      style={{
        gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
      }}
    >
      {items.map((r) => {
        const isActive = selected?.path === r.path;
        const cat = deriveCategory(r);
        return (
          <button
            key={r.path}
            type="button"
            onClick={() => setSelected(r)}
            className="group flex h-[140px] flex-col justify-between rounded-xl p-4 text-left transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
            style={{
              background: isActive
                ? "var(--color-surface-3)"
                : "var(--color-surface-2)",
              border: `1px solid ${
                isActive ? RULE_ACCENT : "var(--color-border)"
              }`,
              boxShadow: `inset 0 3px 0 ${RULE_ACCENT}`,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = RULE_ACCENT;
              e.currentTarget.style.transform = "translateY(-2px)";
              e.currentTarget.style.boxShadow = `inset 0 3px 0 ${RULE_ACCENT}, 0 6px 18px rgba(0,0,0,0.28)`;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = isActive
                ? RULE_ACCENT
                : "var(--color-border)";
              e.currentTarget.style.transform = "translateY(0)";
              e.currentTarget.style.boxShadow = `inset 0 3px 0 ${RULE_ACCENT}`;
            }}
            title={r.relative}
          >
            <div
              className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.08em]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              <BookOpen size={12} />
              Rule
              {cat !== NO_CATEGORY && (
                <span
                  className="ml-auto rounded px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide"
                  style={{
                    background: RULE_ACCENT_SOFT,
                    color: "#bef264",
                    border: "1px solid rgba(132, 204, 22, 0.35)",
                  }}
                >
                  {cat}
                </span>
              )}
            </div>
            <div
              className="line-clamp-3 text-[18px] font-semibold leading-tight tracking-tight"
              style={{ color: "var(--color-text)" }}
            >
              {r.name}
            </div>
          </button>
        );
      })}
    </div>
  );

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
        <div className="flex items-center gap-2">
          <ViewToggle mode={view} onChange={setView} />
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
        </div>
      </header>

      {view !== "blocks" && categories.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className="text-[10.5px] uppercase tracking-wide"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Category
          </span>
          <button
            onClick={() => setCategory("all")}
            className="rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors"
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
                className="rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors"
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

      <div className="flex flex-1 flex-col gap-3 overflow-hidden lg:flex-row">
        <div
          className={
            selected ? "min-w-0 flex-1 overflow-y-auto" : "flex-1 overflow-y-auto"
          }
          style={{ minWidth: 0 }}
        >
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
          ) : view === "blocks" ? (
            <BlocksView<RuleFile>
              items={blockItems}
              noun="rule"
              emptyLabel="Sin reglas para el filtro actual."
              topGroupAccent={() => RULE_ACCENT}
              renderLeaves={(items) =>
                renderCardGrid(items.map((it) => it.data))
              }
            />
          ) : view === "tree" ? (
            <TreeView<RuleFile>
              origins={treeOrigins}
              selectedKey={selected?.path ?? null}
              onSelect={(leaf) => setSelected(leaf.data)}
              query={query}
            />
          ) : (
            renderCardGrid(filtered)
          )}
        </div>

        {selected && (
          <div
            className="overflow-hidden lg:w-[560px] lg:shrink-0"
            style={{ minWidth: 0 }}
          >
            {(() => {
              const ws = ruleWorkspace(selected);
              return (
                <LibraryDetailPane
                  kind="rule"
                  name={selected.name}
                  subtitle={selected.relative}
                  filePath={ws.file}
                  folderPath={ws.folder}
                  onSave={buildOnSave(selected)}
                  onClose={() => setSelected(null)}
                />
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
}
