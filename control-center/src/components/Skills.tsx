// ULTRON Control Center 2.0 — Skills viewer (P2).
//
// Lists skills from 3 origins (global / project / plugin) with scope chips,
// search, "open in editor", and an enable/disable toggle (global only).
// Backend = `list_skills` + `skill_toggle` Tauri commands.

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import type { RemoteItem, SkillEntry, SkillOrigin } from "../types";
import { SearchGitHubModal } from "./library/SearchGitHubModal";
import { InstallConfirmModal } from "./library/InstallConfirmModal";
import { CreateSkillModal } from "./library/CreateSkillModal";

type ProjectLite = { id: string; name: string };

type ScopeFilter = "all" | SkillOrigin;

const SCOPES: { id: ScopeFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "global", label: "Global" },
  { id: "project", label: "Project" },
  { id: "plugin", label: "Plugin" },
];

function originChipColor(origin: SkillOrigin): string {
  switch (origin) {
    case "global":
      return "var(--color-accent)";
    case "project":
      return "#88c";
    case "plugin":
      return "#a8a";
  }
}

export function Skills() {
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [scope, setScope] = useState<ScopeFilter>("all");
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return skills.filter((s) => {
      if (scope !== "all" && s.origin !== scope) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q)
      );
    });
  }, [skills, scope, query]);

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
        <h2 className="text-lg font-semibold">Skills</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSearchOpen(true)}
            className="rounded-md border border-[var(--color-border)] px-3 py-1 text-xs hover:bg-[var(--color-surface-2)]"
          >
            Search GitHub
          </button>
          <button
            onClick={() => setCreateOpen(true)}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-white"
          >
            + New skill
          </button>
          <button
            onClick={reload}
            className="rounded-md border border-[var(--color-border)] px-3 py-1 text-xs hover:bg-[var(--color-surface-2)]"
          >
            Refresh
          </button>
        </div>
      </header>

      <div className="flex items-center gap-2">
        {SCOPES.map((s) => (
          <button
            key={s.id}
            onClick={() => setScope(s.id)}
            className={`rounded-full border px-3 py-1 text-xs ${
              scope === s.id
                ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-white"
                : "border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Buscar skills…"
        className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
      />

      {error && (
        <div className="rounded-md border border-[var(--color-error)] bg-[var(--color-surface-1)] p-3 text-xs text-[var(--color-error)]">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <p className="text-xs text-[var(--color-text-muted)]">Loading…</p>
        ) : filtered.length === 0 ? (
          <p className="text-xs text-[var(--color-text-muted)]">
            Sin skills para el filtro actual.
          </p>
        ) : (
          <ul className="space-y-2">
            {filtered.map((s) => (
              <li
                key={`${s.origin}-${s.path}`}
                className={`rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3 text-sm ${
                  s.enabled ? "" : "opacity-60"
                }`}
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="font-medium">{s.name}</span>
                  <span
                    className="rounded-full px-2 py-0.5 text-xs text-white"
                    style={{ background: originChipColor(s.origin) }}
                  >
                    {s.origin}
                  </span>
                </div>
                <p className="mb-2 text-xs text-[var(--color-text-muted)]">
                  {s.description || "(sin descripcion)"}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleOpen(s.path)}
                    className="rounded-md border border-[var(--color-border)] px-2 py-0.5 text-xs hover:bg-[var(--color-surface-2)]"
                  >
                    Open in editor
                  </button>
                  {s.origin === "global" && (
                    <button
                      onClick={() => handleToggle(s)}
                      className={`rounded-md border px-2 py-0.5 text-xs ${
                        s.enabled
                          ? "border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"
                          : "border-[var(--color-accent)] bg-[var(--color-accent)] text-white"
                      }`}
                    >
                      {s.enabled ? "Disable" : "Enable"}
                    </button>
                  )}
                </div>
              </li>
            ))}
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
