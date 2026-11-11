// Modelo de la sección Portfolio: el tablero macro de todos los proyectos es
// el kanban del proyecto `proyectos`, y cada tarjeta apunta a un proyecto
// registrado por `Card.project`. El alta automática de tarjetas vive en
// scripts/lib/portfolio-board.mjs (mismo id).

import type { Card, Column, KanbanBoard, ProjectInfo } from "../../types";
import type { LinkableProject } from "../projects/project-board/BoardExtensions";

export const PORTFOLIO_PROJECT_ID = "proyectos";

export function projectDisplayName(p: ProjectInfo): string {
  return p.name?.trim() || p.id;
}

/** Proyectos registrados que se pueden vincular (todos menos el propio tablero). */
export function registeredProjects(list: ProjectInfo[]): ProjectInfo[] {
  return list
    .filter((p) => p.id !== PORTFOLIO_PROJECT_ID)
    .sort((a, b) =>
      projectDisplayName(a).localeCompare(projectDisplayName(b), undefined, { sensitivity: "base" }),
    );
}

/** Proyectos que todavía no tienen tarjeta en el tablero. */
export function projectsWithoutCard(board: KanbanBoard, projects: ProjectInfo[]): ProjectInfo[] {
  const linked = new Set(board.cards.map((c) => c.project).filter(Boolean));
  return projects.filter((p) => !linked.has(p.id));
}

/** Columna donde entran las tarjetas nuevas: la de rol `todo`. */
export function intakeColumn(board: KanbanBoard): Column | null {
  return board.columns.find((c) => c.role === "todo") ?? null;
}

export function toLinkable(projects: ProjectInfo[]): LinkableProject[] {
  return projects.map((p) => ({ id: p.id, name: projectDisplayName(p) }));
}

export type CardLink =
  | { kind: "none" }
  | { kind: "linked"; project: ProjectInfo }
  | { kind: "missing"; projectId: string };

export function cardLink(card: Card, byId: Map<string, ProjectInfo>): CardLink {
  if (!card.project) return { kind: "none" };
  const project = byId.get(card.project);
  return project ? { kind: "linked", project } : { kind: "missing", projectId: card.project };
}
