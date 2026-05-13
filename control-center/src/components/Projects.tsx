import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectActionResult, ProjectInfo } from "../types";

// ---------------------------------------------------------------------------
// Status styling
// ---------------------------------------------------------------------------

type StatusKey = "active" | "auto-detected" | "manual" | "archived" | string;

function statusBadge(s: string | null): { color: string; bg: string; label: string } {
  switch (s) {
    case "active":
      return {
        color: "var(--color-success)",
        bg: "rgba(63, 185, 80, 0.08)",
        label: "active",
      };
    case "auto-detected":
      return {
        color: "var(--color-text-secondary)",
        bg: "var(--color-surface-3)",
        label: "auto",
      };
    case "manual":
      return {
        color: "var(--color-warn)",
        bg: "rgba(210, 153, 34, 0.08)",
        label: "manual",
      };
    case "archived":
      return {
        color: "var(--color-text-tertiary)",
        bg: "var(--color-surface-2)",
        label: "archived",
      };
    default:
      return {
        color: "var(--color-text-tertiary)",
        bg: "var(--color-surface-2)",
        label: s ?? "—",
      };
  }
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function Row({
  p,
  selected,
  onClick,
  onOpen,
  opening,
}: {
  p: ProjectInfo;
  selected: boolean;
  onClick: () => void;
  onOpen: () => void;
  opening: boolean;
}) {
  const b = statusBadge(p.status);
  return (
    <div
      className="flex items-baseline gap-3 rounded p-3 transition-colors"
      style={{
        background: selected ? "var(--color-surface-3)" : "var(--color-surface-2)",
        border: `1px solid ${selected ? "var(--color-border-strong)" : "var(--color-border)"}`,
      }}
    >
      <button
        type="button"
        onClick={onClick}
        className="min-w-0 flex-1 text-left"
      >
        <div className="flex items-baseline gap-2">
          <span
            className="rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide"
            style={{ background: b.bg, color: b.color, minWidth: 56, textAlign: "center" }}
          >
            {b.label}
          </span>
          <span className="text-[13px] font-medium" style={{ color: "var(--color-text)" }}>
            {p.name ?? p.id}
          </span>
          {p.ide && (
            <span
              className="text-[11px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {p.ide}
            </span>
          )}
          {p.language && (
            <span
              className="text-[11px]"
              style={{ color: "var(--color-text-faint)" }}
            >
              · {p.language}
            </span>
          )}
        </div>
        {p.path && (
          <div
            className="mt-1 truncate text-[10.5px]"
            style={{
              fontFamily: "var(--font-mono)",
              color: "var(--color-text-tertiary)",
            }}
            title={p.path}
          >
            {p.path}
          </div>
        )}
        {p.tags.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {p.tags.slice(0, 5).map((t) => (
              <span
                key={t}
                className="rounded px-1 py-px text-[9.5px]"
                style={{
                  background: "var(--color-surface-1)",
                  color: "var(--color-text-tertiary)",
                  border: "1px solid var(--color-border)",
                }}
              >
                {t}
              </span>
            ))}
          </div>
        )}
      </button>
      <div className="flex flex-col items-end gap-1">
        {p.last_active && (
          <span
            className="text-[10.5px] tabular-nums"
            style={{ color: "var(--color-text-faint)" }}
          >
            {p.last_active}
          </span>
        )}
        <button
          type="button"
          onClick={onOpen}
          disabled={opening || !p.path}
          className="rounded px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-40"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
          title={p.path ? `Open ${p.id} in ${p.ide ?? "default IDE"}` : "No path on file"}
        >
          {opening ? "Opening…" : "Open"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter pill
// ---------------------------------------------------------------------------

function Pill({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded px-2.5 py-1 text-[11px] transition-colors"
      style={{
        background: active ? "var(--color-surface-3)" : "transparent",
        color: active ? "var(--color-text)" : "var(--color-text-tertiary)",
        border: `1px solid ${active ? "var(--color-border-strong)" : "var(--color-border)"}`,
      }}
    >
      <span>{label}</span>
      <span
        className="tabular-nums"
        style={{ color: active ? "var(--color-text-secondary)" : "var(--color-text-faint)" }}
      >
        {count}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function Projects() {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilters, setStatusFilters] = useState<Set<StatusKey>>(
    () => new Set<StatusKey>(),
  ); // empty = all
  const [selected, setSelected] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [lastAction, setLastAction] = useState<ProjectActionResult | null>(null);

  async function load() {
    setLoading(true);
    try {
      const r = (await invoke("list_projects")) as ProjectInfo[];
      setProjects(r);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function scan() {
    setScanning(true);
    setError(null);
    try {
      const r = (await invoke("scan_projects")) as ProjectInfo[];
      setProjects(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  }

  async function open(id: string) {
    setOpening(id);
    setLastAction(null);
    try {
      const r = (await invoke("open_project", { id })) as ProjectActionResult;
      setLastAction(r);
    } catch (e) {
      setLastAction({
        success: false,
        stdout: "",
        stderr: String(e),
        exit_code: null,
      });
    } finally {
      setOpening(null);
    }
  }

  useEffect(() => {
    load();
  }, []);

  // Status counts for filter pills
  const statusCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const p of projects) {
      const key = p.status ?? "—";
      c[key] = (c[key] ?? 0) + 1;
    }
    return c;
  }, [projects]);

  const statusKeys = useMemo(
    () =>
      Object.keys(statusCounts).sort((a, b) =>
        statusCounts[b] - statusCounts[a] !== 0
          ? statusCounts[b] - statusCounts[a]
          : a.localeCompare(b),
      ),
    [statusCounts],
  );

  // Filtered + searched
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return projects
      .filter((p) => {
        if (statusFilters.size === 0) return true;
        return statusFilters.has(p.status ?? "—");
      })
      .filter((p) => {
        if (!q) return true;
        const hay = [
          p.id,
          p.name ?? "",
          p.path ?? "",
          p.ide ?? "",
          p.language ?? "",
          ...(p.tags ?? []),
        ]
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      });
  }, [projects, statusFilters, query]);

  function toggleStatus(s: StatusKey) {
    const next = new Set(statusFilters);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    setStatusFilters(next);
  }

  return (
    <div className="px-10 py-8">
      <header className="mb-5 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-semibold leading-tight">Projects</h1>
          <p className="mt-1 text-[13px]" style={{ color: "var(--color-text-secondary)" }}>
            {projects.length} registered · {filtered.length} shown
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={scan}
            disabled={scanning}
            className="rounded px-3 py-1.5 text-[12px] transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
            }}
            title="Re-scan filesystem for projects (ultron scan)"
          >
            {scanning ? "Scanning…" : "Rescan"}
          </button>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="rounded px-3 py-1.5 text-[12px] transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            {loading ? "Loading…" : "Reload"}
          </button>
        </div>
      </header>

      {error && (
        <div
          className="mb-4 rounded p-3 text-[12.5px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {/* Search + filters */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          type="text"
          placeholder="Search id, name, path, ide, language, tag…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="flex-1 rounded px-3 py-1.5 text-[12.5px]"
          style={{
            background: "var(--color-surface-2)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
            outline: "none",
            minWidth: 280,
          }}
        />
      </div>

      {statusKeys.length > 1 && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          <span
            className="text-[10px] font-medium uppercase tracking-[0.06em]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Status
          </span>
          {statusKeys.map((s) => (
            <Pill
              key={s}
              label={s}
              count={statusCounts[s]}
              active={statusFilters.has(s)}
              onClick={() => toggleStatus(s)}
            />
          ))}
          {statusFilters.size > 0 && (
            <button
              type="button"
              onClick={() => setStatusFilters(new Set())}
              className="text-[10px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              clear
            </button>
          )}
        </div>
      )}

      {lastAction && !lastAction.success && (
        <div
          className="mb-4 rounded p-3 text-[12px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          Open failed: {lastAction.stderr || lastAction.stdout || `exit ${lastAction.exit_code}`}
        </div>
      )}

      {loading && projects.length === 0 && (
        <div className="text-[12.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          Loading…
        </div>
      )}

      {!loading && filtered.length === 0 && projects.length > 0 && (
        <div
          className="rounded p-6 text-center text-[13px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-secondary)",
          }}
        >
          No projects match the current filters.
        </div>
      )}

      <div className="space-y-2">
        {filtered.map((p) => (
          <Row
            key={p.id}
            p={p}
            selected={selected === p.id}
            onClick={() => setSelected(p.id)}
            onOpen={() => open(p.id)}
            opening={opening === p.id}
          />
        ))}
      </div>
    </div>
  );
}
