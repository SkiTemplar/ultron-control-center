// ULTRON Control Center 2.6 — Agents viewer (FULL REDESIGN).
//
// Same redesign as Skills.tsx: name-only cards in a uniform grid, click →
// detail pane on the right with Edit / Edit with AI / Open Externally.
// Agents use a violet accent so the three viewers (cyan skills, violet
// agents, lime rules) read as distinct categories at a glance.

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AgentEntry, SkillOrigin } from "../types";
import { CreateAgentModal } from "./library/CreateAgentModal";
import { Bot, Plus } from "./library/icons";
import { TreeView, type TreeOrigin } from "./library/TreeView";
import {
  BlocksView,
  type BlocksItem,
} from "./library/BlocksView";
import { ViewToggle, useLibraryViewMode } from "./library/ViewToggle";
import { categorize } from "../lib/skill-categories";
import { LibraryDetailPane } from "./library/LibraryDetailPane";

type ProjectLite = { id: string; name: string };

type ScopeFilter = "all" | SkillOrigin;

const SCOPES: { id: ScopeFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "global", label: "Global" },
  { id: "project", label: "Project" },
  { id: "plugin", label: "Plugin" },
];

const NO_CATEGORY = "uncategorized";

// Violet — distinct from skill cyan and rule lime.
const AGENT_ACCENT = "rgba(167, 139, 250, 0.55)";
const AGENT_ACCENT_SOFT = "rgba(167, 139, 250, 0.18)";

function deriveCategory(a: AgentEntry): string {
  const norm = a.path.replace(/\\/g, "/");
  if (a.origin === "plugin") {
    const m = norm.match(/\/plugins\/cache\/[^/]+\/([^/]+)\/[^/]+\/agents\//);
    if (m && m[1]) return m[1];
  }
  const m = norm.match(/\/agents\/([^/]+)\/[^/]+\.md$/);
  if (m && m[1]) return m[1];
  return NO_CATEGORY;
}

function deriveTopGroup(a: AgentEntry): string {
  if (a.origin === "global") return "Global";
  if (a.origin === "project") return "Project";
  return deriveCategory(a);
}

function deriveSubGroup(a: AgentEntry): string | null {
  const domain = categorize(a.name, a.description);
  if (domain) return domain;
  const norm = a.path.replace(/\\/g, "/");
  if (a.origin === "plugin") {
    const m = norm.match(/\/agents\/([^/]+)\/[^/]+\.md$/);
    if (m && m[1]) return m[1];
    return null;
  }
  const cat = deriveCategory(a);
  if (cat === NO_CATEGORY) return null;
  return cat;
}

/// Agents are typically single-file .md, but the "Open Externally" button
/// still benefits from opening the parent folder so the user sees siblings.
function agentWorkspace(a: AgentEntry): { folder: string; file: string } {
  const file = a.path;
  const lastSep = Math.max(file.lastIndexOf("\\"), file.lastIndexOf("/"));
  return {
    folder: lastSep > 0 ? file.slice(0, lastSep) : "",
    file,
  };
}

export function Agents() {
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [scope, setScope] = useState<ScopeFilter>("all");
  const [category, setCategory] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [view, setView] = useLibraryViewMode("agents");
  const [selected, setSelected] = useState<AgentEntry | null>(null);

  useEffect(() => {
    invoke<ProjectLite[]>("list_projects")
      .then((list) =>
        setProjects(list.map((p) => ({ id: p.id, name: p.name }))),
      )
      .catch(() => setProjects([]));
  }, []);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = (await invoke("list_agents", {
        projectPath: null,
      })) as AgentEntry[];
      setAgents(res);
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
    const subset =
      scope === "all" ? agents : agents.filter((a) => a.origin === scope);
    const set = new Set<string>();
    for (const a of subset) set.add(deriveCategory(a));
    return Array.from(set).sort((a, b) => {
      if (a === NO_CATEGORY) return 1;
      if (b === NO_CATEGORY) return -1;
      return a.localeCompare(b);
    });
  }, [agents, scope]);

  useEffect(() => {
    if (category !== "all" && !categories.includes(category)) {
      setCategory("all");
    }
  }, [categories, category]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return agents.filter((a) => {
      if (scope !== "all" && a.origin !== scope) return false;
      if (category !== "all" && deriveCategory(a) !== category) return false;
      if (!q) return true;
      return (
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q)
      );
    });
  }, [agents, scope, category, query]);

  // update_agent_md is slug-based and only resolves global agents — limit
  // inline editing to that origin. Plugin / project agents are read-only;
  // the detail pane hides Edit when onSave is absent.
  const buildOnSave = (
    a: AgentEntry,
  ): ((body: string) => Promise<void>) | undefined => {
    if (a.origin !== "global") return undefined;
    return async (body: string) => {
      await invoke("update_agent_md", { name: a.name, content: body });
      await reload();
    };
  };

  const treeOrigins: TreeOrigin<AgentEntry>[] = useMemo(() => {
    const buckets: Record<SkillOrigin, Record<string, AgentEntry[]>> = {
      global: {},
      project: {},
      plugin: {},
    };
    for (const a of filtered) {
      const cat = deriveCategory(a);
      (buckets[a.origin][cat] ??= []).push(a);
    }
    return (["global", "project", "plugin"] as SkillOrigin[]).map((id) => ({
      id,
      label: id.charAt(0).toUpperCase() + id.slice(1),
      groups: Object.entries(buckets[id])
        .sort(([a], [b]) => {
          if (a === NO_CATEGORY) return 1;
          if (b === NO_CATEGORY) return -1;
          return a.localeCompare(b);
        })
        .map(([name, list]) => ({
          name,
          leaves: list.map((a) => ({
            key: `${a.origin}-${a.path}`,
            label: a.name,
            data: a,
          })),
        })),
    }));
  }, [filtered]);

  const blockItems: BlocksItem<AgentEntry>[] = useMemo(
    () =>
      filtered.map((a) => ({
        key: `${a.origin}-${a.path}`,
        topGroup: deriveTopGroup(a),
        subGroup: deriveSubGroup(a),
        data: a,
      })),
    [filtered],
  );

  const renderCardGrid = (items: AgentEntry[]) => (
    <div
      className="grid gap-3"
      style={{
        gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
      }}
    >
      {items.map((a) => {
        const isActive = selected?.path === a.path;
        return (
          <button
            key={`${a.origin}-${a.path}`}
            type="button"
            onClick={() => setSelected(a)}
            className="group flex h-[140px] flex-col justify-between rounded-xl p-4 text-left transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
            style={{
              background: isActive
                ? "var(--color-surface-3)"
                : "var(--color-surface-2)",
              border: `1px solid ${
                isActive ? AGENT_ACCENT : "var(--color-border)"
              }`,
              boxShadow: `inset 0 3px 0 ${AGENT_ACCENT}`,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = AGENT_ACCENT;
              e.currentTarget.style.transform = "translateY(-2px)";
              e.currentTarget.style.boxShadow = `inset 0 3px 0 ${AGENT_ACCENT}, 0 6px 18px rgba(0,0,0,0.28)`;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = isActive
                ? AGENT_ACCENT
                : "var(--color-border)";
              e.currentTarget.style.transform = "translateY(0)";
              e.currentTarget.style.boxShadow = `inset 0 3px 0 ${AGENT_ACCENT}`;
            }}
            title={a.description || a.name}
          >
            <div
              className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.08em]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              <Bot size={12} />
              Agent
              <span
                className="ml-auto rounded px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide"
                style={{
                  background: AGENT_ACCENT_SOFT,
                  color: "#c4b5fd",
                  border: "1px solid rgba(167, 139, 250, 0.35)",
                }}
              >
                {a.origin}
              </span>
            </div>
            <div
              className="line-clamp-3 text-[18px] font-semibold leading-tight tracking-tight"
              style={{ color: "var(--color-text)" }}
            >
              {a.name}
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
          <h2 className="text-lg font-semibold">Agents</h2>
          <span
            className="text-[11.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {filtered.length} of {agents.length}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <ViewToggle mode={view} onChange={setView} />
          <button
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            <Plus size={12} /> New agent
          </button>
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

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          {SCOPES.map((s) => {
            const isActive = scope === s.id;
            return (
              <button
                key={s.id}
                onClick={() => setScope(s.id)}
                className="rounded-full border px-3 py-1 text-xs transition-colors"
                style={{
                  borderColor: isActive
                    ? "var(--color-accent)"
                    : "var(--color-border-strong)",
                  background: isActive
                    ? "var(--color-accent)"
                    : "transparent",
                  color: isActive
                    ? "var(--color-accent-text)"
                    : "var(--color-text-secondary)",
                }}
              >
                {s.label}
              </button>
            );
          })}
        </div>

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
      </div>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Buscar agents…"
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
              Sin agents para el filtro actual.
            </p>
          ) : view === "blocks" ? (
            <BlocksView<AgentEntry>
              items={blockItems}
              noun="agent"
              emptyLabel="Sin agents para el filtro actual."
              topGroupAccent={() => AGENT_ACCENT}
              renderLeaves={(items) =>
                renderCardGrid(items.map((it) => it.data))
              }
            />
          ) : view === "tree" ? (
            <TreeView<AgentEntry>
              origins={treeOrigins}
              selectedKey={selected ? `${selected.origin}-${selected.path}` : null}
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
              const ws = agentWorkspace(selected);
              const subtitleParts: string[] = [selected.origin];
              const cat = deriveCategory(selected);
              if (cat !== NO_CATEGORY) subtitleParts.push(cat);
              return (
                <LibraryDetailPane
                  kind="agent"
                  name={selected.name}
                  subtitle={subtitleParts.join(" · ")}
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

      {createOpen && (
        <CreateAgentModal
          projects={projects}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            void reload();
          }}
        />
      )}
    </div>
  );
}
