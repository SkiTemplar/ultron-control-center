// Disposición de los proyectos en «+ Claude»: los usados más recientemente
// arriba y el resto agrupado por ámbito, que sale de la primera carpeta bajo
// la carpeta personal (`~\Carrera\…` → «Carrera»). Los ámbitos con un solo
// proyecto y lo que está fuera de la carpeta personal van a «Otros». Puro.

import type { ProjectRef } from "./types";

export const RECENT_PROJECTS = 5;
export const OTHER_SCOPE = "Otros";
export const HOME_SCOPE = "Inicio";

/** Carpeta personal al principio de una ruta (Windows, macOS o Linux). */
const HOME = /^(?:[A-Za-z]:[\\/]Users[\\/][^\\/]+|\/Users\/[^/]+|\/home\/[^/]+)/i;

/** Ruta con la carpeta personal abreviada a `~`. */
export function shortPath(path: string): string {
  return path.replace(HOME, "~");
}

/** Ámbito de una ruta: primera carpeta bajo la personal, sin punto y capitalizada. */
export function scopeOf(path: string): string {
  const m = HOME.exec(path);
  if (!m) return OTHER_SCOPE;
  const first = path.slice(m[0].length).split(/[\\/]/).find(Boolean);
  if (!first) return HOME_SCOPE;
  const name = first.replace(/^\./, "").replace(/[_-]+/g, " ");
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

export interface ArrangedProjects {
  recent: ProjectRef[];
  groups: { scope: string; projects: ProjectRef[] }[];
}

const time = (p: ProjectRef) => (p.lastActive ? Date.parse(p.lastActive) || 0 : 0);
const byName = (a: ProjectRef, b: ProjectRef) => a.name.localeCompare(b.name, "es", { sensitivity: "base" });

/** Recientes (con `lastActive`, del más nuevo al más viejo) y el resto por ámbito, en orden alfabético con «Otros» al final. */
export function arrangeProjects(projects: readonly ProjectRef[], recentCount = RECENT_PROJECTS): ArrangedProjects {
  const recent = projects.filter((p) => time(p) > 0).sort((a, b) => time(b) - time(a)).slice(0, recentCount);
  const taken = new Set(recent.map((p) => p.id));
  const byScope = new Map<string, ProjectRef[]>();
  for (const p of projects) {
    if (taken.has(p.id)) continue;
    const scope = scopeOf(p.path);
    byScope.set(scope, [...(byScope.get(scope) ?? []), p]);
  }
  const others: ProjectRef[] = [];
  const groups: ArrangedProjects["groups"] = [];
  for (const [scope, list] of byScope) {
    if (scope === OTHER_SCOPE || list.length < 2) others.push(...list);
    else groups.push({ scope, projects: [...list].sort(byName) });
  }
  groups.sort((a, b) => a.scope.localeCompare(b.scope, "es"));
  if (others.length > 0) groups.push({ scope: OTHER_SCOPE, projects: others.sort(byName) });
  return { recent, groups };
}
