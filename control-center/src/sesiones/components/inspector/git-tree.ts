// Árbol plegable de los ficheros cambiados del inspector Git. Las cadenas de
// carpetas con un único hijo se compactan en un nodo (`src/sesiones/x`), como
// las «compact folders» de VS Code. Puro, para poder probarlo.

import type { GitFileChange } from "../../types";

export type GitTreeNode =
  | { kind: "dir"; name: string; path: string; count: number; children: GitTreeNode[] }
  | { kind: "file"; name: string; change: GitFileChange };

interface MutableDir {
  dirs: Map<string, MutableDir>;
  files: GitFileChange[];
}

const emptyDir = (): MutableDir => ({ dirs: new Map(), files: [] });

function insert(root: MutableDir, change: GitFileChange): void {
  // git status marca las carpetas sin seguir con barra final: son una hoja.
  const parts = change.path.replace(/\/+$/, "").split("/");
  let dir = root;
  for (const part of parts.slice(0, -1)) {
    const next = dir.dirs.get(part) ?? emptyDir();
    dir.dirs.set(part, next);
    dir = next;
  }
  dir.files.push(change);
}

function countOf(nodes: GitTreeNode[]): number {
  return nodes.reduce((n, c) => n + (c.kind === "dir" ? c.count : 1), 0);
}

function toNodes(dir: MutableDir, prefix: string): GitTreeNode[] {
  const dirs = [...dir.dirs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, sub]): GitTreeNode => {
      let label = name;
      let path = prefix ? `${prefix}/${name}` : name;
      let cur = sub;
      while (cur.files.length === 0 && cur.dirs.size === 1) {
        const [childName, child] = [...cur.dirs.entries()][0];
        label = `${label}/${childName}`;
        path = `${path}/${childName}`;
        cur = child;
      }
      const children = toNodes(cur, path);
      return { kind: "dir", name: label, path, count: countOf(children), children };
    });
  const files = [...dir.files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((change): GitTreeNode => ({ kind: "file", name: change.path.replace(/\/+$/, "").split("/").pop() ?? change.path, change }));
  return [...dirs, ...files];
}

export function buildGitTree(changes: readonly GitFileChange[]): GitTreeNode[] {
  const root = emptyDir();
  for (const c of changes) insert(root, c);
  return toNodes(root, "");
}

/** Rutas de todas las carpetas del árbol (para desplegarlo entero). */
export function allDirPaths(nodes: readonly GitTreeNode[]): string[] {
  return nodes.flatMap((n) => (n.kind === "dir" ? [n.path, ...allDirPaths(n.children)] : []));
}
