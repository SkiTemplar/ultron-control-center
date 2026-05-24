// ULTRON Control Center 2.6 — Agents viewer.
//
// 3-way view: Grid (legacy cards), Tree (origin → group → leaf), and Blocks
// (Spotify-style drill-down). Default = Blocks. Backend = `list_agents`.

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import type { AgentEntry, SkillOrigin } from "../types";
import { CreateAgentModal } from "./library/CreateAgentModal";
import { Bot, Folder, Plus } from "./library/icons";

// v2.6 (v27-f14): sibling-file metadata returned by `list_skill_files`.
// Agents are typically a single .md so the sibling list usually shows the
// parent folder content (e.g. plugin agents share a directory with peers).
type SiblingFile = {
  name: string;
  path: string;
  is_dir: boolean;
  ext: string | null;
  size_bytes: number | null;
};

function AgentFilesInline({ entryPath }: { entryPath: string }) {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<SiblingFile[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const ensureLoaded = async () => {
    if (files || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const list = (await invoke("list_skill_files", {
        entryPath,
      })) as SiblingFile[];
      setFiles(list);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next) await ensureLoaded();
  };

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => void toggle()}
        className="rounded-md border px-2 py-0.5 text-[11.5px]"
        style={{
          borderColor: "var(--color-border)",
          background: "transparent",
          color: "var(--color-text-tertiary)",
        }}
      >
        {open ? "▾ Files" : "▸ Files"}
        {files && (
          <span className="ml-1 tabular-nums">{files.length}</span>
        )}
      </button>
      {open && (
        <div className="mt-1.5">
          {busy && (
            <p
              className="text-[10.5px]"
              style={{ color: "var(--color-text-faint)" }}
            >
              Loading…
            </p>
          )}
          {err && (
            <p
              className="text-[10.5px]"
              style={{ color: "var(--color-danger)" }}
            >
              {err}
            </p>
          )}
          {files && files.length === 0 && (
            <p
              className="text-[10.5px]"
              style={{ color: "var(--color-text-faint)" }}
            >
              No sibling files.
            </p>
          )}
          {files && files.length > 0 && (
            <ul className="flex flex-wrap gap-1">
              {files.map((f) => (
                <li key={f.path}>
                  <button
                    type="button"
                    onClick={() => {
                      openPath(f.path).catch((e) =>
                        setErr(`open ${f.name}: ${e}`),
                      );
                    }}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px]"
                    style={{
                      background: "var(--color-surface-3)",
                      color: "var(--color-text)",
                      border: "1px solid var(--color-border)",
                      fontFamily: "var(--font-mono)",
                    }}
                    title={f.path}
                  >
                    {f.is_dir ? "📁" : f.ext ? `.${f.ext}` : "📄"}{" "}
                    <span>{f.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
import { TreeView, type TreeOrigin } from "./library/TreeView";
import {
  BlocksView,
  type BlocksItem,
} from "./library/BlocksView";
import { ViewToggle, useLibraryViewMode } from "./library/ViewToggle";
import { categorize } from "../lib/skill-categories";

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

/// Sub-group within a top-level Blocks tile. For plugin agents this is the
/// folder under `agents/`. For global/project agents we first try the
/// `categorize()` domain map (Personas, Game Dev, Quality & Review, …) so
/// personal agents stop collapsing into "Uncategorized"; fall back to the
/// path-based category when the slug + description gives no confident hit.
function deriveSubGroup(a: AgentEntry): string | null {
  // v2.6 feedback: try the domain map FIRST regardless of origin so ECC
  // and other plugin agents also land under meaningful sub-tiles
  // (Personas, Quality & Review, …). Path-based fallback below.
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

  const handleOpen = async (path: string) => {
    try {
      // Agents are standalone .md files (no folder of siblings) — open the
      // file directly in VS Code instead of the parent dir, which would
      // surface every other agent at once.
      await invoke("open_folder_in_vscode", { target: path });
    } catch (e) {
      setError(`open ${path}: ${e}`);
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
            {/* v2.6 (v27-f14): sibling files in the agent's folder. */}
            <AgentFilesInline entryPath={a.path} />
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
              // Ultron palette: true-black monochrome. Sutile jerarquía via
              // alpha del foreground en lugar de tints chromáticos.
              if (g === "Global") return "rgba(245, 245, 245, 0.22)";
              if (g === "Project") return "rgba(160, 160, 160, 0.26)";
              return "rgba(110, 110, 110, 0.22)";
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
