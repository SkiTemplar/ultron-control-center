// Top 3-5 most recently active projects, with quick open buttons.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectInfo } from "../../types";
import { Card, SmallButton, relativeTime } from "./Card";

interface RecentProjectsCardProps {
  onOpenProjects?: () => void;
  onProjectChanged?: () => void;
}

export function RecentProjectsCard({
  onOpenProjects,
  onProjectChanged,
}: RecentProjectsCardProps) {
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const r = await invoke<ProjectInfo[]>("list_projects");
        if (!cancelled) setProjects(r);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const recent = (projects ?? [])
    .slice()
    .sort((a, b) => {
      const at = a.last_active ?? "";
      const bt = b.last_active ?? "";
      return at < bt ? 1 : at > bt ? -1 : 0;
    })
    .slice(0, 5);

  async function openInIde(id: string) {
    setBusy(id);
    try {
      await invoke("open_project_in_ide", { id });
      onProjectChanged?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function openAi(p: ProjectInfo) {
    if (!p.path) return;
    setBusy(p.id);
    try {
      await invoke("spawn_session", {
        cwd: p.path,
        prompt: null,
        flags: { dangerouslySkipPermissions: true },
      });
      onProjectChanged?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card
      title={`Recent projects (${recent.length})`}
      loading={loading}
      error={error}
      empty={!loading && recent.length === 0 ? "No projects yet." : null}
      action={
        <SmallButton onClick={onOpenProjects} title="Open Projects tab">
          open
        </SmallButton>
      }
    >
      <ul className="space-y-1.5">
        {recent.map((p) => (
          <li
            key={p.id}
            className="flex items-center gap-2 text-[11.5px]"
            style={{ minHeight: 24 }}
          >
            <span
              className="flex-1 truncate"
              style={{ color: "var(--color-text)" }}
              title={p.path ?? p.id}
            >
              {p.name ?? p.id}
            </span>
            <span
              className="shrink-0 tabular-nums"
              style={{
                color: "var(--color-text-faint)",
                fontFamily: "var(--font-mono, ui-monospace)",
                fontSize: 10,
              }}
            >
              {relativeTime(p.last_active)}
            </span>
            <SmallButton
              onClick={() => void openInIde(p.id)}
              disabled={busy === p.id}
              title="Open in preferred IDE"
            >
              ide
            </SmallButton>
            <SmallButton
              variant="accent"
              onClick={() => void openAi(p)}
              disabled={busy === p.id || !p.path}
              title="Spawn Claude Code session"
            >
              ai
            </SmallButton>
          </li>
        ))}
      </ul>
    </Card>
  );
}
