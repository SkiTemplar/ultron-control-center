// Selector de «+ Añadir proyecto» de la sección Portfolio: lista los proyectos
// registrados que aún no tienen tarjeta y deja añadir una idea sin proyecto.
// Crea la tarjeta con kanban_create_card (el backend escribe kanban.json) en la
// columna de rol `todo` del tablero.

import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CardPartial, KanbanBoard, ProjectInfo } from "../../types";
import { PORTFOLIO_PROJECT_ID, intakeColumn, projectDisplayName, projectsWithoutCard } from "./portfolioModel";

type Props = {
  board: KanbanBoard;
  projects: ProjectInfo[];
  onCreated: (message: string) => void;
};

function matchesQuery(p: ProjectInfo, q: string): boolean {
  if (!q) return true;
  return `${projectDisplayName(p)} ${p.id} ${p.path ?? ""}`.toLowerCase().includes(q);
}

export function AddProjectPicker({ board, projects, onCreated }: Props) {
  const [query, setQuery] = useState("");
  const [idea, setIdea] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const column = intakeColumn(board);
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return projectsWithoutCard(board, projects).filter((p) => matchesQuery(p, q));
  }, [board, projects, query]);

  const create = async (partial: CardPartial) => {
    if (!column) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("kanban_create_card", { projectId: PORTFOLIO_PROJECT_ID, columnId: column.id, partial });
      onCreated(`Tarjeta «${partial.title}» añadida a «${column.name}».`);
    } catch (e) {
      setError(`No se pudo añadir la tarjeta: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const addProject = (p: ProjectInfo) =>
    void create({ title: projectDisplayName(p), description: p.path ?? "", project: p.id });
  const addIdea = () => {
    const title = idea.trim();
    if (title) void create({ title, description: "", project: null });
  };

  if (!column) {
    return (
      <div role="alert" className="p-3 text-xs text-[var(--color-error)]">
        El tablero no tiene ninguna columna con rol «todo»: crea una (Columna → rol todo) para poder añadir tarjetas.
      </div>
    );
  }

  return (
    <div className="flex w-[360px] flex-col gap-2 p-3 text-xs">
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Buscar proyecto registrado…"
        aria-label="Buscar proyecto registrado"
        className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1"
      />
      <ul aria-label="Proyectos sin tarjeta" className="max-h-64 overflow-y-auto rounded-md border border-[var(--color-border)]">
        {candidates.length === 0 && (
          <li className="px-2 py-2 text-[var(--color-text-muted)]">
            {query.trim()
              ? "Ningún proyecto sin tarjeta coincide con la búsqueda."
              : "Todos los proyectos registrados ya tienen tarjeta."}
          </li>
        )}
        {candidates.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              disabled={busy}
              onClick={() => addProject(p)}
              className="flex w-full flex-col items-start px-2 py-1.5 text-left hover:bg-[var(--color-surface-2)] disabled:opacity-50"
            >
              <span className="font-medium text-[var(--color-text)]">{projectDisplayName(p)}</span>
              {p.path && <span className="truncate text-[10.5px] text-[var(--color-text-muted)]">{p.path}</span>}
            </button>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-1.5 border-t border-[var(--color-border)] pt-2">
        <input
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addIdea()}
          placeholder="Idea sin proyecto registrado…"
          aria-label="Idea sin proyecto registrado"
          className="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1"
        />
        <button
          type="button"
          disabled={busy || !idea.trim()}
          onClick={addIdea}
          className="rounded-md border border-[var(--color-border)] px-2 py-1 hover:bg-[var(--color-surface-2)] disabled:opacity-50"
        >
          Añadir idea
        </button>
      </div>
      <p className="text-[10.5px] text-[var(--color-text-muted)]">Las tarjetas nuevas entran en «{column.name}».</p>
      {error && (
        <p role="alert" className="text-[var(--color-error)]">
          {error}
        </p>
      )}
    </div>
  );
}
