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
  { key: "revision", label: "Revision", tint: "#a875ff" },
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
  const [aiOpen, setAiOpen] = useState(false);
  const [aiGoal, setAiGoal] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiPreview, setAiPreview] = useState<string | null>(null);

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

  // AI brainstorm: send the goal to Codex, parse the structured response
  // and bulk-add plans. We use Codex (not Claude) by default to conserve
  // Claude tokens for interactive sessions.
  // Spawn a Claude session targeted at one of four plan workflows.
  // cwd = ~/.ultron/instructions/plans/ so Claude auto-reads the GUIDE.md
  // and knows the schema, status names, atomic-write rules, etc. — saves
  // a re-discovery pass each turn.
  async function spawnClaudePlanFlow(
    kind: "execute" | "review" | "add" | "resolve",
  ) {
    setError(null);
    try {
      const instrPath = (await invoke("instruction_path", {
        kind: "plans",
      })) as string;
      const promptByKind: Record<typeof kind, string> = {
        execute:
          "Claude, ejecuta lo que tenemos pendiente en PLANS.json. Lee primero el GUIDE.md de esta carpeta y los items con status=open en orden de priority (p0→p4). Para cada uno: márcalo in_progress con patch_plan_status, propon plan de ejecución corto, y si lo terminas, márcalo resolved o revision según corresponda.",
        review:
          "Claude, revisa los planes con status=revision (y los open p0/p1 si no hay revision). Verifica que todavía sean accionables, sigan vigentes, y que el spec_path exista. Sugiere mover a wontfix los que dejaron de tener sentido. Resume hallazgos antes de tocar nada.",
        add:
          "Claude, voy a darte un goal en lenguaje natural. Crea 1-5 planes accionables vía add_plan siguiendo el GUIDE.md (priority p0-p4, kind apropiado, tags útiles, description 1-2 párrafos). Si necesitas más contexto del repo, lee ~/.ultron/MEMORY.md primero. Goal: <ESCRIBE-AQUÍ>",
        resolve:
          "Claude, ayúdame a resolver el plan que tenga in_progress (o el primero open p0/p1). Lee su description + spec_path si existe, ejecuta los pasos, y cuando termines márcalo resolved. Si te bloquea algo, márcalo blocked con una nota explicando.",
      };
      await invoke("spawn_session", {
        provider: "claude",
        prompt: promptByKind[kind],
        cwd: instrPath,
        flags: { dangerouslySkipPermissions: false },
      });
      setInfo(`Claude session abierta (${kind}). Continúa en wt.exe.`);
      window.setTimeout(() => setInfo(null), 3500);
    } catch (e) {
      setError(String(e));
    }
  }

  async function aiBrainstorm() {
    const goal = aiGoal.trim();
    if (!goal) return;
    setAiBusy(true);
    setAiError(null);
    setAiPreview(null);
    try {
      const sys = [
        "Eres un planificador. Devuelve EXCLUSIVAMENTE un array JSON con planes accionables.",
        "Cada item: { title (imperativo, <80 chars), priority ('p1'|'p2'|'p3'), kind ('task'|'sprint'|'patch'|'bug'|'research'), description (1-2 parrafos), tags (array de strings cortos) }.",
        "No prefijos, no markdown fences, no texto extra. Si el goal es vago, propon 3-5 planes que lo cubran de mayor a menor prioridad.",
      ].join("\n");
      const prompt = `${sys}\n\nGoal del usuario:\n${goal}`;
      const r = (await invoke("run_inline", {
        provider: "codex",
        model: null,
        prompt,
      })) as { success: boolean; stdout: string; stderr: string };
      if (!r.success) {
        setAiError(r.stderr || "Codex falló");
        return;
      }
      // Strip optional ```json fences.
      const raw = r.stdout.trim();
      const fenced = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
      const candidate = fenced ? fenced[1].trim() : raw;
      let parsed: unknown;
      try {
        parsed = JSON.parse(candidate);
      } catch {
        setAiError("Codex no devolvió JSON parseable. Respuesta:\n" + raw.slice(0, 800));
        return;
      }
      if (!Array.isArray(parsed)) {
        setAiError("Respuesta no es un array JSON.");
        return;
      }
      setAiPreview(JSON.stringify(parsed, null, 2));
      let added = 0;
      for (const item of parsed as Array<Record<string, unknown>>) {
        try {
          await invoke("add_plan", {
            title: String(item.title ?? ""),
            priority: (item.priority as string) || "p3",
            status: "open",
            kind: (item.kind as string) || "task",
            description: (item.description as string) || "",
            tags: Array.isArray(item.tags)
              ? (item.tags as string[]).filter(Boolean)
              : null,
          });
          added += 1;
        } catch (e) {
          setAiError(`add_plan falló en item "${item.title}": ${String(e)}`);
        }
      }
      setInfo(`AI brainstorm añadió ${added} plan${added === 1 ? "" : "es"}.`);
      window.setTimeout(() => setInfo(null), 4000);
      setAiOpen(false);
      setAiGoal("");
      await load();
    } catch (e) {
      setAiError(String(e));
    } finally {
      setAiBusy(false);
    }
  }

  async function cleanResolved() {
    setCleanBusy(true);
    try {
      const n = (await invoke("clean_resolved_plans")) as number;
      setInfo(`Archived ${n} resolved plan${n === 1 ? "" : "s"} to plans/_archive/.`);
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
    const validStatuses = new Set(COLUMNS.map((c) => c.key));
    for (const it of report.items) {
      // Match the kanban column-bucket logic so the stat cards agree with the columns
      const bucket = validStatuses.has(it.status) ? it.status : "open";
      byStatus[bucket] = (byStatus[bucket] ?? 0) + 1;
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
            title="Mueve resolved a plans/_archive (no destructivo; atómico)"
          >
            Archive resolved ({resolvedCount})
          </button>
          {/* Claude-driven plan workflows — each opens a wt.exe Claude
              session at instructions/plans/ so the model already knows the
              schema + validators. */}
          <div
            className="flex items-center overflow-hidden rounded text-[11.5px]"
            style={{ border: "1px solid var(--color-border-strong)" }}
          >
            {([
              { k: "execute", label: "Claude execute" },
              { k: "review", label: "Claude review" },
              { k: "add", label: "Claude add" },
              { k: "resolve", label: "Claude resolve" },
            ] as const).map((b) => (
              <button
                key={b.k}
                type="button"
                onClick={() => spawnClaudePlanFlow(b.k)}
                className="px-2.5 py-1.5 transition-colors"
                style={{
                  background: "transparent",
                  color: "var(--color-text-secondary)",
                  borderLeft:
                    b.k === "execute"
                      ? "none"
                      : "1px solid var(--color-border-strong)",
                }}
                title={`Spawn Claude session en instructions/plans con prompt para ${b.k}`}
              >
                {b.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setAiOpen(true)}
            className="rounded px-3 py-1.5 text-[12px] font-semibold transition-colors"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
            title="Pide a Codex que genere planes desde un goal en lenguaje natural (cheaper que Claude)"
          >
            AI Brainstorm
          </button>
          <button
            type="button"
            onClick={startNew}
            className="rounded px-3 py-1.5 text-[12px] transition-colors"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
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

      {aiOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-6"
          style={{ background: "rgba(0,0,0,0.55)" }}
          onClick={() => !aiBusy && setAiOpen(false)}
        >
          <div
            className="w-full max-w-[600px] rounded p-5"
            style={{
              background: "var(--color-surface-1)",
              border: "1px solid var(--color-border-strong)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-[14px] font-semibold">AI Brainstorm</h3>
            <p
              className="mt-1 text-[11.5px] leading-relaxed"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Codex genera planes accionables desde un goal. Cada plan vuelve
              con title / priority / kind / description / tags y se inserta
              vía add_plan. Usa Codex (no Claude) para no quemar tokens
              interactivos.
            </p>
            <textarea
              value={aiGoal}
              onChange={(e) => setAiGoal(e.target.value)}
              placeholder="Ej: Quiero refactorizar el sistema de memoria para que cargue lazy y use Qdrant native, sin perder compatibilidad con FTS5."
              spellCheck={false}
              className="mt-3 w-full rounded p-2.5 text-[12px] leading-relaxed"
              style={{
                fontFamily: "var(--font-mono)",
                background: "var(--color-surface-2)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
                outline: "none",
                minHeight: 120,
                resize: "vertical",
              }}
            />
            {aiError && (
              <div
                className="mt-2 rounded p-2 text-[11.5px]"
                style={{
                  background: "rgba(248, 81, 73, 0.06)",
                  border: "1px solid rgba(248, 81, 73, 0.22)",
                  color: "var(--color-danger)",
                  whiteSpace: "pre-wrap",
                }}
              >
                {aiError}
              </div>
            )}
            {aiPreview && !aiError && (
              <pre
                className="mt-2 max-h-48 overflow-auto rounded p-2 text-[10.5px]"
                style={{
                  background: "var(--color-surface-2)",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text-secondary)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {aiPreview}
              </pre>
            )}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setAiOpen(false)}
                disabled={aiBusy}
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
                onClick={aiBrainstorm}
                disabled={aiBusy || !aiGoal.trim()}
                className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-40"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-accent-text)",
                }}
              >
                {aiBusy ? "Codex pensando..." : "Brainstorm"}
              </button>
            </div>
          </div>
        </div>
      )}

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
            <h3 className="text-[14px] font-semibold">Archive resolved</h3>
            <p
              className="mt-2 text-[12.5px] leading-relaxed"
              style={{ color: "var(--color-text-secondary)" }}
            >
              Mueve los {resolvedCount} planes con status="resolved" a
              plans/_archive/resolved-YYYY-MM.json y los quita de PLANS.json.
              Se conservan en disco — no se borran. Atómico (tmp+rename).
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
                {cleanBusy ? "Archiving..." : `Archive ${resolvedCount}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
