// Top 3-5 most recently active projects. v2.5.1 simplified: dropped the
// per-row IDE+AI quick buttons (USER wanted a single Open action that
// navigates to the Projects tab; per-project actions live there).

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectInfo } from "../../types";
import { Card, SmallButton, relativeTime } from "./Card";

interface RecentProjectsCardProps {
  onOpenProjects?: () => void;
}

export function RecentProjectsCard({ onOpenProjects }: RecentProjectsCardProps) {
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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
            className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-[11.5px] hover:bg-[var(--color-surface-3)]"
            style={{ minHeight: 24 }}
            onClick={() => onOpenProjects?.()}
            title={`Open ${p.name ?? p.id} in Projects tab`}
          >
            <span
              className="flex-1 truncate"
              style={{ color: "var(--color-text)" }}
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
          </li>
        ))}
      </ul>
    </Card>
  );
}
