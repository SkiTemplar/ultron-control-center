// Pending cards for the most-recent project. We pick the project with the
// freshest `last_active` as the "active project" stand-in — the Projects tab
// itself owns the canonical selection and we don't share state with it.
//
// v2.7 redesign: bigger card, 13px content baseline, room for 5 items + a
// done-count footer so the user gets a real sense of inbox load.
// 2026-10-18: filas de dos líneas (título + columna), ordenadas por urgencia
// de la columna, y «+N más» cuando hay más de las que caben.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Column, ColumnRole, KanbanBoard, ProjectInfo } from "../../types";
import { Card, SmallButton } from "./Card";

interface PendingKanbanCardProps {
  onOpenProjects?: () => void;
}

interface PendingItem {
  id: string;
  title: string;
  /** Nombre de la columna tal como viene en los datos del tablero. */
  columnName: string;
  role: ColumnRole;
}

interface PendingState {
  projectName: string;
  pending: PendingItem[];
  totalPending: number;
  doneCount: number;
}

/** Tarjetas visibles en el panel; el resto se resume en «+N más». */
const MAX_VISIBLE = 5;

// Lo que está en curso o bloqueado pide atención antes que el backlog.
const ROLE_RANK: Record<ColumnRole, number> = {
  doing: 0,
  blocked: 1,
  todo: 2,
  other: 3,
  done: 4,
};

const ROLE_COLOR: Record<ColumnRole, string> = {
  doing: "var(--color-accent)",
  blocked: "var(--color-danger)",
  todo: "var(--color-text-tertiary)",
  other: "var(--color-text-tertiary)",
  done: "var(--color-success)",
};

function isDoneColumn(c: Column): boolean {
  return c.role === "done" || /done|complete|archiv|hech|termin/i.test(c.name);
}

/** Tarjetas pendientes del tablero, ordenadas por urgencia de su columna. */
export function pendingItems(board: KanbanBoard): PendingItem[] {
  const columns = new Map(board.columns.map((c) => [c.id, c]));
  return board.cards
    .filter((card) => {
      const col = columns.get(card.column_id);
      return !col || !isDoneColumn(col);
    })
    .map((card) => {
      const col = columns.get(card.column_id);
      const role: ColumnRole = col?.role ?? "other";
      return {
        item: { id: card.id, title: card.title, columnName: col?.name ?? "", role },
        rank: ROLE_RANK[role],
        colOrder: col?.order ?? Number.MAX_SAFE_INTEGER,
        order: card.order,
      };
    })
    .sort((a, b) => a.rank - b.rank || a.colOrder - b.colOrder || a.order - b.order)
    .map((entry) => entry.item);
}

export function PendingKanbanCard({ onOpenProjects }: PendingKanbanCardProps) {
  const [state, setState] = useState<PendingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const projects = await invoke<ProjectInfo[]>("list_projects");
        const sorted = projects
          .slice()
          .sort((a, b) => {
            const at = a.last_active ?? "";
            const bt = b.last_active ?? "";
            return at < bt ? 1 : at > bt ? -1 : 0;
          });
        const active = sorted[0];
        if (!active) {
          if (!cancelled) setState(null);
          return;
        }
        const board = await invoke<KanbanBoard>("kanban_load", {
          projectId: active.id,
        });
        const allPending = pendingItems(board);
        if (!cancelled) {
          setState({
            projectName: active.name ?? active.id,
            pending: allPending.slice(0, MAX_VISIBLE),
            totalPending: allPending.length,
            doneCount: board.cards.length - allPending.length,
          });
        }
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

  const hidden = state ? state.totalPending - state.pending.length : 0;

  return (
    <Card
      title="Pendientes"
      subtitle={state ? state.projectName : undefined}
      loading={loading}
      error={error}
      empty={
        !loading && !error && !state
          ? "No hay ningún proyecto activo."
          : !loading && state && state.pending.length === 0
            ? "Nada pendiente."
            : null
      }
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
      {state && state.pending.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-baseline gap-3">
            <span
              className="text-[20px] font-semibold leading-none tabular-nums"
              style={{ color: "var(--color-text)" }}
            >
              {state.totalPending}
            </span>
            <span
              className="text-[12.5px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {state.totalPending === 1 ? "tarjeta pendiente" : "tarjetas pendientes"}
            </span>
            {state.doneCount > 0 && (
              <span
                className="ml-auto tabular-nums text-[11px]"
                style={{ color: "var(--color-text-faint)" }}
              >
                {state.doneCount} hecha{state.doneCount === 1 ? "" : "s"}
              </span>
            )}
          </div>
          {/* Dos líneas por tarjeta (título + columna), como «Proyectos
              recientes»: con una sola línea la tarjeta dejaba media altura
              vacía junto a sus vecinas de fila. */}
          <ul className="space-y-1">
            {state.pending.map((c) => (
              <li
                key={c.id}
                className="flex items-start gap-2 rounded px-2 py-1.5"
                style={{ background: "var(--color-surface-3)" }}
                title={c.title}
              >
                <span
                  className="mt-[7px] inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: ROLE_COLOR[c.role] }}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px]" style={{ color: "var(--color-text)" }}>
                    {c.title}
                  </div>
                  {c.columnName && (
                    <div
                      className="truncate text-[11.5px]"
                      style={{ color: "var(--color-text-tertiary)" }}
                    >
                      {c.columnName}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {hidden > 0 && (
            <button
              type="button"
              onClick={onOpenProjects}
              className="text-[11.5px] underline-offset-2 hover:underline"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              +{hidden} más en el tablero
            </button>
          )}
        </div>
      )}
    </Card>
  );
}
