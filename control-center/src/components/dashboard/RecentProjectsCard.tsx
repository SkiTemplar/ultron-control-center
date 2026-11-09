// Top 5 most recently active projects.
//
// v2.7 redesign: bigger typography, 5 rows, hover affordance, path preview
// when available. A row opens that project's workspace (not just the
// Projects list); the header button opens the list.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectInfo } from "../../types";
import { Card, SmallButton, relativeTime } from "./Card";

interface RecentProjectsCardProps {
  onOpenProjects?: () => void;
  /** Abre el espacio de trabajo de ese proyecto. Sin él, la fila abre la lista. */
  onOpenProject?: (project: { id: string; name: string }) => void;
}

export function RecentProjectsCard({ onOpenProjects, onOpenProject }: RecentProjectsCardProps) {
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

  function openRow(p: ProjectInfo) {
    if (onOpenProject) onOpenProject({ id: p.id, name: p.name ?? p.id });
    else onOpenProjects?.();
  }

  return (
    <Card
      title="Proyectos recientes"
      subtitle={`Los ${recent.length} últimos con actividad`}
      loading={loading}
      error={error}
      empty={!loading && recent.length === 0 ? "Aún no hay proyectos." : null}
      action={
        <SmallButton
          onClick={onOpenProjects}
          size="md"
          title="Abrir la pestaña Proyectos"
        >
          Abrir
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
              role="button"
              tabIndex={0}
              onClick={() => openRow(p)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  openRow(p);
                }
              }}
              title={onOpenProject ? `Abrir ${p.name ?? p.id}` : `Abrir ${p.name ?? p.id} en la pestaña Proyectos`}
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
