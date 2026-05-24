// Top 5 most recently active projects.
//
// v2.7 redesign: bigger typography, 5 rows, hover affordance, path preview
// when available, navigates into the Projects tab on click.

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
      title="Recent projects"
      subtitle={`Last ${recent.length} active`}
      loading={loading}
      error={error}
      empty={!loading && recent.length === 0 ? "No projects yet." : null}
      action={
        <SmallButton
          onClick={onOpenProjects}
          size="md"
          title="Open Projects tab"
        >
          Open
        </SmallButton>
      }
    >
      <ul className="space-y-1">
        {recent.map((p) => {
          const path = p.path;
          return (
            <li
              key={p.id}
              className="flex cursor-pointer items-center gap-3 rounded px-2 py-1.5 transition-colors hover:bg-[var(--color-surface-3)]"
              onClick={() => onOpenProjects?.()}
              title={`Open ${p.name ?? p.id} in Projects tab`}
            >
              <div className="min-w-0 flex-1">
                <div
                  className="truncate text-[13px] font-medium"
                  style={{ color: "var(--color-text)" }}
                >
                  {p.name ?? p.id}
                </div>
                {path && (
                  <div
                    className="truncate text-[11.5px]"
                    style={{
                      color: "var(--color-text-tertiary)",
                      fontFamily: "var(--font-mono, ui-monospace)",
                    }}
                    title={path}
                  >
                    {path}
                  </div>
                )}
              </div>
              <span
                className="shrink-0 tabular-nums text-[11px]"
                style={{ color: "var(--color-text-faint)" }}
              >
                {relativeTime(p.last_active)}
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
