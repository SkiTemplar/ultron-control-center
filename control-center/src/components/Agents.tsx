// ULTRON Control Center 2.6 — Agents viewer.
//
// 3-way view: Grid (legacy cards), Tree (origin → group → leaf), and Blocks
// (Spotify-style drill-down). Default = Blocks. Backend = `list_agents`.

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import type { AgentEntry, RemoteItem, SkillOrigin } from "../types";
import { SearchGitHubModal } from "./library/SearchGitHubModal";
import { InstallConfirmModal } from "./library/InstallConfirmModal";
import { CreateAgentModal } from "./library/CreateAgentModal";
import { Bot, Folder, Github, Plus } from "./library/icons";
import { TreeView, type TreeOrigin } from "./library/TreeView";
import {
  BlocksView,
  type BlocksItem,
} from "./library/BlocksView";
import { ViewToggle, useLibraryViewMode } from "./library/ViewToggle";

type ProjectLite = { id: string; name: string };

type ScopeFilter = "all" | SkillOrigin;

const SCOPES: { id: ScopeFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "global", label: "Global" },
  { id: "project", label: "Project" },
  { id: "plugin", label: "Plugin" },
];

const NO_CATEGORY = "uncategorized";

function originChipStyle(origin: SkillOrigin): {
  background: string;
  color: string;
  border: string;
} {
  switch (origin) {
    case "global":
      return {
        background: "var(--color-surface-4)",
        color: "var(--color-text)",
        border: "1px solid var(--color-border-strong)",
      };
    case "project":
      return {
        background: "rgba(136, 136, 204, 0.16)",
        color: "#b6b6ff",
        border: "1px solid rgba(136, 136, 204, 0.40)",
      };
    case "plugin":
      return {
        background: "rgba(168, 136, 168, 0.16)",
        color: "#e0bce0",
        border: "1px solid rgba(168, 136, 168, 0.40)",
      };
  }
}

/// Derive a category from the on-disk path. Examples:
///   ~/.claude/agents/sec/reviewer.md → "sec"
///   ~/.claude/agents/reviewer.md     → "uncategorized"
///   .../plugins/cache/<id>/<plugin>/<ver>/agents/foo.md → "<plugin>"
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

/// Top-level Blocks group: per-plugin tile when plugin-scoped, else Global /
/// Project (mirrors Skills.tsx behaviour).
function deriveTopGroup(a: AgentEntry): string {
  if (a.origin === "global") return "Global";
  if (a.origin === "project") return "Project";
  return deriveCategory(a);
}

/// Sub-group within a top-level Blocks tile. For plugin agents, this is the
/// folder under `agents/` if one exists. For global/project agents, the
/// category itself becomes the sub-group.
function deriveSubGroup(a: AgentEntry): string | null {
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

type EnableFilter = "active" | "disabled" | "all";

export function Agents() {
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [scope, setScope] = useState<ScopeFilter>("all");
  const [category, setCategory] = useState<string>("all");
  const [enableFilter, setEnableFilter] = useState<EnableFilter>("active");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [installItem, setInstallItem] = useState<RemoteItem | null>(null);
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [view, setView] = useLibraryViewMode("agents");
  // Mirrors Skills.tsx: tracks in-flight toggle requests so the card can
  // disable its button while the rename happens on disk.
  const [toggleBusy, setToggleBusy] = useState<Set<string>>(new Set());

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

  // Counts for the Active/Disabled/All toolbar — computed BEFORE the enable
  // filter so the chip numbers stay stable as the user flips between tabs.
  const enableCounts = useMemo(() => {
    let active = 0;
    let disabled = 0;
    for (const a of agents) {
      if (scope !== "all" && a.origin !== scope) continue;
      if (a.enabled) active += 1;
      else disabled += 1;
    }
    return { active, disabled };
  }, [agents, scope]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return agents.filter((a) => {
      if (scope !== "all" && a.origin !== scope) return false;
      if (category !== "all" && deriveCategory(a) !== category) return false;
      if (enableFilter === "active" && !a.enabled) return false;
      if (enableFilter === "disabled" && a.enabled) return false;
      if (!q) return true;
      return (
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q)
      );
    });
  }, [agents, scope, category, enableFilter, query]);

  const handleOpen = async (path: string) => {
    try {
      await openPath(path);
    } catch (e) {
      setError(`open ${path}: ${e}`);
    }
  };

  // Flip the disabled/enabled flag on a global agent. Mirrors skill_toggle
  // optimism: update the in-memory list first, revert on backend error so
  // the user sees instant feedback. Plugin/project agents are read-only.
  const toggleAgent = async (a: AgentEntry) => {
    if (a.origin !== "global") return;
    if (toggleBusy.has(a.path)) return;
    const next = !a.enabled;
    setToggleBusy((prev) => new Set(prev).add(a.path));
    const snapshot = agents;
    setAgents((prev) =>
      prev.map((x) =>
        x.path === a.path ? { ...x, enabled: next } : x,
      ),
    );
    try {
      const updated = (await invoke("agent_toggle", {
        name: a.name,
        enabled: next,
      })) as AgentEntry;
      setAgents((prev) =>
        prev.map((x) => (x.path === a.path ? updated : x)),
      );
    } catch (e) {
      setAgents(snapshot);
      setError(`toggle ${a.name}: ${e}`);
    } finally {
      setToggleBusy((prev) => {
        const n = new Set(prev);
        n.delete(a.path);
        return n;
      });
    }
  };

  // Tree-view origins for the legacy tree mode.
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

  // Blocks-view items. Top group splits plugin scope into per-plugin tiles.
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

  // Card grid used by Grid mode and Blocks-mode leaves.
  const renderCardGrid = (items: AgentEntry[]) => (
    <ul className="grid gap-2 md:grid-cols-2">
      {items.map((a) => {
        const cat = deriveCategory(a);
        const chip = originChipStyle(a.origin);
        return (
          <li
            key={`${a.origin}-${a.path}`}
            className="rounded-md p-3 text-sm"
            style={{
              border: "1px solid var(--color-border-strong)",
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
            }}
          >
            <div className="mb-1 flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <Bot
                  size={12}
                  className="shrink-0 text-[var(--color-text-tertiary)]"
                />
                <span className="truncate font-medium">{a.name}</span>
              </div>
              <span
                className="rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide"
                style={chip}
              >
                {a.origin}
              </span>
            </div>
            {cat !== NO_CATEGORY && (
              <div
                className="mb-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-tertiary)",
                }}
              >
                <Folder size={10} /> {cat}
              </div>
            )}
            <p
              className="mb-2 text-xs leading-snug"
              style={{ color: "var(--color-text-secondary)" }}
            >
              {a.description || "(sin descripción)"}
            </p>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => handleOpen(a.path)}
                className="rounded-md border px-2 py-0.5 text-xs"
                style={{
                  borderColor: "var(--color-border-strong)",
                  background: "var(--color-surface-3)",
                  color: "var(--color-text)",
                }}
              >
                Open in editor
              </button>
              {a.origin === "global" && (
                <button
                  onClick={() => void toggleAgent(a)}
                  disabled={toggleBusy.has(a.path)}
                  title={
                    a.enabled
                      ? "Disable this agent (renames file to .md.disabled)"
                      : "Re-enable this agent"
                  }
                  className="rounded-md border px-2 py-0.5 text-xs disabled:opacity-50"
                  style={{
                    borderColor: a.enabled
                      ? "rgba(248, 81, 73, 0.30)"
                      : "rgba(63, 185, 80, 0.30)",
                    background: a.enabled
                      ? "rgba(248, 81, 73, 0.08)"
                      : "rgba(63, 185, 80, 0.08)",
                    color: a.enabled
                      ? "var(--color-danger)"
                      : "var(--color-success)",
                  }}
                >
                  {a.enabled ? "Disable" : "Enable"}
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
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
            onClick={() => setSearchOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1 text-xs"
            style={{
              borderColor: "var(--color-border-strong)",
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
            }}
          >
            <Github size={12} /> Search GitHub
          </button>
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
        {/* Active / Disabled / All — same shape as Skills.tsx so users
            recognise the toggle pattern instantly. Counts reflect the
            scope filter so they shrink/grow as the user picks a scope. */}
        <div
          className="inline-flex items-center gap-1 self-start rounded-lg p-1"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
          }}
        >
          {([
            { id: "active" as const, label: "Active", count: enableCounts.active },
            { id: "disabled" as const, label: "Disabled", count: enableCounts.disabled },
            { id: "all" as const, label: "All", count: enableCounts.active + enableCounts.disabled },
          ]).map((tab) => {
            const isActive = enableFilter === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setEnableFilter(tab.id)}
                className="flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium transition-colors"
                style={{
                  background: isActive ? "var(--color-surface-4)" : "transparent",
                  color: isActive ? "var(--color-text)" : "var(--color-text-secondary)",
                  border: isActive
                    ? "1px solid var(--color-border-strong)"
                    : "1px solid transparent",
                }}
              >
                {tab.label}
                <span
                  className="rounded-full px-1.5 py-px text-[10px] font-semibold tabular-nums"
                  style={{
                    background: isActive
                      ? "var(--color-surface-3)"
                      : "var(--color-surface-3)",
                    color: isActive
                      ? "var(--color-text)"
                      : "var(--color-text-tertiary)",
                  }}
                >
                  {tab.count}
                </span>
              </button>
            );
          })}
        </div>
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
            Sin agents para el filtro actual.
          </p>
        ) : view === "blocks" ? (
          <BlocksView<AgentEntry>
            items={blockItems}
            noun="agent"
            emptyLabel="Sin agents para el filtro actual."
            topGroupAccent={(g) => {
              if (g === "Global") return "rgba(136, 136, 204, 0.40)";
              if (g === "Project") return "rgba(168, 136, 168, 0.40)";
              return "rgba(63, 185, 80, 0.32)";
            }}
            renderLeaves={(items) =>
              renderCardGrid(items.map((it) => it.data))
            }
          />
        ) : view === "tree" ? (
          <TreeView<AgentEntry>
            origins={treeOrigins}
            selectedKey={null}
            onSelect={(leaf) => void handleOpen(leaf.data.path)}
            query={query}
          />
        ) : (
          renderCardGrid(filtered)
        )}
      </div>

      {searchOpen && (
        <SearchGitHubModal
          kind="agent"
          onClose={() => setSearchOpen(false)}
          onInstall={(it) => {
            setSearchOpen(false);
            setInstallItem(it);
          }}
        />
      )}
      {installItem && (
        <InstallConfirmModal
          item={installItem}
          kind="agent"
          onClose={() => setInstallItem(null)}
          onInstalled={() => {
            setInstallItem(null);
            void reload();
          }}
        />
      )}
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
