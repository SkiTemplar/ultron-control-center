import { useEffect, useState } from "react";
import { Plus } from "../icons";
import { useDroppableColumn } from "../../../hooks/useKanbanDnd";
import { columnAccent } from "./utils";
import type { SplitBacklogProps } from "./types";
import { BoardCard } from "./BoardCard";
import { ScrollableCardList } from "./ScrollableCardList";

export function SplitBacklogColumn({
  backlogColumnId,
  investigarColumnId,
  backlogCards,
  investigarCards,
  investigarColumnExists,
  onDropCard,
  onAddCard,
  onEditCard,
  onDeleteCard,
  onRename,
  backlogName,
}: SplitBacklogProps) {
  // Two drop zones — one per sub-section. Each routes to onDropCard with the
  // appropriate target column id.
  const backlogDrop = useDroppableColumn(
    backlogColumnId,
    ({ payload, beforeCardId }) =>
      onDropCard(payload.card_id, beforeCardId, backlogColumnId, false),
  );
  const investigarDrop = useDroppableColumn(
    investigarColumnId,
    ({ payload, beforeCardId }) =>
      onDropCard(payload.card_id, beforeCardId, investigarColumnId, true),
  );
  const accent = columnAccent(backlogName);
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(backlogName);
  useEffect(() => {
    if (!editingName) setDraftName(backlogName);
  }, [backlogName, editingName]);

  const totalCards = backlogCards.length + investigarCards.length;
  // Sin tarjetas de investigación la columna solo tiene la sección por
  // defecto: su subtítulo repetiría la cabecera («BACKLOG 4» dos veces), así
  // que no se pinta y el botón «Añadir» sube a la cabecera de la columna.
  const showBacklogSubtitle = investigarCards.length > 0;

  return (
    <div
      className={[
        "flex h-full min-w-[280px] flex-1 shrink-0 flex-col rounded-md border bg-[var(--color-surface-1)] transition-colors",
        backlogDrop.hover || investigarDrop.hover
          ? "border-[var(--color-accent)] bg-[var(--color-surface-2)]"
          : "border-[var(--color-border)]",
      ].join(" ")}
    >
      {/* Header — same look as a regular column but the badge shows total
          count across both sub-sections. */}
      <div className="relative flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2 text-xs">
        <span className="flex items-center gap-1.5 font-semibold uppercase tracking-wide">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: accent }}
          />
          {editingName ? (
            <input
              autoFocus
              type="text"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={() => {
                setEditingName(false);
                if (draftName.trim() && draftName.trim() !== backlogName) {
                  onRename(draftName);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  setEditingName(false);
                  if (draftName.trim() && draftName.trim() !== backlogName) {
                    onRename(draftName);
                  }
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setDraftName(backlogName);
                  setEditingName(false);
                }
              }}
              className="rounded border border-[var(--color-accent)] bg-[var(--color-surface-1)] px-1 py-0 text-xs font-semibold uppercase tracking-wide"
              style={{ minWidth: 80, width: `${Math.max(draftName.length + 1, 6)}ch` }}
            />
          ) : (
            <span
              onDoubleClick={() => setEditingName(true)}
              title="Doble clic para renombrar; la subsección Investigar va fusionada en esta columna"
              className="cursor-text"
            >
              {backlogName}
            </span>
          )}
          <span className="ml-1 rounded bg-[var(--color-surface-2)] px-1.5 py-px text-[10px] font-medium tabular-nums normal-case tracking-normal text-[var(--color-text-muted)]">
            {totalCards}
          </span>
        </span>
        {!showBacklogSubtitle && (
          <button
            onClick={() => onAddCard(false)}
            className="flex items-center gap-1 rounded px-2 py-1 text-[11.5px] font-medium text-[var(--color-text-muted)] hover:bg-[var(--color-accent)]/10 hover:text-[var(--color-accent)]"
            aria-label={`Añadir tarjeta a ${backlogName}`}
            title={`Añadir tarjeta a ${backlogName}`}
          >
            <Plus size={12} />
            Añadir
          </button>
        )}
      </div>
      {/* Two sub-sections sharing the column body. Backlog takes the free
          height; Investigar shrinks to its header + a compact placeholder when
          empty and is capped at 40 % when it has cards. Each list scrolls on
          its own and announces the cards left below the fold. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Backlog sub-section */}
        <div
          {...backlogDrop.columnDropProps}
          className={[
            "flex min-h-0 flex-1 flex-col overflow-hidden transition-colors",
            backlogDrop.hover ? "bg-[var(--color-surface-2)]" : "",
          ].join(" ")}
        >
          {showBacklogSubtitle && (
            <div className="flex items-center justify-between border-b border-dashed border-[var(--color-border)] px-2 py-1 text-[10px] uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
              <span className="flex items-center gap-1.5">
                <span aria-hidden>{backlogName}</span>
                <span className="rounded bg-[var(--color-surface-2)] px-1 py-px tabular-nums normal-case tracking-normal">
                  {backlogCards.length}
                </span>
              </span>
              <button
                onClick={() => onAddCard(false)}
                className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-[var(--color-text-muted)] hover:bg-[var(--color-accent)]/10 hover:text-[var(--color-accent)]"
                title={`Añadir tarjeta a ${backlogName}`}
              >
                <Plus size={10} />
                Añadir
              </button>
            </div>
          )}
          <ScrollableCardList itemCount={backlogCards.length}>
            {backlogCards.length === 0 ? (
              <button
                onClick={() => onAddCard(false)}
                className="block w-full rounded border border-dashed border-[var(--color-border)] px-3 py-3 text-center text-[11px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
              >
                <Plus size={11} className="mr-1 inline-block align-text-bottom" />
                Añadir tarjeta
              </button>
            ) : (
              backlogCards.map((card) => (
                <BoardCard
                  key={card.id}
                  card={card}
                  dropProps={backlogDrop.cardDropProps(card.id)}
                  onEdit={() => onEditCard(card)}
                  onDelete={() => onDeleteCard(card.id)}
                />
              ))
            )}
          </ScrollableCardList>
        </div>
        {/* Investigar sub-section */}
        <div
          {...investigarDrop.columnDropProps}
          className={[
            "flex flex-col overflow-hidden border-t border-[var(--color-border-strong)] transition-colors",
            investigarCards.length === 0 ? "flex-none" : "max-h-[40%] min-h-0 shrink-0",
            investigarDrop.hover ? "bg-[var(--color-surface-2)]" : "",
          ].join(" ")}
        >
          <div className="flex items-center justify-between border-b border-dashed border-[var(--color-border)] bg-[var(--color-surface-0)] px-2 py-1 text-[10px] uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
            <span className="flex items-center gap-1.5">
              <span aria-hidden>Investigar</span>
              <span
                className="rounded bg-[var(--color-surface-2)] px-1 py-px tabular-nums normal-case tracking-normal"
                title={
                  investigarColumnExists
                    ? "Tarjetas de la columna Investigar, fusionada visualmente con Backlog"
                    : "Tarjetas de Backlog con la etiqueta `investigar` o `research`"
                }
              >
                {investigarCards.length}
              </span>
            </span>
            <button
              onClick={() => onAddCard(true)}
              className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-[var(--color-text-muted)] hover:bg-[var(--color-accent)]/10 hover:text-[var(--color-accent)]"
              title={
                investigarColumnExists
                  ? "Añadir tarjeta a la columna Investigar"
                  : "Añadir tarjeta con la etiqueta `investigar`"
              }
            >
              <Plus size={10} />
              Añadir
            </button>
          </div>
          {investigarCards.length === 0 ? (
            <div className="p-1.5">
              <button
                onClick={() => onAddCard(true)}
                className="block w-full rounded border border-dashed border-[var(--color-border)] px-3 py-1.5 text-center text-[11px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
              >
                <Plus size={11} className="mr-1 inline-block align-text-bottom" />
                Añadir tarjeta de investigación
              </button>
            </div>
          ) : (
            <ScrollableCardList itemCount={investigarCards.length}>
              {investigarCards.map((card) => (
                <BoardCard
                  key={card.id}
                  card={card}
                  dropProps={investigarDrop.cardDropProps(card.id)}
                  onEdit={() => onEditCard(card)}
                  onDelete={() => onDeleteCard(card.id)}
                />
              ))}
            </ScrollableCardList>
          )}
        </div>
      </div>
    </div>
  );
}
