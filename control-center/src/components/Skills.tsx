// ULTRON Control Center 2.6 — Skills viewer (FULL REDESIGN).
//
// USER's brief: the v2.6.x card layout was "para nada lo que buscaba".
// He wants the same big-tile pattern the Blocks-view category screen uses,
// but as the PRIMARY layout for Skills / Agents / Rules — click a card,
// detail slides in on the right with Edit / Edit with AI / Open Externally.
//
// What changed:
//   - Cards now show ONLY the skill name (+ a cyan sparkle to distinguish
//     skills from agents/rules at a glance). No description, no chips, no
//     sibling-file expander — that detail lives in the right pane.
//   - Default view is the card grid. Tree and Blocks (drill-down) are
//     preserved for power users via the toggle.
//   - Selecting a card opens `LibraryDetailPane` on the right. The pane
//     loads the body via the new `read_text_file` Tauri command (which
//     handles plugin-scoped paths the slug-based reader can't reach).
//   - "Open Externally" opens the workspace folder in VS Code with the
//     specific file focused — multi-file skills surface their helpers.
//
// Filters (scope chips, category chips, search) and the New / Refresh
// buttons are unchanged. `skill_toggle` is still available, but it now
// lives in the detail pane action bar.

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SkillEntry, SkillOrigin } from "../types";
import { CreateSkillModal } from "./library/CreateSkillModal";
import { Plus, Sparkle } from "./library/icons";
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

// v2.6 cyan accent — distinguishes skill cards from agents (violet) and
// rules (lime) at a glance.
const SKILL_ACCENT = "rgba(56, 189, 248, 0.55)";
const SKILL_ACCENT_SOFT = "rgba(56, 189, 248, 0.16)";

/// Derive a category from the on-disk path. Examples:
///   ~/.claude/skills/agent-skills/foo/SKILL.md → "agent-skills"
///   ~/.claude/skills/foo                       → "uncategorized"
///   .../plugins/cache/<id>/<plugin>/<ver>/skills/foo → "<plugin>"
function deriveCategory(s: SkillEntry): string {
  const norm = s.path.replace(/\\/g, "/");
  if (s.origin === "plugin") {
    const m = norm.match(/\/plugins\/cache\/[^/]+\/([^/]+)\/[^/]+\/skills\//);
    if (m && m[1]) return m[1];
  }
  const m = norm.match(/\/skills\/([^/]+)\/[^/]+\/?(?:SKILL\.md)?$/);
  if (m && m[1] && m[1] !== s.name) return m[1];
  return NO_CATEGORY;
}

function deriveTopGroup(s: SkillEntry): string {
  if (s.origin === "global") return "Global";
  if (s.origin === "project") return "Project";
  return deriveCategory(s);
}

function deriveSubGroup(s: SkillEntry): string | null {
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

/// Compute the workspace folder for a skill. SKILL.md lives inside a folder
/// with examples + helpers — opening that folder in VS Code is what USER
/// wants ("para que las skills con multiples carpetas abra todo su
/// workspace"). For flat skills (top-level .md), the folder is the parent.
function skillWorkspace(s: SkillEntry): { folder: string; file: string } {
  const file = s.path;
  const norm = file.replace(/\\/g, "/");
  // Standard SKILL.md → folder is the directory above.
  if (/\/SKILL\.md$/i.test(norm)) {
    return {
      folder: file.replace(/[\\/]SKILL\.md$/i, ""),
      file,
    };
  }
  // Flat .md skill → folder is the parent directory.
  const lastSep = Math.max(file.lastIndexOf("\\"), file.lastIndexOf("/"));
  return {
    folder: lastSep > 0 ? file.slice(0, lastSep) : "",
    file,
  };
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
  // v2.6 redesign: default to "grid" so the card-and-detail flow lands first.
  const [view, setView] = useLibraryViewMode("skills");

  // Detail-pane state.
  const [selected, setSelected] = useState<SkillEntry | null>(null);

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

  const categories = useMemo(() => {
    const subset =
      scope === "all" ? skills : skills.filter((s) => s.origin === scope);
    const set = new Set<string>();
    for (const s of subset) set.add(deriveCategory(s));
    return Array.from(set).sort((a, b) => {
      if (a === NO_CATEGORY) return 1;
      if (b === NO_CATEGORY) return -1;
      return a.localeCompare(b);
    });
  }, [skills, scope]);

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

  const handleToggle = async (s: SkillEntry) => {
    if (s.origin !== "global") return;
    try {
      await invoke("skill_toggle", { name: s.name, enabled: !s.enabled });
      await reload();
    } catch (e) {
      setError(`toggle ${s.name}: ${e}`);
    }
  };

  // Save handler passed to the detail pane. Only valid for global skills
  // (the only origin update_skill_md accepts) — plugin / project skills
  // are read-only; the pane hides the Edit button when onSave is absent.
  const buildOnSave = (s: SkillEntry): ((body: string) => Promise<void>) | undefined => {
    if (s.origin !== "global") return undefined;
    return async (body: string) => {
      await invoke("update_skill_md", { name: s.name, content: body });
      await reload();
    };
  };

  // Tree-view origins (legacy power-user mode).
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

  // ---- Name-only card grid (the redesign) ----
  //
  // Tile shape mirrors `BlocksView` Tile — USER wants the same visual
  // language across categories and entries. Each skill card has:
  //   - small "Skill" header chip
  //   - the skill name in big type
  //   - a tiny origin badge in the corner
  //   - cyan ribbon at the top to differentiate from agents (violet) / rules
  // Click → opens the detail pane on the right.

  const renderCardGrid = (items: SkillEntry[]) => (
    <div
      className="grid gap-3"
      style={{
        gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
      }}
    >
      {items.map((s) => {
        const isActive = selected?.path === s.path;
        return (
          <button
            key={`${s.origin}-${s.path}`}
            type="button"
            onClick={() => setSelected(s)}
            className="group flex h-[140px] flex-col justify-between rounded-xl p-4 text-left transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
            style={{
              background: isActive
                ? "var(--color-surface-3)"
                : "var(--color-surface-2)",
              border: `1px solid ${
                isActive ? SKILL_ACCENT : "var(--color-border)"
              }`,
              boxShadow: `inset 0 3px 0 ${SKILL_ACCENT}`,
              opacity: s.enabled ? 1 : 0.55,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = SKILL_ACCENT;
              e.currentTarget.style.transform = "translateY(-2px)";
              e.currentTarget.style.boxShadow = `inset 0 3px 0 ${SKILL_ACCENT}, 0 6px 18px rgba(0,0,0,0.28)`;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = isActive
                ? SKILL_ACCENT
                : "var(--color-border)";
              e.currentTarget.style.transform = "translateY(0)";
              e.currentTarget.style.boxShadow = `inset 0 3px 0 ${SKILL_ACCENT}`;
            }}
            title={s.description || s.name}
          >
            <div
              className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.08em]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              <Sparkle size={12} />
              Skill
              <span
                className="ml-auto rounded px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide"
                style={{
                  background: SKILL_ACCENT_SOFT,
                  color: "#67e8f9",
                  border: "1px solid rgba(56, 189, 248, 0.35)",
                }}
              >
                {s.origin}
              </span>
            </div>
            <div
              className="line-clamp-3 text-[18px] font-semibold leading-tight tracking-tight"
              style={{ color: "var(--color-text)" }}
            >
              {s.name}
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

      {/* 2-pane layout: card list on the left, detail pane on the right
          when a skill is selected. Stacks vertically on narrow viewports. */}
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
              Sin skills para el filtro actual.
            </p>
          ) : view === "blocks" ? (
            <BlocksView<SkillEntry>
              items={blockItems}
              noun="skill"
              emptyLabel="Sin skills para el filtro actual."
              topGroupAccent={() => SKILL_ACCENT}
              renderLeaves={(items) =>
                renderCardGrid(items.map((it) => it.data))
              }
            />
          ) : view === "tree" ? (
            <TreeView<SkillEntry>
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
              const ws = skillWorkspace(selected);
              const subtitleParts: string[] = [];
              subtitleParts.push(selected.origin);
              const cat = deriveCategory(selected);
              if (cat !== NO_CATEGORY) subtitleParts.push(cat);
              if (selected.origin === "global") {
                subtitleParts.push(selected.enabled ? "enabled" : "disabled");
              }
              return (
                <div className="flex h-full flex-col gap-2">
                  <LibraryDetailPane
                    kind="skill"
                    name={selected.name}
                    subtitle={subtitleParts.join(" · ")}
                    filePath={ws.file}
                    folderPath={ws.folder}
                    onSave={buildOnSave(selected)}
                    onClose={() => setSelected(null)}
                  />
                  {selected.origin === "global" && (
                    <button
                      type="button"
                      onClick={() => void handleToggle(selected)}
                      className="rounded-md border px-3 py-1.5 text-[11.5px]"
                      style={{
                        borderColor: selected.enabled
                          ? "var(--color-border-strong)"
                          : "var(--color-accent)",
                        background: selected.enabled
                          ? "var(--color-surface-2)"
                          : "var(--color-accent)",
                        color: selected.enabled
                          ? "var(--color-text)"
                          : "var(--color-accent-text)",
                      }}
                    >
                      {selected.enabled ? "Disable skill" : "Enable skill"}
                    </button>
                  )}
                </div>
              );
            })()}
          </div>
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
