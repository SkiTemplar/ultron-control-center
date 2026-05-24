import {
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type ReactElement,
  useEffect,
  useMemo,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { useRoutingTitle } from "../lib/button-prompts";

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
  { key: "rejected", label: "Rejected", tint: "var(--color-text-tertiary)" },
];

// Bottom-row kanban lanes — exception / terminal states
// (revision / blocked / rejected). `merged` is intentionally NOT a column:
// merged plans shipped already, so they route to the "Archived" drawer
// (see `archivedItems`) where they stay findable without inflating the
// open/total counts on the board.
const BOTTOM_COLUMNS = ["revision", "blocked", "rejected"];

// Terminal statuses that drop off the kanban and surface in the "Archived"
// drawer instead. `archived` is the auto-archive target for stale resolved
// plans; `merged` is a plan that already shipped via merge.
const ARCHIVED_STATUSES = new Set(["archived", "merged"]);

const PRIORITY_OPTIONS = ["p0", "p1", "p2", "p3", "p4"];
const KIND_OPTIONS = ["task", "sprint", "patch", "bug", "feature", "refactor", "polish", "research", "audit"];

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
  onDragStart,
  onDragEnd,
  dragging,
}: {
  item: PlanItem;
  onMove: (target: string) => void;
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onOpenSession: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  dragging: boolean;
}) {
  const openSessionTitle = useRoutingTitle(
    "plans.resolve_one",
    "Open an AI session in ULTRON with this plan as the initial prompt.",
  );
  return (
    <div
      // Native HTML5 drag-and-drop: the whole card is the drag handle. The
      // payload (plan id) travels via dataTransfer, set in onDragStart.
      // Dropping onto a column calls `move(id, target)` — same path as the
      // expand+button flow, which stays in place (DnD is additive).
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", item.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className="rounded p-3 transition-colors"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
        cursor: "grab",
        opacity: dragging ? 0.45 : 1,
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
            style={{
              color: "var(--color-text)",
              overflowWrap: "anywhere",
              wordBreak: "break-word",
            }}
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
                title={`Move to ${c.label}`}
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
              title={openSessionTitle}
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

// v2.x slim: per-tab stats strip removed. The Plans tab is intentionally
// minimal — USER asked for the kanban board only, no rolled-up counts.
// The per-status counts that the UI still needs (resolvedCount for the
// archive button) are computed inline in <Plans />.

// Per-column action bar. Each kanban column owns 0..N buttons that only
// make sense for items in that lane. Centralising the switch here keeps
// the column-rendering JSX in <Plans /> readable.
function ColumnActions(props: {
  column: string;
  onNew: () => void;
  onSprintAi: () => void;
  sprintAiBusy: boolean;
  onExecute: () => void;
  onReview: () => void;
  onResolveBlock: () => void;
  onArchiveSelected: () => void;
  archiveDisabled: boolean;
  archiveCount: number;
}) {
  const baseBtn =
    "rounded px-2 py-1 text-[10.5px] font-medium transition-colors disabled:opacity-40";
  const accent: CSSProperties = {
    background: "var(--color-accent)",
    color: "var(--color-accent-text)",
  };
  const subtle: CSSProperties = {
    background: "var(--color-surface-3)",
    color: "var(--color-text-secondary)",
    border: "1px solid var(--color-border)",
  };

  // Routing destination per AI button — each catalog key resolves through
  // the AI Router so the user can see provider/model before clicking.
  const sprintTitle = useRoutingTitle(
    "plans.sprint_ai",
    "Generate an actionable sprint proposal from the current open plans and rewrite/improve the ones added by hand.",
  );
  const executeTitle = useRoutingTitle(
    "plans.execute",
    "Launch an AI session to execute the open plans in priority order.",
  );
  const reviewTitle = useRoutingTitle(
    "plans.review",
    "Launch an AI session for an adversarial review of the plans in revision.",
  );
  const resolveBlockTitle = useRoutingTitle(
    "plans.resolve_in_progress",
    "Launch an AI session to unblock the plan: reads description + spec, proposes an unstuck path.",
  );

  let buttons: ReactElement[] = [];
  switch (props.column) {
    case "open":
      buttons = [
        <button
          key="new"
          type="button"
          onClick={props.onNew}
          className={baseBtn}
          style={subtle}
          title="Create an empty plan manually (modal with title / priority / kind / tags / description)."
        >
          New Plan
        </button>,
        <button
          key="sprint"
          type="button"
          onClick={props.onSprintAi}
          disabled={props.sprintAiBusy}
          className={baseBtn}
          style={accent}
          title={sprintTitle}
        >
          {props.sprintAiBusy ? "Opening..." : "Sprint AI"}
        </button>,
      ];
      break;
    case "in_progress":
      buttons = [
        <button
          key="exec"
          type="button"
          onClick={props.onExecute}
          className={baseBtn}
          style={accent}
          title={executeTitle}
        >
          Execute
        </button>,
      ];
      break;
    case "revision":
      buttons = [
        <button
          key="review"
          type="button"
          onClick={props.onReview}
          className={baseBtn}
          style={accent}
          title={reviewTitle}
        >
          AI Review
        </button>,
      ];
      break;
    case "blocked":
      buttons = [
        <button
          key="resolve"
          type="button"
          onClick={props.onResolveBlock}
          className={baseBtn}
          style={subtle}
          title={resolveBlockTitle}
        >
          Resolve block
        </button>,
      ];
      break;
    case "resolved":
      buttons = [
        <button
          key="archive"
          type="button"
          onClick={props.onArchiveSelected}
          disabled={props.archiveDisabled}
          className={baseBtn}
          style={subtle}
          title="Move all resolved plans to plans/_archive/resolved-YYYY-MM.json (atomic, non-destructive)."
        >
          Archive selected ({props.archiveCount})
        </button>,
      ];
      break;
  }

  if (buttons.length === 0) return null;
  return (
    <div
      className="flex flex-wrap gap-1 border-b px-2 py-1.5"
      style={{ borderColor: "var(--color-border)" }}
    >
      {buttons}
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
  const [aiBusy, setAiBusy] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archivedDays, setArchivedDays] = useState<number>(30);
  // Drag-and-drop state for the kanban. `draggingId` is the plan being
  // dragged (used to dim its card); `dragOverColumn` is the lane currently
  // hovered (used to highlight the drop target). Both reset on drop/end.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);

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

  // Auto-archive resolved plans older than `archivedDays` days. Runs on
  // mount and every 5 minutes after. Backend flips status="resolved" →
  // "archived" in place (no file moves), so the kanban filter drops them
  // and the "Show archived" drawer surfaces them when the user wants.
  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const n = (await invoke("auto_archive_resolved_plans", {
          days: archivedDays,
        })) as number;
        if (alive && n > 0) {
          await load();
        }
      } catch {
        // Silent: stale/missing PLANS.json shouldn't spam the toast.
      }
    }
    tick();
    const id = window.setInterval(tick, 5 * 60 * 1000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [archivedDays]);

  async function move(id: string, target: string) {
    try {
      await invoke("patch_plan_status", { id, status: target });
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  // Drop handler for kanban columns. Reads the plan id from dataTransfer
  // and routes through `move` — the same `patch_plan_status` call the
  // expand+button flow uses. No-op if dropped on the card's own column.
  function handleColumnDrop(e: ReactDragEvent, target: string) {
    e.preventDefault();
    setDragOverColumn(null);
    setDraggingId(null);
    const id = e.dataTransfer.getData("text/plain");
    if (!id) return;
    const current = report?.items.find((it) => it.id === id);
    if (current && current.status === target) return;
    void move(id, target);
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
      // v15.3.5: prompt bodies migrated to the central button-prompts
      // catalog. Each header button maps 1:1 to a `plans.*` key so the
      // user can refine the prompts from Settings → Button prompts
      // without recompiling. The kind→key mapping mirrors the four flows.
      const keyByKind: Record<typeof kind, string> = {
        execute: "plans.execute",
        review: "plans.review",
        add: "plans.add_from_goal",
        resolve: "plans.resolve_in_progress",
      };
      const { getPrompt } = await import("../lib/button-prompts");
      const prompt = await getPrompt(keyByKind[kind]);
      await invoke("spawn_session", {
        provider: "claude",
        prompt,
        cwd: instrPath,
        flags: { dangerouslySkipPermissions: false },
      });
      setInfo(`Claude session opened (${kind}). Continue in wt.exe.`);
      window.setTimeout(() => setInfo(null), 3500);
    } catch (e) {
      setError(String(e));
    }
  }

  async function aiSprintPlan() {
    setAiBusy(true);
    setError(null);
    try {
      const opens = (report?.items ?? [])
        .filter((it) => it.status === "open")
        .sort((a, b) => a.priority.localeCompare(b.priority));
      const open_plans_block = opens
        .map((it) => {
          const effort = it.effort_hours ? ` (~${it.effort_hours[0]}-${it.effort_hours[1]}h)` : "";
          const desc = it.description ? `\n  ${it.description.slice(0, 150)}` : "";
          return `[${it.priority.toUpperCase()}] ${it.title}${effort}${desc}`;
        })
        .join("\n");
      const { resolveAndSpawn } = await import("../lib/button-prompts");
      const { resolved } = await resolveAndSpawn({
        key: "plans.sprint_ai",
        vars: { open_plans_block: open_plans_block || "(no open plans)" },
        cwd: null,
        extraFlags: { pasteOnly: true },
      });
      setInfo(
        `Sprint AI opened with ${resolved.entry.provider}. Prompt on the clipboard — paste with Ctrl+V and hit Enter.`,
      );
      window.setTimeout(() => setInfo(null), 5000);
    } catch (e) {
      setError(String(e));
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
    try {
      // v15.2.40: prompt body comes from the central catalog
      // (key "plans.resolve_one", zone "brainstorm_plans"). Vars include
      // every plan field the template might want to interpolate. Auto-
      // mode picks the right subagent via embed_agents.py query.
      const { resolveAndSpawn } = await import("../lib/button-prompts");
      await resolveAndSpawn({
        key: "plans.resolve_one",
        vars: {
          plan_id: plan.id,
          plan_title: plan.title,
          plan_status: plan.status,
          plan_priority: plan.priority,
          plan_description: plan.description ?? "",
        },
        cwd: null, // ULTRON cwd (current)
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
      .filter((it) => !ARCHIVED_STATUSES.has(it.status)) // kanban hides archived + merged (both in the drawer)
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

  const archivedItems = useMemo(() => {
    if (!report) return [] as PlanItem[];
    // The drawer holds terminal plans that left the kanban: `archived`
    // (stale resolved, auto-archived) and `merged` (shipped via merge).
    // Routing `merged` here keeps those items findable without letting
    // them inflate the open/total counts on the board.
    return report.items.filter((it) => ARCHIVED_STATUSES.has(it.status));
  }, [report]);

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

  // v2.x slim: previously a full `stats` memo (total, byStatus, byPriority)
  // fed the rolled-up stats strip. The strip is gone, but the "Archive
  // selected" button still needs to know how many cards live in the
  // `resolved` column. Compute just that — nothing else.
  const resolvedCount = useMemo(() => {
    if (!report) return 0;
    return report.items.filter(
      (it) => !ARCHIVED_STATUSES.has(it.status) && it.status === "resolved",
    ).length;
  }, [report]);
  const totalActive = useMemo(() => {
    if (!report) return 0;
    return report.items.filter((it) => !ARCHIVED_STATUSES.has(it.status)).length;
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

  return (
    <div className="flex h-full flex-col overflow-hidden px-8 py-6">
      <header className="mb-4 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-semibold leading-tight">Plans</h1>
          <p
            className="mt-1 text-[13px]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            ~/.ultron/plans/PLANS.json - {totalActive} items - updated {report?.updated_at?.slice(0, 19) ?? "-"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setArchivedOpen(true)}
            className="rounded px-3 py-1.5 text-[12px] transition-colors"
            style={{
              background: "transparent",
              color: "var(--color-text-tertiary)",
              border: "1px solid var(--color-border-strong)",
            }}
            title={`Show archived plans (resolved > ${archivedDays} days). Auto-archive runs every 5 min.`}
          >
            Show archived
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

      {/* v2.x slim: the rolled-up stats strip (total + priority counts +
          archived) has been removed at USER's request. The Plans tab is
          now intentionally focused on the kanban board itself. The archived
          drawer is still reachable via the "Show archived" button in the
          header. Per-column counts live in the column headers below. */}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by id, title, tag or description..."
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
            className="rounded px-2 py-1 text-[11.5px] transition-colors"
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

      {/* v15.5.18 (user request): 2-row layout. Top row = active states
          (open / in_progress / resolved). Bottom row = exception + terminal
          states (revision / blocked / rejected). Stops the horizontal scroll
          caused by long titles in `open` and gives the eye the natural
          reading order. `merged` plans live in the Archived drawer. */}
      <div className="flex flex-1 flex-col gap-3 overflow-hidden">
        <div className="grid flex-1 grid-cols-3 gap-3 overflow-hidden">
          {COLUMNS.filter((c) => ["open", "in_progress", "resolved"].includes(c.key)).map((c) => (
          <div
            key={c.key}
            className="flex flex-col overflow-hidden rounded transition-colors"
            style={{
              background: "var(--color-surface-1)",
              border: `1px solid ${
                dragOverColumn === c.key
                  ? "var(--color-accent)"
                  : "var(--color-border)"
              }`,
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
                className="tabular-nums text-[11.5px]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {grouped[c.key]?.length ?? 0}
              </span>
            </div>
            {/* Per-column action bar. Each column owns the buttons that
                only make sense for items in that lane, so the user
                doesn't have to mentally route "what does this button do
                with my selection?" — context is the column. */}
            <ColumnActions
              column={c.key}
              onNew={startNew}
              onSprintAi={aiSprintPlan}
              sprintAiBusy={aiBusy}
              onExecute={() => spawnClaudePlanFlow("execute")}
              onReview={() => spawnClaudePlanFlow("review")}
              onResolveBlock={() => spawnClaudePlanFlow("resolve")}
              onArchiveSelected={() => setPendingClean(true)}
              archiveDisabled={resolvedCount === 0}
              archiveCount={resolvedCount}
            />
            <div
              className="flex-1 space-y-2 overflow-auto p-2 transition-colors"
              style={{
                background:
                  dragOverColumn === c.key
                    ? "var(--color-surface-2)"
                    : "transparent",
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (dragOverColumn !== c.key) setDragOverColumn(c.key);
              }}
              onDragLeave={(e) => {
                // Only clear when the pointer actually leaves the lane, not
                // when it crosses a child card boundary.
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setDragOverColumn((prev) => (prev === c.key ? null : prev));
                }
              }}
              onDrop={(e) => handleColumnDrop(e, c.key)}
            >
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
                  dragging={draggingId === it.id}
                  onDragStart={() => setDraggingId(it.id)}
                  onDragEnd={() => {
                    setDraggingId(null);
                    setDragOverColumn(null);
                  }}
                />
              ))}
            </div>
          </div>
        ))}
        </div>
        {/* Bottom row — exception + terminal states
            (revision / blocked / rejected). grid-cols-3 mirrors the top
            row so the 3 lanes line up vertically with open / in_progress
            / resolved (was md:grid-cols-4, a leftover from when `merged`
            was a 4th column — it left a dead slot and broke alignment). */}
        <div className="grid grid-cols-3 gap-3 overflow-hidden" style={{ maxHeight: "45%" }}>
          {COLUMNS.filter((c) => BOTTOM_COLUMNS.includes(c.key)).map((c) => (
            <div
              key={c.key}
              className="flex flex-col overflow-hidden rounded transition-colors"
              style={{
                background: "var(--color-surface-1)",
                border: `1px solid ${
                  dragOverColumn === c.key
                    ? "var(--color-accent)"
                    : "var(--color-border)"
                }`,
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
                  className="tabular-nums text-[11.5px]"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  {grouped[c.key]?.length ?? 0}
                </span>
              </div>
              <ColumnActions
                column={c.key}
                onNew={startNew}
                onSprintAi={aiSprintPlan}
                sprintAiBusy={aiBusy}
                onExecute={() => spawnClaudePlanFlow("execute")}
                onReview={() => spawnClaudePlanFlow("review")}
                onResolveBlock={() => spawnClaudePlanFlow("resolve")}
                onArchiveSelected={() => setPendingClean(true)}
                archiveDisabled={resolvedCount === 0}
                archiveCount={resolvedCount}
              />
              <div
                className="flex-1 space-y-2 overflow-auto p-2 transition-colors"
                style={{
                  background:
                    dragOverColumn === c.key
                      ? "var(--color-surface-2)"
                      : "transparent",
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (dragOverColumn !== c.key) setDragOverColumn(c.key);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                    setDragOverColumn((prev) => (prev === c.key ? null : prev));
                  }
                }}
                onDrop={(e) => handleColumnDrop(e, c.key)}
              >
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
                    dragging={draggingId === it.id}
                    onDragStart={() => setDraggingId(it.id)}
                    onDragEnd={() => {
                      setDraggingId(null);
                      setDragOverColumn(null);
                    }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {archivedOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-end"
          style={{ background: "rgba(0,0,0,0.45)" }}
          onClick={() => setArchivedOpen(false)}
        >
          <div
            className="flex h-full w-full max-w-[520px] flex-col overflow-hidden"
            style={{
              background: "var(--color-surface-1)",
              borderLeft: "1px solid var(--color-border-strong)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <header
              className="flex items-center justify-between border-b px-5 py-3"
              style={{ borderColor: "var(--color-border)" }}
            >
              <div>
                <h3 className="text-[14px] font-semibold">Archived plans</h3>
                <p
                  className="mt-0.5 text-[11.5px]"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  Resolved more than {archivedDays} days ago — off the kanban
                  but still in PLANS.json ({archivedItems.length} items).
                </p>
              </div>
              <div className="flex items-center gap-2">
                <label
                  className="text-[10px] uppercase tracking-wide"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  Days
                </label>
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={archivedDays}
                  onChange={(e) =>
                    setArchivedDays(Math.max(1, Number(e.target.value) || 30))
                  }
                  className="w-16 rounded px-1.5 py-0.5 text-[12px]"
                  style={{
                    background: "var(--color-surface-2)",
                    color: "var(--color-text)",
                    border: "1px solid var(--color-border-strong)",
                  }}
                  title="Threshold in days for auto-archiving resolved plans (default 30, persists for the session only)."
                />
                <button
                  type="button"
                  onClick={() => setArchivedOpen(false)}
                  className="rounded px-2 py-0.5 text-[12px]"
                  style={{ color: "var(--color-text-tertiary)" }}
                  aria-label="Close"
                >
                  close
                </button>
              </div>
            </header>
            <div className="flex-1 space-y-2 overflow-auto p-3">
              {archivedItems.length === 0 && (
                <p
                  className="px-1 py-4 text-center text-[12px]"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  No archived plans yet.
                </p>
              )}
              {archivedItems.map((it) => (
                <div
                  key={it.id}
                  className="rounded p-2.5"
                  style={{
                    background: "var(--color-surface-2)",
                    border: "1px solid var(--color-border)",
                  }}
                >
                  <div className="flex items-start gap-2">
                    <PriorityBadge p={it.priority} />
                    <div className="min-w-0 flex-1">
                      <div
                        className="text-[12.5px] font-medium leading-tight"
                        style={{ color: "var(--color-text)" }}
                      >
                        {it.title || it.id}
                      </div>
                      <div
                        className="mt-0.5 text-[10.5px]"
                        style={{
                          fontFamily: "var(--font-mono)",
                          color: "var(--color-text-faint)",
                        }}
                      >
                        {it.id} · resolved {it.resolved_at?.slice(0, 10) ?? "?"}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => move(it.id, "resolved")}
                      className="rounded px-2 py-0.5 text-[10.5px]"
                      style={{
                        background: "var(--color-surface-3)",
                        color: "var(--color-text-secondary)",
                        border: "1px solid var(--color-border)",
                      }}
                      title="Return this plan to the kanban (status=resolved) so it shows up again."
                    >
                      Restore
                    </button>
                  </div>
                </div>
              ))}
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
              PLANS.json? The change is atomic (tmp+rename). The spec on
              disk is left untouched.
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
              Moves the {resolvedCount} plans with status="resolved" to
              plans/_archive/resolved-YYYY-MM.json and removes them from PLANS.json.
              They are kept on disk — not deleted. Atomic (tmp+rename).
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
