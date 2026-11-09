import { describe, expect, it } from "vitest";
import { allDirPaths, buildGitTree, type GitTreeNode } from "../components/inspector/git-tree";
import type { GitFileChange } from "../types";

const ch = (path: string, untracked = false): GitFileChange => ({ path, index_status: " ", worktree_status: "M", staged: false, untracked });

function shape(nodes: GitTreeNode[]): unknown[] {
  return nodes.map((n) => (n.kind === "dir" ? { [`${n.name} (${n.count})`]: shape(n.children) } : n.name));
}

describe("buildGitTree", () => {
  it("agrupa por carpetas, compacta las cadenas de un solo hijo y cuenta los ficheros", () => {
    const tree = buildGitTree([
      ch("control-center/src/sesiones/a.ts"),
      ch("control-center/src/sesiones/b.ts"),
      ch("control-center/src-tauri/src/lib.rs"),
      ch("papercuts.md"),
    ]);
    expect(shape(tree)).toEqual([
      { "control-center (3)": [{ "src/sesiones (2)": ["a.ts", "b.ts"] }, { "src-tauri/src (1)": ["lib.rs"] }] },
      "papercuts.md",
    ]);
  });

  it("una carpeta sin seguir con barra final es una hoja, no una carpeta vacía", () => {
    const tree = buildGitTree([ch("adjuntos/", true)]);
    expect(tree).toHaveLength(1);
    expect(tree[0].kind).toBe("file");
    expect(tree[0].name).toBe("adjuntos");
  });

  it("allDirPaths devuelve las rutas completas de todas las carpetas", () => {
    const tree = buildGitTree([ch("a/b/c.ts"), ch("a/d.ts")]);
    expect(allDirPaths(tree)).toEqual(["a", "a/b"]);
  });

  it("sin cambios no hay árbol", () => {
    expect(buildGitTree([])).toEqual([]);
  });
});
