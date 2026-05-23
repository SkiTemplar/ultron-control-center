// ULTRON Control Center 2.0 — Agents viewer (P2).
//
// Lists agents from 3 origins (global / project / plugin) with scope chips,
// search, and "open in editor". Backend = `list_agents` Tauri command.

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import type { AgentEntry, RemoteItem, SkillOrigin } from "../types";
import { SearchGitHubModal } from "./library/SearchGitHubModal";
import { InstallConfirmModal } from "./library/InstallConfirmModal";
import { CreateAgentModal } from "./library/CreateAgentModal";

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

export function Agents() {
  const [agents, setAgents] = useState<AgentEntry[]>([]);
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return agents.filter((a) => {
      if (scope !== "all" && a.origin !== scope) return false;
      if (!q) return true;
      return (
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q)
      );
    });
  }, [agents, scope, query]);

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
        <h2 className="text-lg font-semibold">Agents</h2>
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
            + New agent
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
        placeholder="Buscar agents…"
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
            Sin agents para el filtro actual.
          </p>
        ) : (
          <ul className="space-y-2">
            {filtered.map((a) => (
              <li
                key={`${a.origin}-${a.path}`}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3 text-sm"
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="font-medium">{a.name}</span>
                  <span
                    className="rounded-full px-2 py-0.5 text-xs text-white"
                    style={{ background: originChipColor(a.origin) }}
                  >
                    {a.origin}
                  </span>
                </div>
                <p className="mb-2 text-xs text-[var(--color-text-muted)]">
                  {a.description || "(sin descripcion)"}
                </p>
                <button
                  onClick={() => handleOpen(a.path)}
                  className="rounded-md border border-[var(--color-border)] px-2 py-0.5 text-xs hover:bg-[var(--color-surface-2)]"
                >
                  Open in editor
                </button>
              </li>
            ))}
          </ul>
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
