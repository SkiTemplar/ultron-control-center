// Contrato del visor CodeGraph con el backend (commands/projects/git_ops/
// codegraph/view.rs). Todo es de solo lectura sobre `.codegraph/codegraph.db`.
//
// Además de los tipos y los `invoke`, aquí viven las funciones puras del visor:
// fusionar vecindarios (clic en un nodo = expandir) y traducir el grafo a DOT
// para pintarlo con Graphviz (@viz-js/viz, ya en package.json).

import { invoke } from "@tauri-apps/api/core";

export type CodeGraphSummary = {
  files: number;
  nodes: number;
  edges: number;
  languages: [string, number][];
  last_indexed_at: number | null;
};

export type CgFile = {
  path: string;
  language: string;
  symbols: number;
  node_id: string | null;
};

export type CgModule = { path: string; files: number; symbols: number };

export type CgFileList = {
  files: CgFile[];
  modules: CgModule[];
  total_files: number;
  truncated: boolean;
};

export type CgNode = {
  id: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  language: string;
  start_line: number;
  end_line: number;
  signature: string | null;
};

export type CgEdge = {
  source: string;
  target: string;
  kind: string;
  line: number | null;
};

export type CgNeighborhood = {
  center: string;
  depth: number;
  nodes: CgNode[];
  edges: CgEdge[];
  truncated: boolean;
};

/** Grafo que enseña el visor: la unión de los vecindarios expandidos. */
export type CgView = {
  nodes: CgNode[];
  edges: CgEdge[];
  /** Algún tope (backend o visor) dejó nodos fuera. */
  truncated: boolean;
};

/** Tope de nodos del visor al ir expandiendo; el backend tiene el suyo. */
export const MAX_VIEW_NODES = 150;

export const fetchCodeGraphSummary = (path: string) =>
  invoke<CodeGraphSummary>("codegraph_summary", { path });

export const fetchCodeGraphFiles = (path: string) =>
  invoke<CgFileList>("codegraph_files", { path });

export const searchCodeGraph = (path: string, query: string, limit?: number) =>
  invoke<CgNode[]>("codegraph_search", { path, query, limit: limit ?? null });

export const fetchNeighborhood = (path: string, nodeId: string, depth: number) =>
  invoke<CgNeighborhood>("codegraph_neighborhood", {
    path,
    nodeId,
    depth,
    maxNodes: null,
  });

export const EMPTY_VIEW: CgView = { nodes: [], edges: [], truncated: false };

const edgeKey = (e: CgEdge) => `${e.source}\u0000${e.target}\u0000${e.kind}\u0000${e.line ?? ""}`;

/**
 * Une un vecindario al grafo visible sin mutar ninguno de los dos. Los nodos
 * nuevos que no caben en `maxNodes` se descartan (y se marca el recorte); una
 * arista solo entra si sus dos extremos están en el resultado.
 */
export function mergeNeighborhood(
  view: CgView,
  hood: CgNeighborhood,
  maxNodes: number = MAX_VIEW_NODES,
): CgView {
  const ids = new Set(view.nodes.map((n) => n.id));
  const added: CgNode[] = [];
  let truncated = view.truncated || hood.truncated;
  for (const node of hood.nodes) {
    if (ids.has(node.id)) continue;
    if (ids.size >= maxNodes) {
      truncated = true;
      continue;
    }
    ids.add(node.id);
    added.push(node);
  }
  const seen = new Set(view.edges.map(edgeKey));
  const edges = [...view.edges];
  for (const edge of hood.edges) {
    const key = edgeKey(edge);
    if (seen.has(key) || !ids.has(edge.source) || !ids.has(edge.target)) continue;
    seen.add(key);
    edges.push(edge);
  }
  return { nodes: [...view.nodes, ...added], edges, truncated };
}

/** Grafo nuevo a partir de un único vecindario. */
export const viewFromNeighborhood = (hood: CgNeighborhood): CgView =>
  mergeNeighborhood(EMPTY_VIEW, hood);

/** Escapa un texto para meterlo dentro de una cadena DOT entre comillas. */
const dotEscape = (text: string) =>
  text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ");

const dotString = (text: string) => `"${dotEscape(text)}"`;

/** Forma del nodo según su tipo, para distinguir ficheros, tipos y funciones. */
function shapeOf(kind: string): string {
  if (kind === "file") return "folder";
  if (["class", "struct", "interface", "trait", "enum", "type_alias", "component"].includes(kind)) {
    return "box3d";
  }
  return "box";
}

/** Atributo `id` del SVG de cada nodo: `cg-<posición>` (los ids del índice no son válidos en DOT sin escapar). */
export const svgNodeId = (index: number) => `cg-${index}`;

/**
 * Traduce el grafo a DOT. Cada nodo lleva `id="cg-<i>"` para que el visor
 * localice en el SVG qué nodo se ha pulsado (`nodeIndexFromSvgId`).
 */
export function toDot(view: CgView, selectedId: string | null): string {
  const index = new Map(view.nodes.map((n, i) => [n.id, i]));
  const lines = [
    "digraph codegraph {",
    "  rankdir=LR;",
    '  node [fontsize=10, height=0.3, margin="0.12,0.04"];',
    "  edge [fontsize=8, arrowsize=0.6];",
  ];
  view.nodes.forEach((n, i) => {
    const attrs = [
      `id=${dotString(svgNodeId(i))}`,
      // `\n` es el salto de línea de DOT: va sin escapar entre los dos textos.
      `label="${dotEscape(n.name)}\\n${dotEscape(n.kind)}"`,
      `shape=${shapeOf(n.kind)}`,
      `tooltip=${dotString(`${n.file_path}:${n.start_line}`)}`,
    ];
    if (n.id === selectedId) attrs.push("penwidth=2.5");
    lines.push(`  n${i} [${attrs.join(", ")}];`);
  });
  for (const e of view.edges) {
    const s = index.get(e.source);
    const t = index.get(e.target);
    if (s === undefined || t === undefined) continue;
    const style = e.kind === "contains" ? ", style=dashed" : "";
    lines.push(`  n${s} -> n${t} [label=${dotString(e.kind)}${style}];`);
  }
  lines.push("}");
  return lines.join("\n");
}

/** Posición del nodo a partir del `id` de su `<g>` en el SVG, o null. */
export function nodeIndexFromSvgId(id: string | null | undefined): number | null {
  const m = /^cg-(\d+)$/.exec(id ?? "");
  return m ? Number(m[1]) : null;
}

/** «ruta:línea» del detalle. */
export const locationOf = (n: CgNode) => `${n.file_path}:${n.start_line}`;
