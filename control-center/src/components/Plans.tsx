import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Plans tab — lectura/edición ligera del PLANS.json oficial. Render como
// kanban (Open / In progress / Blocked / Resolved) con filtros por
// priority + tag-search. Cambios de status van por patch_plan_status
// (atomic write con tmp+rename en el backend).

type PlanItem = {
  id: string;
  title: string;
  kind: string;
  status: string;
  priority: string;
  description: string | null;
  tags: string[];
  spec_path: string | null;
  created_at: string | null;
  resolved_at: string | null;
  effort_hours: number[] | null;
};

type PlansReport = {
  items: PlanItem[];
  updated_at: string | null;
};

const COLUMNS: { key: string; label: string; tint: string }[] = [
  { key: "open", label: "Open", tint: "var(--color-text-secondary)" },
  { key: "in_progress", label: "In progress", tint: "var(--color-warn)" },
  { key: "blocked", label: "Blocked", tint: "var(--color-danger)" },
  { key: "resolved", label: "Resolved", tint: "var(--color-success)" },
];

function priorityWeight(p: string): number {
  const m = p.match(/p(\d+)/i);
  if (!m) return 99;
  return parseInt(m[1], 10);
}

function PriorityBadge({ p }: { p: string }) {
  if (!p) return null;
  const w = priorityWeight(p);
  const color =
    w <= 1
      ? "var(--color-danger)"
      : w === 2
        ? "var(--color-warn)"
        : "var(--color-text-tertiary)";
  return (
    <span
      className="rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide"
      style={{
        background: "var(--color-surface-3)",
        color,
        border: "1px solid var(--color-border)",
        minWidth: 28,
        textAlign: "center",
      }}
    >
      {p}
    </span>
  );
}

function PlanCard({
  item,
  onMove,
  expanded,
  onToggle,
}: {
  item: PlanItem;
  onMove: (target: string) => void;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className="rounded p-3 transition-colors"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div className="flex items-start gap-2">
        <PriorityBadge p={item.priority} />
        <button
          type="button"
          onClick={onToggle}
          className="min-w-0 flex-1 text-left"
        >
          <div
            className="text-[12.5px] font-medium leading-tight"
            style={{ color: "var(--color-text)" }}
          >
            {item.title || item.id}
          </div>
          <div
            className="mt-0.5 text-[10.5px]"
            style={{
              fontFamily: "var(--font-mono)",
              color: "var(--color-text-faint)",
            }}
          >
            {item.id}
          </div>
        </button>
      </div>
      {item.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {item.tags.slice(0, 6).map((t) => (
            <span
              key={t}
              className="rounded px-1 py-px text-[10px]"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-text-tertiary)",
              }}
            >
              {t}
            </span>
          ))}
        </div>
      )}
      {expanded && item.description && (
        <p
          className="mt-2 text-[11.5px] leading-relaxed"
          style={{ color: "var(--color-text-secondary)", whiteSpace: "pre-wrap" }}
        >
          {item.description}
        </p>
      )}
      {expanded && (
        <div className="mt-2 flex flex-wrap gap-1">
          {COLUMNS.filter((c) => c.key !== item.status).map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => onMove(c.key)}
              className="rounded px-2 py-0.5 text-[10.5px] transition-colors"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-text-secondary)",
                border: "1px solid var(--color-border)",
              }}
              title={`Mover a ${c.label}`}
            >
              → {c.label.toLowerCase()}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Plans() {
  const [report, setReport] = useState<PlansReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [priorityFilter, setPriorityFilter] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  async function load() {
    setLoading(true);
    try {
      const r = (await invoke("list_plans")) as PlansReport;
      setReport(r);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function move(id: string, target: string) {
    try {
      await invoke("patch_plan_status", { id, status: target });
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  function togglePriority(p: string) {
    const next = new Set(priorityFilter);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    setPriorityFilter(next);
  }

  const filtered = useMemo(() => {
    if (!report) return [];
    const q = query.trim().toLowerCase();
    return report.items
      .filter((it) => {
        if (priorityFilter.size === 0) return true;
        return priorityFilter.has(it.priority);
      })
      .filter((it) => {
        if (!q) return true;
        const hay = [
          it.id,
          it.title,
          it.description ?? "",
          ...it.tags,
        ]
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      });
  }, [report, query, priorityFilter]);

  const grouped = useMemo(() => {
    const m: Record<string, PlanItem[]> = {};
    for (const c of COLUMNS) m[c.key] = [];
    for (const it of filtered) {
      // Map "open" + "manual" + anything else not canonical into "open".
      const key = COLUMNS.some((c) => c.key === it.status) ? it.status : "open";
      m[key].push(it);
    }
    // Sort each column by priority asc, then id.
    for (const k of Object.keys(m)) {
      m[k].sort(
        (a, b) =>
          priorityWeight(a.priority) - priorityWeight(b.priority) ||
          a.id.localeCompare(b.id),
      );
    }
    return m;
  }, [filtered]);

  const priorityKeys = useMemo(() => {
    if (!report) return [] as string[];
    return Array.from(new Set(report.items.map((it) => it.priority).filter(Boolean))).sort();
  }, [report]);

  function toggleExpanded(id: string) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  }

  return (
    <div className="flex h-full flex-col overflow-hidden px-8 py-6">
      <header className="mb-4 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-semibold leading-tight">Plans</h1>
          <p
            className="mt-1 text-[13px]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            ~/.ultron/plans/PLANS.json · {report?.items.length ?? 0} ítems ·
            updated {report?.updated_at?.slice(0, 19) ?? "—"}
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="rounded px-3 py-1.5 text-[12px] transition-colors disabled:opacity-50"
          style={{
            background: "transparent",
            color: "var(--color-text-secondary)",
            border: "1px solid var(--color-border-strong)",
          }}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </header>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar id, título, tag o descripción…"
          className="rounded px-3 py-1.5 text-[12.5px]"
          style={{
            background: "var(--color-surface-2)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
            outline: "none",
            minWidth: 280,
          }}
        />
        {priorityKeys.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => togglePriority(p)}
            className="rounded px-2 py-1 text-[11px] transition-colors"
            style={{
              background: priorityFilter.has(p)
                ? "var(--color-surface-3)"
                : "transparent",
              color: priorityFilter.has(p)
                ? "var(--color-text)"
                : "var(--color-text-tertiary)",
              border: `1px solid ${
                priorityFilter.has(p)
                  ? "var(--color-border-strong)"
                  : "var(--color-border)"
              }`,
            }}
          >
            {p}
          </button>
        ))}
      </div>

      {error && (
        <div
          className="mb-3 rounded p-3 text-[12px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      <div className="grid flex-1 grid-cols-4 gap-3 overflow-hidden">
        {COLUMNS.map((c) => (
          <div
            key={c.key}
            className="flex flex-col overflow-hidden rounded"
            style={{
              background: "var(--color-surface-1)",
              border: "1px solid var(--color-border)",
            }}
          >
            <div
              className="flex items-baseline justify-between border-b px-3 py-2"
              style={{ borderColor: "var(--color-border)" }}
            >
              <div className="flex items-center gap-2">
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{ background: c.tint }}
                />
                <span
                  className="text-[11.5px] font-medium uppercase tracking-[0.06em]"
                  style={{ color: "var(--color-text-secondary)" }}
                >
                  {c.label}
                </span>
              </div>
              <span
                className="tabular-nums text-[11px]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {grouped[c.key]?.length ?? 0}
              </span>
            </div>
            <div className="flex-1 space-y-2 overflow-auto p-2">
              {(grouped[c.key] ?? []).map((it) => (
                <PlanCard
                  key={it.id}
                  item={it}
                  expanded={expanded.has(it.id)}
                  onToggle={() => toggleExpanded(it.id)}
                  onMove={(target) => move(it.id, target)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
