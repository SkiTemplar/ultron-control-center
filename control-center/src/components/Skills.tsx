// ULTRON Control Center 2.0 — Skills viewer.
//
// Lists skills from 3 origins (global / project / plugin) with scope chips,
// search, category filter (derived from path segments), "open in editor",
// and an enable/disable toggle (global only). Backend = `list_skills` +
// `skill_toggle` Tauri commands.

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import type { RemoteItem, SkillEntry, SkillOrigin } from "../types";
import { SearchGitHubModal } from "./library/SearchGitHubModal";
import { InstallConfirmModal } from "./library/InstallConfirmModal";
import { CreateSkillModal } from "./library/CreateSkillModal";
import { Folder, Github, Plus, Sparkle } from "./library/icons";

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

export function Skills() {
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [scope, setScope] = useState<ScopeFilter>("all");
  const [category, setCategory] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [installItem, setInstallItem] = useState<RemoteItem | null>(null);
  const [projects, setProjects] = useState<ProjectLite[]>([]);

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
      const skillMd = path.endsWith(".md") ? path : `${path}/SKILL.md`;
      await openPath(skillMd);
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
        ) : (
          <ul className="grid gap-2 md:grid-cols-2">
            {filtered.map((s) => {
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
                  <p
                    className="mb-2 text-xs leading-snug"
                    style={{ color: "var(--color-text-secondary)" }}
                  >
                    {s.description || "(sin descripción)"}
                  </p>
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
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {searchOpen && (
        <SearchGitHubModal
          kind="skill"
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
          kind="skill"
          onClose={() => setInstallItem(null)}
          onInstalled={() => {
            setInstallItem(null);
            void reload();
          }}
        />
      )}
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
