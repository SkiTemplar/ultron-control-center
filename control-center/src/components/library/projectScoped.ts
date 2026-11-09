// Listados de Agents y Skills con las entradas de los proyectos registrados. El
// backend solo devuelve `origin: "project"` para la carpeta que se le pasa; con
// `projectPath: null` el chip «Proyecto» salía siempre vacío, y lo creado con
// ámbito de proyecto no aparecía en ninguna parte.

import { invoke } from "@tauri-apps/api/core";

type ScopedEntry = { origin: string; path: string };
type RegisteredProject = { id: string; path: string };

/** Id del proyecto sintético del home: su `.claude` es el ámbito global. */
const HOME_PROJECT_ID = "__home";

export type ProjectScopedListing<T> = {
  entries: T[];
  /** Avisos de lo que no se pudo leer; lo demás se enseña igualmente. */
  failures: string[];
};

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function listRegisteredProjects(): Promise<RegisteredProject[]> {
  const projects = await invoke<RegisteredProject[]>("list_projects");
  return projects.filter((p) => p.path.trim() !== "" && p.id !== HOME_PROJECT_ID);
}

/**
 * Lista global + plugins y añade, por cada proyecto registrado, sus entradas de
 * proyecto. Un fallo del listado global es un error; uno de un proyecto solo
 * quita ese proyecto y se avisa.
 */
export async function listWithProjectEntries<T extends ScopedEntry>(
  command: "list_agents" | "list_skills",
): Promise<ProjectScopedListing<T>> {
  const base = await invoke<T[]>(command, { projectPath: null });
  let projects: RegisteredProject[];
  try {
    projects = await listRegisteredProjects();
  } catch (e) {
    return { entries: base, failures: [`no se pudo leer la lista de proyectos: ${reason(e)}`] };
  }
  const settled = await Promise.allSettled(
    projects.map((p) => invoke<T[]>(command, { projectPath: p.path })),
  );
  const seen = new Set(base.map((entry) => entry.path));
  const entries = [...base];
  const failures: string[] = [];
  settled.forEach((outcome, i) => {
    if (outcome.status === "rejected") {
      failures.push(`${projects[i].id}: ${reason(outcome.reason)}`);
      return;
    }
    for (const entry of outcome.value) {
      if (entry.origin !== "project" || seen.has(entry.path)) continue;
      seen.add(entry.path);
      entries.push(entry);
    }
  });
  return { entries, failures };
}
