// ULTRON Control Center 2.6 — Skills viewer.
//
// 3-way view: Grid (legacy card layout), Tree (origin → group → leaf), and
// Blocks (Spotify-style drill-down per USER: top-level tile per origin /
// plugin → sub-category tile → leaf list). Default = Blocks; persists per
// sub-tab via `useLibraryViewMode`.
//
// Backend = `list_skills` + `skill_toggle` Tauri commands (unchanged).

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import type { SkillEntry, SkillOrigin } from "../types";
import { CreateSkillModal } from "./library/CreateSkillModal";
import { Folder, Plus, Sparkle } from "./library/icons";

// v2.6 (v27-f14): sibling-file metadata returned by `list_skill_files`.
type SiblingFile = {
  name: string;
  path: string;
  is_dir: boolean;
  ext: string | null;
  size_bytes: number | null;
};

// v2.6 (v27-f14): on-demand sibling-file list rendered inside each Skills
// card. Lazy — `list_skill_files` only fires when the user clicks "Files".
// On clicking an entry we delegate to the OS via `openPath`, which routes
// to the user's default editor for that extension (VS Code for .md/.py/...,
// File Explorer for sub-folders).
function SkillFilesInline({ entryPath }: { entryPath: string }) {
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

// v2.6 (card-v26-fb-024): detect CJK (Chinese/Japanese/Korean) characters
// in skill description. Read-only audit — flags skills whose author wrote
// the description in a non-Castilian language so USER can decide
// whether to disable / replace them. Does NOT edit plugin files.
const CJK_REGEX = /[一-鿿぀-ヿ가-힯]/;
function hasCJK(text: string | null | undefined): boolean {
  if (!text) return false;
  return CJK_REGEX.test(text);
}

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
///   ~/.claude/skills/agent-skills/foo/SKILL.md → "agent-skills"
///   ~/.claude/skills/foo                       → "uncategorized"
///   .../plugins/cache/<id>/<plugin>/<ver>/skills/foo → "<plugin>"
function deriveCategory(s: SkillEntry): string {
  const norm = s.path.replace(/\\/g, "/");
  // Plugin scope: bucket by plugin name (the parent of the `skills/` dir).
  if (s.origin === "plugin") {
    const m = norm.match(/\/plugins\/cache\/[^/]+\/([^/]+)\/[^/]+\/skills\//);
    if (m && m[1]) return m[1];
  }
  // Global / project: capture any segment between `skills/` and the skill
  // dir itself. If the skill lives at top level of skills/, it has no
  // sub-folder and counts as uncategorized.
  const m = norm.match(/\/skills\/([^/]+)\/[^/]+\/?(?:SKILL\.md)?$/);
  if (m && m[1] && m[1] !== s.name) return m[1];
  return NO_CATEGORY;
}

/// Derive the Blocks-view top-level group label. Distinct from the legacy
/// scope chip: plugin-scoped skills land under their plugin name (so the
/// user sees "ecc", "superpowers", … as separate tiles instead of a single
/// "Plugin" bucket).
function deriveTopGroup(s: SkillEntry): string {
  if (s.origin === "global") return "Global";
  if (s.origin === "project") return "Project";
  return deriveCategory(s);
}

/// Derive the Blocks-view sub-group label. For plugin skills we look at the
/// path segment immediately AFTER `skills/` so categories like "agent",
/// "tooling", "review" surface as sub-tiles. Global / project skills run
/// through the `categorize()` domain map first so personal skills land
/// under real sub-tiles (Personas, Game Dev, …) instead of "Uncategorized".
function deriveSubGroup(s: SkillEntry): string | null {
  // v2.6 feedback: try the domain map FIRST regardless of origin so ECC
  // and superpowers plugin skills also surface under meaningful sub-tiles
  // (Personas, AI Engineering, …). Path-based fallback below only kicks
  // in when the slug + description has no confident match.
  const domain = categorize(s.name, s.description);
  if (domain) return domain;
  const norm = s.path.replace(/\\/g, "/");
  if (s.origin === "plugin") {
    const m = norm.match(/\/skills\/([^/]+)\/[^/]+\/?(?:SKILL\.md)?$/);
    if (m && m[1] && m[1] !== s.name) return m[1];
    return null;
  }
  const cat = deriveCategory(s);
  if (cat === NO_CATEGORY) return null;
  return cat;
}

export function Skills() {
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [scope, setScope] = useState<ScopeFilter>("all");
  const [category, setCategory] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [view, setView] = useLibraryViewMode("skills");

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
      const res = (await invoke("list_skills", {
        projectPath: null,
      })) as SkillEntry[];
      setSkills(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  // Build the unique sorted category list from the currently scoped slice
  // so the chip row tracks the scope filter.
  const categories = useMemo(() => {
    const subset =
      scope === "all" ? skills : skills.filter((s) => s.origin === scope);
    const set = new Set<string>();
    for (const s of subset) set.add(deriveCategory(s));
    const arr = Array.from(set).sort((a, b) => {
      if (a === NO_CATEGORY) return 1;
      if (b === NO_CATEGORY) return -1;
      return a.localeCompare(b);
    });
    return arr;
  }, [skills, scope]);

  // Reset category when scope changes if the chosen category disappeared.
  useEffect(() => {
    if (category !== "all" && !categories.includes(category)) {
      setCategory("all");
    }
  }, [categories, category]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return skills.filter((s) => {
      if (scope !== "all" && s.origin !== scope) return false;
      if (category !== "all" && deriveCategory(s) !== category) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q)
      );
    });
  }, [skills, scope, category, query]);

  const handleOpen = async (path: string) => {
    try {
      // Strip the trailing SKILL.md so VS Code opens the whole skill folder —
      // README, examples and supporting markdowns become visible at once.
      // Flat skills (no folder) just keep their .md path; the backend cmd
      // happily passes both shapes straight through to `code`.
      const target = path.replace(/[\\/]SKILL\.md$/, "");
      await invoke("open_folder_in_vscode", { target });
    } catch (e) {
      setError(`open ${path}: ${e}`);
    }
  };

  const handleToggle = async (s: SkillEntry) => {
    if (s.origin !== "global") return;
    try {
      await invoke("skill_toggle", { name: s.name, enabled: !s.enabled });
      await reload();
    } catch (e) {
      setError(`toggle ${s.name}: ${e}`);
    }
  };

  // Build the Tree-view origins (legacy 3-level tree). Kept for users who
  // prefer the dense sidebar look.
  const treeOrigins: TreeOrigin<SkillEntry>[] = useMemo(() => {
    const buckets: Record<SkillOrigin, Record<string, SkillEntry[]>> = {
      global: {},
      project: {},
      plugin: {},
    };
    for (const s of filtered) {
      const cat = deriveCategory(s);
      (buckets[s.origin][cat] ??= []).push(s);
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
          leaves: list.map((s) => ({
            key: `${s.origin}-${s.path}`,
            label: s.name,
            data: s,
          })),
        })),
    }));
  }, [filtered]);

  // Build the Blocks-view items. Top group folds plugin scope into per-plugin
  // tiles so "ecc" and "superpowers" surface separately, as USER requested.
  const blockItems: BlocksItem<SkillEntry>[] = useMemo(
    () =>
      filtered.map((s) => ({
        key: `${s.origin}-${s.path}`,
        topGroup: deriveTopGroup(s),
        subGroup: deriveSubGroup(s),
        data: s,
      })),
    [filtered],
  );

  // Card layout used by both Grid mode and Blocks mode's leaf view — keeps
  // the visual language consistent.
  const renderCardGrid = (items: SkillEntry[]) => (
    <ul className="grid gap-2 md:grid-cols-2">
      {items.map((s) => {
        const cat = deriveCategory(s);
        const chip = originChipStyle(s.origin);
        return (
          <li
            key={`${s.origin}-${s.path}`}
            className="rounded-md p-3 text-sm transition-colors"
            style={{
              border: "1px solid var(--color-border-strong)",
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              opacity: s.enabled ? 1 : 0.55,
            }}
          >
            <div className="mb-1 flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <Sparkle
                  size={12}
                  className="shrink-0 text-[var(--color-text-tertiary)]"
                />
                <span className="truncate font-medium">{s.name}</span>
                {hasCJK(s.description) && (
                  <span
                    className="rounded px-1 py-px text-[9px] font-semibold uppercase"
                    style={{
                      background: "rgba(210, 153, 34, 0.18)",
                      color: "var(--color-warn)",
                    }}
                    title="Description contains CJK characters — candidate for cleanup"
                  >
                    CJK
                  </span>
                )}
              </div>
              <span
                className="rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide"
                style={chip}
              >
                {s.origin}
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
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleOpen(s.path)}
                className="rounded-md border px-2 py-0.5 text-xs"
                style={{
                  borderColor: "var(--color-border-strong)",
                  background: "var(--color-surface-3)",
                  color: "var(--color-text)",
                }}
              >
                Open in editor
              </button>
              {s.origin === "global" && (
                <button
                  onClick={() => handleToggle(s)}
                  className="rounded-md border px-2 py-0.5 text-xs"
                  style={{
                    borderColor: s.enabled
                      ? "var(--color-border-strong)"
                      : "var(--color-accent)",
                    background: s.enabled
                      ? "var(--color-surface-3)"
                      : "var(--color-accent)",
                    color: s.enabled
                      ? "var(--color-text)"
                      : "var(--color-accent-text)",
                  }}
                >
                  {s.enabled ? "Disable" : "Enable"}
                </button>
              )}
            </div>
            {/* v2.6 (v27-f14): sibling files of the skill folder. */}
            <SkillFilesInline entryPath={s.path} />
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h2 className="text-lg font-semibold">Skills</h2>
          <span
            className="text-[11.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {filtered.length} of {skills.length}
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
            <Plus size={12} /> New skill
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
        placeholder="Buscar skills…"
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
            Sin skills para el filtro actual.
          </p>
        ) : view === "blocks" ? (
          <BlocksView<SkillEntry>
            items={blockItems}
            noun="skill"
            emptyLabel="Sin skills para el filtro actual."
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
          <TreeView<SkillEntry>
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
        <CreateSkillModal
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
