import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Plans tab — read/write PLANS.json. Kanban (Open / In progress / Blocked /
// Resolved) + create/edit/delete + clean-resolved bulk + "Open resolution
// session" per card that spawns Claude in the ULTRON cwd with the plan
// context preseeded as the first prompt.

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

const PRIORITY_OPTIONS = ["p0", "p1", "p2", "p3", "p4"];
const KIND_OPTIONS = ["task", "sprint", "patch", "bug", "research", "audit"];

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
  onEdit,
  onDelete,
  onOpenSession,
}: {
  item: PlanItem;
  onMove: (target: string) => void;
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onOpenSession: () => void;
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
        <div className="mt-2 space-y-1.5">
          <div className="flex flex-wrap gap-1">
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
                {c.label.toLowerCase()}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              onClick={onOpenSession}
              className="rounded px-2 py-0.5 text-[10.5px] font-medium transition-colors"
              style={{
                background: "var(--color-accent)",
                color: "var(--color-accent-text)",
              }}
              title="Abre una sesión Claude en ULTRON con este plan como prompt inicial"
            >
              Open session
            </button>
            <button
              type="button"
              onClick={onEdit}
              className="rounded px-2 py-0.5 text-[10.5px] transition-colors"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-text-secondary)",
                border: "1px solid var(--color-border)",
              }}
            >
              Edit
            </button>
            <button
              type="button"
              onClick={onDelete}
              className="rounded px-2 py-0.5 text-[10.5px] transition-colors"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-danger)",
                border: "1px solid rgba(248, 81, 73, 0.32)",
              }}
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

type PlanFormState = {
  id: string | null;
  title: string;
  priority: string;
  kind: string;
  description: string;
  tags: string;
};

const EMPTY_FORM: PlanFormState = {
  id: null,
  title: "",
  priority: "p3",
  kind: "task",
  description: "",
  tags: "",
};

function PlanModal({
  state,
  busy,
  error,
  onChange,
  onSubmit,
  onClose,
}: {
  state: PlanFormState;
  busy: boolean;
  error: string | null;
  onChange: (next: PlanFormState) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-6"
      style={{ background: "rgba(0,0,0,0.55)" }}
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-[560px] flex-col overflow-hidden rounded"
        style={{
          background: "var(--color-surface-1)",
          border: "1px solid var(--color-border-strong)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <header
          className="flex items-center justify-between border-b px-5 py-3"
          style={{ borderColor: "var(--color-border)" }}
        >
          <h2 className="text-[14px] font-semibold">
            {state.id ? `Edit plan: ${state.id}` : "New plan"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-0.5 text-[12px]"
            style={{ color: "var(--color-text-tertiary)" }}
            aria-label="Close"
          >
            close
          </button>
        </header>
        <div className="flex-1 space-y-3 overflow-auto px-5 py-4">
          <div>
            <label
              className="mb-1 block text-[10px] font-medium uppercase tracking-wide"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Title
            </label>
            <input
              type="text"
              value={state.title}
              onChange={(e) => onChange({ ...state, title: e.target.value })}
              placeholder="Short, imperative title"
              className="w-full rounded px-2.5 py-1.5 text-[12.5px]"
              style={{
                background: "var(--color-surface-2)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
                outline: "none",
              }}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label
                className="mb-1 block text-[10px] font-medium uppercase tracking-wide"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                Priority
              </label>
              <select
                value={state.priority}
                onChange={(e) => onChange({ ...state, priority: e.target.value })}
                className="w-full rounded px-2 py-1.5 text-[12.5px]"
                style={{
                  background: "var(--color-surface-2)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border-strong)",
                }}
              >
                {PRIORITY_OPTIONS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                className="mb-1 block text-[10px] font-medium uppercase tracking-wide"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                Kind
              </label>
              <select
                value={state.kind}
                onChange={(e) => onChange({ ...state, kind: e.target.value })}
                className="w-full rounded px-2 py-1.5 text-[12.5px]"
                style={{
                  background: "var(--color-surface-2)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border-strong)",
                }}
              >
                {KIND_OPTIONS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label
              className="mb-1 block text-[10px] font-medium uppercase tracking-wide"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Tags (comma-separated)
            </label>
            <input
              type="text"
              value={state.tags}
              onChange={(e) => onChange({ ...state, tags: e.target.value })}
              placeholder="release, refactor, infra"
              className="w-full rounded px-2.5 py-1.5 text-[12.5px]"
              style={{
                background: "var(--color-surface-2)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
                outline: "none",
              }}
            />
          </div>
          <div>
            <label
              className="mb-1 block text-[10px] font-medium uppercase tracking-wide"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Description
            </label>
            <textarea
              value={state.description}
              onChange={(e) => onChange({ ...state, description: e.target.value })}
              spellCheck={false}
              className="w-full rounded p-2.5 text-[12px] leading-relaxed"
              style={{
                fontFamily: "var(--font-mono)",
                background: "var(--color-surface-2)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
                outline: "none",
                minHeight: 160,
                resize: "vertical",
              }}
            />
          </div>
          {error && (
            <div
              className="rounded p-2 text-[11.5px]"
              style={{
                background: "rgba(248, 81, 73, 0.06)",
                border: "1px solid rgba(248, 81, 73, 0.22)",
                color: "var(--color-danger)",
              }}
            >
              {error}
            </div>
          )}
        </div>
        <footer
          className="flex items-center justify-end gap-2 border-t px-5 py-3"
          style={{ borderColor: "var(--color-border)" }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded px-3 py-1.5 text-[12px]"
            style={{
              background: "transparent",
              color: "var(--color-text-tertiary)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={busy || !state.title.trim()}
            className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-40"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            {busy ? "Saving..." : state.id ? "Save" : "Create"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: string | number }) {
  return (
    <div
      className="rounded p-2.5"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div
        className="text-[9.5px] font-medium uppercase tracking-[0.06em]"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        {label}
      </div>
      <div
        className="mt-0.5 text-[15px] font-semibold tabular-nums leading-tight"
        style={{ color: "var(--color-text)" }}
      >
        {value}
      </div>
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
  const [modalState, setModalState] = useState<PlanFormState | null>(null);
  const [modalBusy, setModalBusy] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PlanItem | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [pendingClean, setPendingClean] = useState(false);
  const [cleanBusy, setCleanBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);

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

  async function submitPlan() {
    if (!modalState) return;
    setModalBusy(true);
    setModalError(null);
    try {
      const tagList = modalState.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      if (modalState.id) {
        await invoke("update_plan", {
          id: modalState.id,
          title: modalState.title.trim() || null,
          priority: modalState.priority,
          kind: modalState.kind,
          description: modalState.description,
          tags: tagList,
        });
      } else {
        await invoke("add_plan", {
          title: modalState.title.trim(),
          priority: modalState.priority,
          status: "open",
          kind: modalState.kind,
          description: modalState.description,
          tags: tagList,
        });
      }
      setModalState(null);
      await load();
    } catch (e) {
      setModalError(String(e));
    } finally {
      setModalBusy(false);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleteBusy(true);
    try {
      await invoke("delete_plan", { id: pendingDelete.id });
      setPendingDelete(null);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setDeleteBusy(false);
    }
  }

  async function cleanResolved() {
    setCleanBusy(true);
    try {
      const n = (await invoke("clean_resolved_plans")) as number;
      setInfo(`Removed ${n} resolved plan${n === 1 ? "" : "s"}.`);
      window.setTimeout(() => setInfo(null), 3000);
      setPendingClean(false);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setCleanBusy(false);
    }
  }

  async function openResolutionSession(plan: PlanItem) {
    const prompt = [
      `Plan ID: ${plan.id}`,
      `Title: ${plan.title}`,
      `Status: ${plan.status}`,
      `Priority: ${plan.priority}`,
      plan.description ? `\nDescription:\n${plan.description}` : "",
      "\nQuiero trabajar en este plan. Lee primero el spec si existe en plans/specs/, después propon el plan de ejecución dividido en tareas pequeñas y empieza por la primera.",
    ].join("\n");
    try {
      await invoke("spawn_session", {
        provider: "claude",
        prompt,
        cwd: null, // ULTRON cwd (current)
        flags: { dangerouslySkipPermissions: false },
      });
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
      const key = COLUMNS.some((c) => c.key === it.status) ? it.status : "open";
      m[key].push(it);
    }
    for (const k of Object.keys(m)) {
      m[k].sort(
        (a, b) =>
          priorityWeight(a.priority) - priorityWeight(b.priority) ||
          a.id.localeCompare(b.id),
      );
    }
    return m;
  }, [filtered]);

  const stats = useMemo(() => {
    if (!report) return { total: 0, byStatus: {} as Record<string, number>, byPriority: {} as Record<string, number> };
    const byStatus: Record<string, number> = {};
    const byPriority: Record<string, number> = {};
    for (const it of report.items) {
      byStatus[it.status] = (byStatus[it.status] ?? 0) + 1;
      byPriority[it.priority] = (byPriority[it.priority] ?? 0) + 1;
    }
    return { total: report.items.length, byStatus, byPriority };
  }, [report]);

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

  function startNew() {
    setModalError(null);
    setModalState({ ...EMPTY_FORM });
  }
  function startEdit(p: PlanItem) {
    setModalError(null);
    setModalState({
      id: p.id,
      title: p.title,
      priority: p.priority || "p3",
      kind: p.kind || "task",
      description: p.description ?? "",
      tags: p.tags.join(", "),
    });
  }

  const resolvedCount = stats.byStatus["resolved"] ?? 0;

  return (
    <div className="flex h-full flex-col overflow-hidden px-8 py-6">
      <header className="mb-4 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-semibold leading-tight">Plans</h1>
          <p
            className="mt-1 text-[13px]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            ~/.ultron/plans/PLANS.json - {stats.total} items - updated {report?.updated_at?.slice(0, 19) ?? "-"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPendingClean(true)}
            disabled={resolvedCount === 0}
            className="rounded px-3 py-1.5 text-[12px] transition-colors disabled:opacity-40"
            style={{
              background: "transparent",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border-strong)",
            }}
            title="Drop all resolved plans (atomic; backed by tmp+rename)"
          >
            Clean resolved ({resolvedCount})
          </button>
          <button
            type="button"
            onClick={startNew}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            New plan
          </button>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="rounded px-3 py-1.5 text-[12px] transition-colors disabled:opacity-50"
            style={{
              background: "transparent",
              color: "var(--color-text-tertiary)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>
      </header>

      {/* Stats strip */}
      <div className="mb-3 grid grid-cols-6 gap-2 md:grid-cols-8">
        <StatBox label="Total" value={stats.total} />
        {COLUMNS.map((c) => (
          <StatBox key={c.key} label={c.label} value={stats.byStatus[c.key] ?? 0} />
        ))}
        {PRIORITY_OPTIONS.slice(0, 3).map((p) => (
          <StatBox
            key={p}
            label={`Priority ${p}`}
            value={stats.byPriority[p] ?? 0}
          />
        ))}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar id, titulo, tag o descripcion..."
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

      {info && (
        <div
          className="mb-3 rounded p-2 text-[12px]"
          style={{
            background: "rgba(63, 185, 80, 0.08)",
            border: "1px solid rgba(63, 185, 80, 0.22)",
            color: "var(--color-success)",
          }}
        >
          {info}
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
                  onEdit={() => startEdit(it)}
                  onDelete={() => setPendingDelete(it)}
                  onOpenSession={() => openResolutionSession(it)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {modalState && (
        <PlanModal
          state={modalState}
          busy={modalBusy}
          error={modalError}
          onChange={setModalState}
          onSubmit={submitPlan}
          onClose={() => setModalState(null)}
        />
      )}

      {pendingDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-6"
          style={{ background: "rgba(0,0,0,0.55)" }}
          onClick={() => !deleteBusy && setPendingDelete(null)}
        >
          <div
            className="w-full max-w-[420px] rounded p-5"
            style={{
              background: "var(--color-surface-1)",
              border: "1px solid var(--color-border-strong)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-[14px] font-semibold">Delete plan</h3>
            <p
              className="mt-2 text-[12.5px] leading-relaxed"
              style={{ color: "var(--color-text-secondary)" }}
            >
              Drop <b>{pendingDelete.title || pendingDelete.id}</b> from
              PLANS.json? El cambio es atómico (tmp+rename). El spec en
              disco no se toca.
            </p>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                disabled={deleteBusy}
                className="rounded px-3 py-1.5 text-[12px]"
                style={{
                  background: "transparent",
                  color: "var(--color-text-tertiary)",
                  border: "1px solid var(--color-border-strong)",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={deleteBusy}
                className="rounded px-3 py-1.5 text-[12px] font-medium"
                style={{
                  background: "var(--color-danger)",
                  color: "#fff",
                }}
              >
                {deleteBusy ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingClean && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-6"
          style={{ background: "rgba(0,0,0,0.55)" }}
          onClick={() => !cleanBusy && setPendingClean(false)}
        >
          <div
            className="w-full max-w-[440px] rounded p-5"
            style={{
              background: "var(--color-surface-1)",
              border: "1px solid var(--color-border-strong)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-[14px] font-semibold">Clean resolved</h3>
            <p
              className="mt-2 text-[12.5px] leading-relaxed"
              style={{ color: "var(--color-text-secondary)" }}
            >
              Drop los {resolvedCount} planes con status="resolved" de
              PLANS.json. El cambio es atómico y reescribe el archivo.
              Para recuperarlos despues hace falta historico (no lo
              guardamos automatico — usa git si lo necesitas).
            </p>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingClean(false)}
                disabled={cleanBusy}
                className="rounded px-3 py-1.5 text-[12px]"
                style={{
                  background: "transparent",
                  color: "var(--color-text-tertiary)",
                  border: "1px solid var(--color-border-strong)",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={cleanResolved}
                disabled={cleanBusy}
                className="rounded px-3 py-1.5 text-[12px] font-medium"
                style={{
                  background: "var(--color-danger)",
                  color: "#fff",
                }}
              >
                {cleanBusy ? "Cleaning..." : `Drop ${resolvedCount}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
