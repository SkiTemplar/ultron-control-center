// ULTRON Control Center 2.0 — Project Kanban board
//
// Loads the per-project KanbanBoard, renders columns + cards, supports HTML5
// drag-and-drop between columns with optimistic UI + rollback on backend
// failure. Card click opens CardEditorModal.
//
// Visual pass (first redesign): tighter cards, better hover, column accent,
// friendlier empty state. DnD wiring untouched.

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Bot, Plus } from "./icons";
import { useDraggableCard, useDroppableColumn } from "../../hooks/useKanbanDnd";
import type { Card, KanbanBoard } from "../../types";
import CardEditorModal from "./CardEditorModal";

type Props = { projectId: string };

export default function ProjectBoard({ projectId }: Props) {
  const [board, setBoard] = useState<KanbanBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<
    | { mode: "create"; columnId: string }
    | { mode: "edit"; card: Card }
    | null
  >(null);

  const load = useCallback(async () => {
    try {
      const b = (await invoke("kanban_load", { projectId })) as KanbanBoard;
      setBoard(b);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const moveCard = useCallback(
    async (cardId: string, targetColumnId: string, order: number) => {
      const snapshot = board;
      if (board) {
        setBoard({
          ...board,
          cards: board.cards.map((c) =>
            c.id === cardId ? { ...c, column_id: targetColumnId, order } : c,
          ),
        });
      }
      try {
        const next = (await invoke("kanban_move_card", {
          projectId,
          cardId,
          targetColumnId,
          order,
        })) as KanbanBoard;
        setBoard(next);
      } catch (e) {
        setError(String(e));
        if (snapshot) setBoard(snapshot);
      }
    },
    [board, projectId],
  );

  const deleteCard = useCallback(
    async (cardId: string) => {
      try {
        await invoke("kanban_delete_card", { projectId, cardId });
        await load();
      } catch (e) {
        setError(String(e));
      }
    },
    [load, projectId],
  );

  if (error && !board) {
    return (
      <div className="p-4 text-xs text-[var(--color-error)]">
        Failed to load board: {error}
      </div>
    );
  }
  if (!board) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-[var(--color-text-muted)]">
        Loading…
      </div>
    );
  }

  return (
    <>
      {/* v2.x: lightweight breadcrumb so it's clear this kanban is scoped to
          the project — distinct from the global Plans tab (which lives at
          ~/.ultron/plans/PLANS.json). The Plans tab now holds cross-project
          personal items only. */}
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-1.5 border-b border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 py-1 text-[10.5px] uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
          <span>Project</span>
          <span className="text-[var(--color-text-faint)]">/</span>
          <span className="text-[var(--color-text-secondary)]">Board</span>
        </div>
        <div className="flex flex-1 gap-3 overflow-x-auto p-3">
        {[...board.columns]
          .sort((a, b) => a.order - b.order)
          .map((col) => (
            <BoardColumn
              key={col.id}
              columnId={col.id}
              name={col.name}
              cards={board.cards
                .filter((c) => c.column_id === col.id)
                .sort((a, b) => a.order - b.order)}
              onDropCard={(cardId, beforeCardId) => {
                const inCol = board.cards
                  .filter((c) => c.column_id === col.id)
                  .sort((a, b) => a.order - b.order);
                let order: number;
                if (!beforeCardId) {
                  order = inCol.length;
                } else {
                  const idx = inCol.findIndex((c) => c.id === beforeCardId);
                  order = idx === -1 ? inCol.length : idx;
                }
                void moveCard(cardId, col.id, order);
              }}
              onAddCard={() => setEditing({ mode: "create", columnId: col.id })}
              onEditCard={(card) => setEditing({ mode: "edit", card })}
              onDeleteCard={(cardId) => void deleteCard(cardId)}
              onDispatchPrompt={(prompt) =>
                void dispatchOrchestratorPrompt(
                  projectId,
                  col.name,
                  prompt,
                  board.cards
                    .filter((c) => c.column_id === col.id)
                    .map((c) => c.title),
                )
              }
            />
          ))}
        </div>
      </div>
      {editing && (
        <CardEditorModal
          projectId={projectId}
          board={board}
          {...(editing.mode === "create"
            ? { mode: "create" as const, columnId: editing.columnId, card: null }
            : {
                mode: "edit" as const,
                columnId: editing.card.column_id,
                card: editing.card,
              })}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
      {error && board && (
        <div className="absolute right-2 bottom-2 rounded-md border border-[var(--color-error)] bg-[var(--color-surface-2)] px-2 py-1 text-xs text-[var(--color-error)]">
          {error}
        </div>
      )}
    </>
  );
}

type ColumnProps = {
  columnId: string;
  name: string;
  cards: Card[];
  onDropCard: (cardId: string, beforeCardId: string | null) => void;
  onAddCard: () => void;
  onEditCard: (card: Card) => void;
  onDeleteCard: (cardId: string) => void;
  onDispatchPrompt: (prompt: string) => void;
};

/** Per-column orchestrator presets — each entry maps a column name (matched
 *  case-insensitive substring) to a list of named prompts. The button on the
 *  column header opens a popover with these and dispatches the chosen prompt
 *  as a Claude PTY session preseeded with the column context. */
type ColumnPreset = { label: string; prompt: string };

function presetsForColumn(name: string): ColumnPreset[] {
  const n = name.toLowerCase();
  if (n.includes("backlog") || n.includes("todo") || n.includes("to do")) {
    return [
      {
        label: "Brainstorm new cards",
        prompt: `You are looking at the BACKLOG of this project. Propose 3-5 new tasks that would belong here, based on the project layout and the cards already present. Format each as a card title plus 1-line description.`,
      },
      {
        label: "Prioritise backlog",
        prompt: `Review the BACKLOG and rank the cards by priority (P0 critical, P1 high, P2 medium, P3 nice-to-have). Briefly justify each ranking.`,
      },
    ];
  }
  if (n.includes("open") || n.includes("ready")) {
    return [
      {
        label: "Pick next",
        prompt: `Look at the OPEN column. Pick the single highest-value card to start RIGHT NOW. State which one and why, then outline the first three concrete steps.`,
      },
    ];
  }
  if (n.includes("progress") || n.includes("doing")) {
    return [
      {
        label: "Resume work",
        prompt: `These cards are IN PROGRESS. Pick the one most likely to be unblocked quickly, summarise where it left off, and continue the implementation.`,
      },
      {
        label: "Status check",
        prompt: `For each IN PROGRESS card, summarise current status in one line and flag anything blocked.`,
      },
    ];
  }
  if (n.includes("review")) {
    return [
      {
        label: "Review cards",
        prompt: `Each of these cards is awaiting REVIEW. For each one, identify what needs to be verified, suggest a quick QA plan, and call out any obvious gaps.`,
      },
    ];
  }
  if (n.includes("done") || n.includes("complete")) {
    return [
      {
        label: "Summarise wins",
        prompt: `Write a one-line victory summary for each DONE card. Frame it as a changelog line.`,
      },
    ];
  }
  if (n.includes("block")) {
    return [
      {
        label: "Diagnose blockers",
        prompt: `These cards are BLOCKED. For each one, list the suspected blocker, who/what could unblock it, and a fallback path.`,
      },
    ];
  }
  return [
    {
      label: "Discuss this column",
      prompt: `Discuss the cards currently in this column. What pattern do you see? What would you do next?`,
    },
  ];
}

/** Spawn a Claude PTY pre-seeded with the column context. We invoke
 *  `pty_spawn` directly so the session opens in the project's Terminal tab
 *  (the user can flip to it manually). Prompt is currently not auto-pasted —
 *  the wrapper script's clipboard route is the safer fallback — but the
 *  column name + card titles are baked into the prompt so context is clear. */
async function dispatchOrchestratorPrompt(
  projectId: string,
  columnName: string,
  prompt: string,
  cardTitles: string[],
): Promise<void> {
  const titlesBlock =
    cardTitles.length > 0
      ? cardTitles.map((t) => `  - ${t}`).join("\n")
      : "  (no cards in this column)";
  const fullPrompt = `[Kanban orchestrator — column: ${columnName}]\n\nCards currently in "${columnName}":\n${titlesBlock}\n\nTask: ${prompt}\n`;
  try {
    await invoke("pty_spawn", {
      projectId,
      cardId: null,
      provider: "claude",
      agent: null,
      cwd: ".",
      prompt: fullPrompt,
    });
  } catch (e) {
    console.error("dispatchOrchestratorPrompt failed", e);
  }
}

/** Lookup an accent colour per well-known column name. Falls back to muted. */
function columnAccent(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("backlog") || n.includes("todo") || n.includes("to do"))
    return "#6e7681";
  if (n.includes("progress") || n.includes("doing")) return "#58a6ff";
  if (n.includes("review")) return "#d29922";
  if (n.includes("done") || n.includes("complete")) return "#3fb950";
  if (n.includes("block")) return "#f85149";
  return "var(--color-accent)";
}

function BoardColumn({
  columnId,
  name,
  cards,
  onDropCard,
  onAddCard,
  onEditCard,
  onDeleteCard,
  onDispatchPrompt,
}: ColumnProps) {
  const { columnDropProps, cardDropProps, hover } = useDroppableColumn(
    columnId,
    ({ payload, beforeCardId }) => onDropCard(payload.card_id, beforeCardId),
  );
  const accent = columnAccent(name);
  const [menuOpen, setMenuOpen] = useState(false);
  const presets = useMemo(() => presetsForColumn(name), [name]);

  return (
    <div
      {...columnDropProps}
      className={[
        // v2.x: min-w-[280px] + flex-1 so columns absorb the right-side
        // dead space the user complained about, while still horizontal-
        // scrolling on narrow viewports.
        "flex h-full min-w-[280px] flex-1 shrink-0 flex-col rounded-md border bg-[var(--color-surface-1)] transition-colors",
        hover
          ? "border-[var(--color-accent)] bg-[var(--color-surface-2)]"
          : "border-[var(--color-border)]",
      ].join(" ")}
    >
      <div className="relative flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2 text-xs">
        <span className="flex items-center gap-1.5 font-semibold uppercase tracking-wide">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: accent }}
          />
          {name}
          <span className="ml-1 rounded bg-[var(--color-surface-2)] px-1.5 py-px text-[10px] font-medium tabular-nums normal-case tracking-normal text-[var(--color-text-muted)]">
            {cards.length}
          </span>
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-accent)]"
            aria-label="Dispatch AI on this column"
            title="Dispatch AI session with this column's context"
          >
            <Bot size={12} />
          </button>
          <button
            onClick={onAddCard}
            className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
            aria-label="Add card"
            title="Add card"
          >
            <Plus size={12} />
          </button>
        </div>
        {menuOpen && (
          <div
            className="absolute right-1 top-9 z-20 w-60 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] shadow-lg"
            onMouseLeave={() => setMenuOpen(false)}
          >
            <div className="border-b border-[var(--color-border)] px-3 py-1.5 text-[10.5px] uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
              Dispatch for {name}
            </div>
            {presets.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onDispatchPrompt(p.prompt);
                }}
                className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-accent)]"
                title={p.prompt}
              >
                {p.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex-1 space-y-1.5 overflow-y-auto p-2">
        {cards.length === 0 && (
          <button
            onClick={onAddCard}
            className="block w-full rounded border border-dashed border-[var(--color-border)] px-3 py-4 text-center text-[11px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
          >
            <Plus size={11} className="mr-1 inline-block align-text-bottom" />
            Add a card to {name.toLowerCase()}
          </button>
        )}
        {cards.map((card) => (
          <BoardCard
            key={card.id}
            card={card}
            dropProps={cardDropProps(card.id)}
            onEdit={() => onEditCard(card)}
            onDelete={() => onDeleteCard(card.id)}
          />
        ))}
      </div>
    </div>
  );
}

type CardProps = {
  card: Card;
  dropProps: {
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: () => void;
    onDrop: (e: React.DragEvent) => void;
  };
  onEdit: () => void;
  onDelete: () => void;
};

function BoardCard({ card, dropProps, onEdit, onDelete }: CardProps) {
  const { draggableProps, dragging } = useDraggableCard({
    card_id: card.id,
    source_column_id: card.column_id,
  });
  const liveRun = useMemo(
    () =>
      card.runs.length > 0 && card.runs[card.runs.length - 1].status.kind === "running",
    [card.runs],
  );
  const lastRun = card.runs.length > 0 ? card.runs[card.runs.length - 1] : null;

  return (
    <div
      {...draggableProps}
      {...dropProps}
      onClick={onEdit}
      className={[
        "group cursor-grab rounded-md border bg-[var(--color-surface-2)] p-2 text-xs shadow-sm transition-all active:cursor-grabbing",
        dragging ? "opacity-40" : "",
        "border-[var(--color-border)] hover:-translate-y-px hover:border-[var(--color-accent)] hover:shadow-md",
      ].join(" ")}
    >
      <div className="mb-1 flex items-start justify-between gap-2">
        <span className="line-clamp-2 text-[12px] font-medium leading-snug text-[var(--color-text)]">
          {card.title}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="rounded p-0.5 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-[var(--color-surface-0)] hover:text-[var(--color-error)] group-hover:opacity-100"
          aria-label="Delete card"
          title="Delete"
        >
          ×
        </button>
      </div>
      {card.description && (
        <p className="mb-1.5 line-clamp-2 text-[10.5px] leading-snug text-[var(--color-text-muted)]">
          {card.description}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
        {card.agent && (
          <span
            className="flex items-center gap-1 rounded bg-[var(--color-surface-0)] px-1.5 py-0.5 font-medium"
            title={`Agent: ${card.agent}`}
          >
            <Bot size={10} />
            {card.agent}
          </span>
        )}
        {liveRun ? (
          <span className="flex items-center gap-1 rounded bg-[var(--color-accent)]/10 px-1.5 py-0.5 font-medium text-[var(--color-accent)]">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-accent)]" />
            live
          </span>
        ) : lastRun ? (
          <span
            className="rounded px-1.5 py-0.5 font-medium"
            style={{
              background:
                lastRun.status.kind === "failed"
                  ? "rgba(248, 81, 73, 0.10)"
                  : "var(--color-surface-0)",
              color:
                lastRun.status.kind === "failed"
                  ? "var(--color-error)"
                  : "var(--color-text-muted)",
            }}
            title={`Last run: ${lastRun.status.kind}`}
          >
            {lastRun.status.kind}
          </span>
        ) : null}
        {card.tags.slice(0, 2).map((t) => (
          <span
            key={t}
            className="rounded bg-[var(--color-surface-0)] px-1.5 py-0.5"
          >
            {t}
          </span>
        ))}
        {card.tags.length > 2 && (
          <span className="text-[var(--color-text-muted)]">
            +{card.tags.length - 2}
          </span>
        )}
      </div>
    </div>
  );
}
